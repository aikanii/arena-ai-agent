'use strict';

const { style, termWidth, wordWrap, truncateLine, visibleLength } = require('./ansi');
const { collapseDiff, diffStats } = require('../utils/diff');

function print(s = '') {
  process.stdout.write(s + '\n');
}

/* ------------------------------------------------------------------ */
/* Banner                                                              */
/* ------------------------------------------------------------------ */

function banner({ version, model, mode, cwd, git, isVSCode }) {
  const w = Math.min(termWidth(), 74);
  const line1 = `${style.bold(style.purple('◆ Arena Agent'))} ${style.dim('v' + version)}  ·  ${style.dim('powered by Arena Agent API')}`;
  const rows = [
    line1,
    `${style.gray('model')} ${style.cyan(model)}   ${style.gray('mode')} ${modeColor(mode)}   ${style.gray('cwd')} ${truncateLine(cwd, Math.max(10, w - 40))}`,
  ];
  if (git) rows.push(`${style.gray('git')}   ${style.green(git.branch)}${git.dirty ? style.yellow(' ●') : ''}${git.lastCommit ? style.gray('  ' + truncateLine(git.lastCommit, 44)) : ''}`);
  rows.push(style.gray('type /help for commands · esc interrupts · !cmd runs a shell command'));

  const top = style.dim('┌' + '─'.repeat(w - 2) + '┐');
  const bottom = style.dim('└' + '─'.repeat(w - 2) + '┘');
  print(top);
  for (const r of rows) {
    const padLen = Math.max(0, w - 4 - visibleLength(r));
    print(style.dim('│') + ' ' + r + ' '.repeat(padLen) + ' ' + style.dim('│'));
  }
  print(bottom);
  if (isVSCode) {
    print(style.gray('  ⌁ VS Code integrated terminal detected — add Arena as a task: docs/vscode.md'));
  }
  print('');
}

function modeColor(mode) {
  switch (mode) {
    case 'plan':
      return style.blue('plan');
    case 'acceptEdits':
      return style.green('accept-edits');
    case 'fullAuto':
      return style.red('full-auto');
    default:
      return style.yellow('default');
  }
}

/* ------------------------------------------------------------------ */
/* Assistant streaming text                                            */
/* ------------------------------------------------------------------ */

let assistantActive = false;

function assistantStart() {
  if (assistantActive) return;
  assistantActive = true;
}

function assistantDelta(text) {
  process.stdout.write(text);
}

function assistantEnd() {
  if (!assistantActive) return;
  assistantActive = false;
  process.stdout.write('\n');
}

/* ------------------------------------------------------------------ */
/* Tool events                                                         */
/* ------------------------------------------------------------------ */

function toolStart(toolName, desc) {
  const head = `${style.magenta('●')} ${style.bold(toolName)}`;
  print(desc ? `${head}${style.gray('(')}${style.cyan(truncateLine(desc, Math.min(90, termWidth() - 14)))}${style.gray(')')}` : head);
}

function toolResultBlock(out, { verbose = false } = {}) {
  const lines = [];
  if (out.summary) lines.push(style.green('⎿') + '  ' + out.summary);
  const details = out.details;
  if (details && verbose) {
    if (details.type === 'text' && details.text) {
      const max = 40;
      const dl = String(details.text).split('\n');
      for (let i = 0; i < Math.min(dl.length, max); i++) lines.push('   ' + style.gray(dl[i]));
      if (dl.length > max) lines.push(style.gray(`   … ${dl.length - max} more lines (use --verbose to see all)`));
    } else if (details.type === 'diff') {
      lines.push(...renderDiffEntries(details.entries, 3));
    }
  } else if (details && details.type === 'diff') {
    // Always show diffs for edits/writes — they are the important part.
    lines.push(...renderDiffEntries(details.entries, 3));
  } else if (details && details.type === 'text' && details.text && out.summary !== details.text) {
    const dl = String(details.text).split('\n');
    const max = 8;
    for (let i = 0; i < Math.min(dl.length, max); i++) lines.push('   ' + style.gray(dl[i]));
    if (dl.length > max) lines.push(style.gray(`   … ${dl.length - max} more lines`));
  }
  if (lines.length === 0) lines.push(style.green('⎿') + '  ' + style.gray('done'));
  for (const l of lines) print(l);
  print('');
}

function toolDenied(reason) {
  print(style.yellow('  ⎿  permission denied') + (reason ? style.gray(' — ' + reason) : ''));
  print('');
}

function toolFailed(message) {
  print(style.red('  ⎿  error: ') + truncateLine(message, termWidth() - 12));
  print('');
}

/* ------------------------------------------------------------------ */
/* Diffs                                                               */
/* ------------------------------------------------------------------ */

function renderDiffEntries(entries, indent = 0) {
  const pad = ' '.repeat(indent);
  const collapsed = collapseDiff(entries, { maxLines: 60 });
  const out = [];
  for (const e of collapsed) {
    if (e.t === '…') {
      out.push(pad + style.gray('   ⋮  ' + e.s));
    } else if (e.t === '+') {
      out.push(pad + style.green('   + ' + e.s));
    } else if (e.t === '-') {
      out.push(pad + style.red('   - ' + e.s));
    } else {
      out.push(pad + style.gray('     ' + truncateLine(e.s, termWidth() - 8)));
    }
  }
  const { added, removed } = diffStats(entries);
  out.push(pad + style.gray(`   ${style.green('+' + added)} ${style.red('-' + removed)}`));
  return out;
}

function printDiff(entries, label) {
  if (label) print(style.bold(label));
  for (const l of renderDiffEntries(entries)) print(l);
  print('');
}

/* ------------------------------------------------------------------ */
/* Plan / todos                                                        */
/* ------------------------------------------------------------------ */

function printPlan(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return;
  print(style.bold(style.blue('  Plan')));
  for (const t of todos) {
    const status = t.status || 'pending';
    let mark;
    if (status === 'done') mark = style.green('☑');
    else if (status === 'in_progress') mark = style.cyan('◐');
    else mark = style.gray('☐');
    const text = status === 'done' ? style.gray(t.content) : t.content;
    print(`  ${mark} ${text}`);
  }
  print('');
}

/* ------------------------------------------------------------------ */
/* Messages, boxes, misc                                               */
/* ------------------------------------------------------------------ */

function info(msg) {
  print(style.gray(msg));
}

function warn(msg) {
  print(style.yellow('⚠ ' + msg));
}

function error(msg) {
  print(style.red('✖ ' + msg));
}

function box(title, lines, colorFn = style.yellow) {
  const w = Math.min(termWidth() - 2, Math.max(title.length + 6, ...lines.map((l) => visibleLength(l) + 4), 40));
  print(colorFn('╭─ ' + title + ' ' + '─'.repeat(Math.max(0, w - title.length - 4)) + '╮'));
  for (const l of lines) {
    const wrapped = wordWrap(l, w - 4);
    for (const wl of wrapped) {
      print(colorFn('│') + ' ' + wl + ' '.repeat(Math.max(0, w - 3 - visibleLength(wl))) + colorFn('│'));
    }
  }
  print(colorFn('╰' + '─'.repeat(w - 2) + '╯'));
}

function printInterrupted() {
  print(style.yellow('— interrupted —'));
  print('');
}

function turnStats({ tokens, ms }) {
  const parts = [];
  if (tokens) parts.push(`~${Math.round(tokens / 1000)}k tokens`);
  if (ms) parts.push(`${(ms / 1000).toFixed(1)}s`);
  if (parts.length) print(style.gray('  ' + parts.join(' · ')));
}

function missingKey() {
  box('No API key configured', [
    'Arena Agent gets its intelligence from the Arena Agent API.',
    '',
    'Set your key, then run again:',
    '  export ARENA_API_KEY="your-key"',
    '',
    'Or point the CLI at any OpenAI-compatible endpoint:',
    '  export ARENA_BASE_URL="https://api.example.com/v1"',
    '',
    'Try it offline with the bundled mock model:',
    '  arena --mock',
    '',
    'Run `arena doctor` to check your configuration.',
  ], style.red);
}

module.exports = {
  print,
  banner,
  assistantStart,
  assistantDelta,
  assistantEnd,
  toolStart,
  toolResultBlock,
  toolDenied,
  toolFailed,
  printDiff,
  printPlan,
  info,
  warn,
  error,
  box,
  printInterrupted,
  turnStats,
  missingKey,
};
