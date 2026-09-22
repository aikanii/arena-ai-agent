'use strict';

const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const render = require('./ui/render');
const { style } = require('./ui/ansi');
const { TerminalInput } = require('./ui/prompt');
const { resolveConfig } = require('./config');
const { LLMClient } = require('./llm');
const { getModel, MODELS } = require('./models');
const { Permissions, MODES } = require('./permissions');
const { SessionStore } = require('./session');
const { gatherContext, projectFacts } = require('./context');
const { Agent } = require('./agent');
const tools = require('./tools');

const HELP = `${style.bold('arena')} — Arena Agent for your terminal

${style.bold('USAGE')}
  arena                     Start an interactive session in the current directory
  arena "task description"  Start interactively with an initial task
  arena -p "task"           One-shot mode: run the task, print the result, exit
  arena <command>           Run a subcommand (init, doctor, sessions)

${style.bold('OPTIONS')}
  -p, --print               Non-interactive mode (for scripts and pipes)
  -c, --continue            Continue the most recent session in this project
  -r, --resume <id>         Resume a specific session (see \`arena sessions\`)
      --plan                Plan mode: read-only investigation + planning
      --auto-edit           Auto-approve file edits; still ask for commands
      --full-auto           Auto-approve everything (same as --dangerously-skip-permissions)
      --mode <mode>         Permission mode: plan | default | acceptEdits | fullAuto
      --model <name>        Model to use (default: arena-agent)
      --base-url <url>      API base URL (default: https://api.arena.ai/v1)
      --api-key <key>       API key (normally set via ARENA_API_KEY)
      --mock                Use the bundled offline mock model (no network)
      --max-turns <n>       Tool-step limit per user turn (default 40)
      --verbose             Show full tool results and raw output
  -v, --version             Print version
  -h, --help                Show this help

${style.bold('ENVIRONMENT')}
  ARENA_API_KEY, ARENA_BASE_URL, ARENA_MODEL, ARENA_PERMISSION_MODE,
  ARENA_MAX_TURNS, ARENA_SHELL

${style.bold('EXAMPLES')}
  arena "add authentication to this application"
  arena -p "fix the failing tests" --auto-edit
  arena --plan "how would you migrate this app to TypeScript?"
  git diff | arena -p "review this diff"

Run \`arena doctor\` to check your setup.`;

/* ------------------------------------------------------------------ */
/* Arg parsing (dependency-free)                                       */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const flags = { positional: [] };
  const takeValue = (name, i, dflt) => {
    const a = argv[i];
    if (a.includes('=')) return [a.slice(a.indexOf('=') + 1), i];
    if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) return [argv[i + 1], i + 1];
    return [dflt, i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-p': case '--print': flags.print = true; break;
      case '-c': case '--continue': flags.continueLast = true; break;
      case '-r': case '--resume': [flags.resume, i] = takeValue(a, i, 'latest'); break;
      case '--plan': flags.plan = true; break;
      case '--auto-edit': flags.autoEdit = true; break;
      case '--full-auto': case '--dangerously-skip-permissions': case '--yolo': flags.fullAuto = true; break;
      case '--mode': [flags.mode, i] = takeValue(a, i, 'default'); break;
      case '--model': [flags.model, i] = takeValue(a, i, ''); break;
      case '--base-url': [flags.baseUrl, i] = takeValue(a, i, ''); break;
      case '--api-key': [flags.apiKey, i] = takeValue(a, i, ''); break;
      case '--mock': flags.mock = true; break;
      case '--max-turns': [flags.maxTurns, i] = takeValue(a, i, '40'); break;
      case '--temperature': [flags.temperature, i] = takeValue(a, i, '0.2'); break;
      case '--verbose': flags.verbose = true; break;
      case '-v': case '--version': flags.version = true; break;
      case '-h': case '--help': flags.help = true; break;
      case '--': flags.positional.push(...argv.slice(i + 1)); i = argv.length; break;
      default:
        if (a.startsWith('--') && a.includes('=')) {
          const key = a.slice(2, a.indexOf('='));
          flags[camel(key)] = a.slice(a.indexOf('=') + 1);
        } else if (a.startsWith('-') && a.length > 1) {
          render.warn(`Unknown option: ${a}`);
        } else {
          flags.positional.push(a);
        }
    }
  }
  return flags;
}

function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main(argv = []) {
  const flags = parseArgs(argv);

  if (flags.version) {
    console.log(`arena v${pkg.version} (node ${process.version})`);
    return;
  }
  if (flags.help) {
    console.log(HELP);
    return;
  }

  const command = flags.positional[0];
  if (command === 'init') return cmdInit(flags);
  if (command === 'doctor') return cmdDoctor(flags);
  if (command === 'sessions') return cmdSessions();

  const root = process.cwd();
  let config = resolveConfig(flags, root);

  // Offline demo mode: spin up the bundled mock Arena API.
  let mockServer = null;
  if (config.mock) {
    const { startMockServer } = require('../mock/server');
    mockServer = await startMockServer(0);
    config = { ...config, baseUrl: `http://127.0.0.1:${mockServer.port}/v1`, apiKey: 'mock-key' };
    render.info(`[mock] offline mock model listening on 127.0.0.1:${mockServer.port}`);
  }

  if (!config.apiKey) {
    render.missingKey();
    if (mockServer) await mockServer.close();
    process.exitCode = 2;
    return;
  }

  const isTTY = !!process.stdin.isTTY && !!process.stdout.isTTY;
  const client = new LLMClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model });
  const terminal = new TerminalInput();
  const permissions = new Permissions({ mode: config.mode, interactive: isTTY && !flags.print, terminal });
  const store = new SessionStore(root);
  const ctxInfo = gatherContext(root);

  let session = null;
  if (flags.resume) {
    session = flags.resume === 'latest' ? store.latest() : store.load(flags.resume);
    if (session) render.info(`resumed session ${session.id} (${session.messages.length} messages)`);
    else render.warn(`session not found: ${flags.resume}`);
  } else if (flags.continueLast) {
    session = store.latest();
    if (session) render.info(`continuing session ${session.id}`);
  }
  if (!session) session = store.newSession({ model: config.model, mode: config.mode });
  session.model = config.model;
  session.mode = config.mode;

  const agent = new Agent({ client, config, permissions, store, session, ctxInfo, input: terminal });

  const promptText = flags.positional.join(' ').trim();
  const interactive = !flags.print && isTTY;

  // Ctrl-C handling outside of agent turns.
  let running = false;
  process.on('SIGINT', () => {
    if (running) agent.interrupt();
    else {
      console.log('');
      process.exit(130);
    }
  });

  const cleanup = async () => {
    terminal.close();
    store.save(session);
    if (mockServer) await mockServer.close();
  };

  if (!interactive) {
    /* ---------------- one-shot / piped mode ---------------- */
    if (!promptText) {
      if (flags.print) {
        render.error('Nothing to do: pass a task, e.g. arena -p "fix the tests"');
        process.exitCode = 1;
      } else {
        console.log(HELP);
      }
      await cleanup();
      return;
    }
    running = true;
    try {
      await agent.runTurn(promptText);
    } catch (err) {
      render.error(err.friendly ? err.message : err.stack || String(err));
      process.exitCode = 1;
    }
    running = false;
    await cleanup();
    return;
  }

  /* ---------------------- interactive REPL ---------------------- */
  render.banner({
    version: pkg.version,
    model: config.model,
    mode: permissions.mode,
    cwd: root,
    git: ctxInfo.git,
    isVSCode: process.env.TERM_PROGRAM === 'vscode',
  });

  let initial = promptText || null;
  for (;;) {
    let input;
    if (initial) {
      input = initial;
      initial = null;
      render.print(style.gray('❯ ') + input.split('\n')[0].slice(0, 200));
    } else {
      const entry = await terminal.readLine('❯ ');
      if (entry === terminal.SIGINT) {
        render.info('bye');
        break;
      }
      if (entry === terminal.EOF) {
        render.info('bye');
        break;
      }
      input = entry;
    }
    const text = input.trim();
    if (!text) continue;

    if (text === '/exit' || text === '/quit') break;
    if (text.startsWith('/')) {
      const shouldExit = await handleSlash(text, { agent, session, store, permissions, config, ctxInfo });
      if (shouldExit) break;
      continue;
    }
    if (text.startsWith('!')) {
      await runLocalCommand(text.slice(1), agent);
      continue;
    }
    if (text.startsWith('#')) {
      appendMemory(root, text.slice(1).trim());
      continue;
    }

    const t0 = Date.now();
    running = true;
    try {
      await agent.runTurn(text);
      render.turnStats({ tokens: agent.lastTurnUsage, ms: Date.now() - t0 });
    } catch (err) {
      render.error(err.friendly ? err.message : err.stack || String(err));
    }
    running = false;
    store.save(session);
  }

  await cleanup();
}

/* ------------------------------------------------------------------ */
/* Local shell shortcut (!cmd)                                         */
/* ------------------------------------------------------------------ */

async function runLocalCommand(command, agent) {
  const cmd = command.trim();
  if (!cmd) return;
  const bash = tools.get('run_command');
  const auth = await agent.permissions.authorize('run_command', { command: cmd });
  if (!auth.ok) {
    render.toolDenied(auth.reason);
    return;
  }
  const out = await bash.execute({ command: cmd }, { root: agent.session.cwd, session: agent.session });
  render.print(out.result);
  agent.session.messages.push({
    role: 'user',
    content: `[The user ran a local shell command]\n$ ${cmd}\n${out.result.slice(0, 6000)}`,
  });
}

function appendMemory(root, note) {
  if (!note) {
    render.warn('usage: # <memory note to add to ARENA.md>');
    return;
  }
  const p = path.join(root, 'ARENA.md');
  const header = fs.existsSync(p) ? '' : '# ARENA.md — project memory for Arena Agent\n\n';
  fs.writeFileSync(p, header + `- ${note}\n`, { flag: fs.existsSync(p) ? 'a' : 'w' });
  render.info(`✓ added to ${p}`);
}

/* ------------------------------------------------------------------ */
/* Slash commands                                                      */
/* ------------------------------------------------------------------ */

async function handleSlash(text, env) {
  const { agent, session, store, permissions, config, ctxInfo } = env;
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const arg = rest.join(' ');

  switch (cmd) {
    case '/help':
      render.print(`${style.bold('Commands')}
  /help               this help
  /clear              clear the conversation (start fresh context)
  /compact            compress conversation history now
  /status             session, model, mode, usage
  /model [name]       show or switch model (${Object.keys(MODELS).join(', ')})
  /mode [name]        show or switch permission mode (${MODES.join(', ')})
  /plan               toggle plan mode on/off
  /diff               show uncommitted git diff
  /permissions        show active allow rules
  /init               create ARENA.md project memory
  !command            run a shell command directly
  #note               save a note to ARENA.md
  /exit               quit`);
      break;

    case '/clear':
      session.messages = [];
      session.plan = null;
      store.save(session);
      render.info('conversation cleared');
      break;

    case '/compact':
      await agent.maybeCompact(true);
      break;

    case '/status': {
      const u = session.usage || {};
      render.print(`${style.bold('session')} ${session.id}
${style.bold('model')}   ${config.model} (${getModel(config.model).label})
${style.bold('mode')}    ${permissions.mode}
${style.bold('cwd')}     ${session.cwd}
${style.bold('msgs')}    ${session.messages.length}   ${style.bold('turns')} ${u.turns || 0}
${style.bold('tokens')}  ~${Math.round(agent.contextTokens() / 1000)}k context (window ${Math.round(getModel(config.model).contextWindow / 1000)}k)`);
      break;
    }

    case '/model':
      if (arg) {
        config.model = arg;
        session.model = arg;
        agent.config.model = arg;
        agent.modelInfo = getModel(arg);
        render.info(`model → ${arg}`);
      } else {
        render.info(`current model: ${config.model}. Options: ${Object.keys(MODELS).join(', ')} (or any custom name)`);
      }
      break;

    case '/mode': {
      const target = arg || (permissions.mode === 'plan' ? 'default' : 'plan');
      permissions.mode = MODES.includes(target) ? target : permissions.mode;
      session.mode = permissions.mode;
      render.info(`permission mode → ${permissions.mode}`);
      break;
    }

    case '/plan':
      permissions.mode = permissions.mode === 'plan' ? 'default' : 'plan';
      session.mode = permissions.mode;
      render.info(`plan mode ${permissions.mode === 'plan' ? 'ON — read-only investigation' : 'OFF'}`);
      break;

    case '/diff': {
      const git = tools.get('git');
      try {
        const out = await git.execute({ operation: 'diff' }, { root: session.cwd, session });
        render.print(out.result);
      } catch (err) {
        render.error(err.message);
      }
      break;
    }

    case '/permissions':
      render.print(`${style.bold('mode')}: ${permissions.mode}`);
      if (permissions.rules.length === 0) render.info('no session allow-rules yet (approve with "a" at a prompt)');
      for (const r of permissions.rules) render.print(`  allow ${r.tool}: ${style.cyan(r.label)}`);
      break;

    case '/init':
      cmdInit({}, true);
      break;

    case '/sessions':
      cmdSessions();
      break;

    case '/exit':
    case '/quit':
      return true;

    default:
      render.warn(`unknown command: ${cmd} — try /help`);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Subcommands                                                         */
/* ------------------------------------------------------------------ */

function cmdInit(flags, forceInline = false) {
  const root = process.cwd();
  const p = path.join(root, 'ARENA.md');
  if (fs.existsSync(p) && !flags.force && !forceInline) {
    render.warn('ARENA.md already exists — edit it directly (or delete it first).');
    return;
  }
  const facts = projectFacts(root);
  const lines = [
    '# ARENA.md — project memory for Arena Agent',
    '',
    'This file is injected into Arena Agent\'s context at the start of every session.',
    'Keep it short and factual. Add conventions with `# <note>` in the REPL.',
    '',
    `## Project: ${facts.name}`,
    '',
    `- Workspace: ${root}`,
    facts.hasGit ? '- Git repository: yes' : '- Git repository: no',
    facts.readme ? '- README: present' : '- README: missing',
    '',
  ];
  if (facts.scripts) {
    lines.push('## Commands (from package.json)', '');
    for (const [k, v] of Object.entries(facts.scripts).slice(0, 12)) lines.push(`- \`${k}\`: ${v}`);
    lines.push('');
  }
  lines.push(
    '## Conventions',
    '',
    '- (describe code style, architecture decisions, test commands, things to avoid…)',
    ''
  );
  fs.writeFileSync(p, lines.join('\n'));
  render.info(`✓ created ${p} — edit it to teach Arena Agent about this project.`);
}

function cmdSessions() {
  const store = new SessionStore(process.cwd());
  const list = store.list();
  if (!list.length) {
    render.info('no sessions for this project yet');
    return;
  }
  render.print(style.bold('Sessions for this project (newest first):'));
  for (const s of list.slice(0, 20)) {
    render.print(`  ${style.cyan(s.id)}  ${style.gray(s.updatedAt)}  ${s.messageCount} msgs  ${style.gray(s.firstUser)}`);
  }
  render.info('resume with: arena --resume <id>   (or arena --continue for the newest)');
}

async function cmdDoctor(flags) {
  const root = process.cwd();
  const config = resolveConfig(flags, root);
  const checks = [];
  const ok = (label, val) => checks.push([true, label, val]);
  const bad = (label, val) => checks.push([false, label, val]);

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) ok('node version', process.version);
  else bad('node version', `${process.version} (need ≥ 18)`);

  ok('workspace', root);
  try {
    fs.accessSync(root, fs.constants.W_OK);
    ok('workspace writable', 'yes');
  } catch {
    bad('workspace writable', 'no');
  }

  ok('api base url', config.baseUrl);
  ok('model', config.model);
  if (config.apiKey) ok('api key', `${config.apiKey.slice(0, 6)}… (${config.apiKey.length} chars)`);
  else bad('api key', 'not set — export ARENA_API_KEY or pass --api-key (or use --mock)');

  const git = require('./context').gitInfo(root);
  if (git) ok('git', `branch ${git.branch}${git.dirty ? ', dirty' : ''}`);
  else bad('git', 'not a repository (fine, but no git features)');

  render.print(style.bold('arena doctor'));
  for (const [pass, label, val] of checks) {
    render.print(`  ${pass ? style.green('✓') : style.red('✗')} ${style.bold(label)}: ${val}`);
  }

  if (config.apiKey) {
    const client = new LLMClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model });
    try {
      const models = await client.listModels();
      const ids = (models.data || []).map((m) => m.id).slice(0, 8).join(', ') || '(no list)';
      render.print(`  ${style.green('✓')} api reachable: ${ids}`);
    } catch (err) {
      render.print(`  ${style.red('✗')} api check failed: ${err.message}`);
    }
  }
}

module.exports = { main };
