'use strict';

const crypto = require('crypto');
const tools = require('./tools');
const render = require('./ui/render');
const { Spinner } = require('./ui/spinner');
const { listenInterrupt } = require('./ui/prompt');
const { systemPromptFor, COMPACT_SYSTEM, compactRequest } = require('./prompts');
const { getModel } = require('./models');
const { estimateTokens, estimateMessagesTokens } = require('./utils/tokens');
const { loadArenaMd, gitInfo } = require('./context');

const RESULT_CAP = 30000;

function genId(prefix = 'call') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function truncateForModel(text) {
  const s = String(text == null ? '' : text);
  if (s.length <= RESULT_CAP) return s;
  const head = s.slice(0, Math.floor(RESULT_CAP * 0.7));
  const tail = s.slice(-Math.floor(RESULT_CAP * 0.25));
  return `${head}\n…[${s.length - head.length - tail.length} characters truncated]…\n${tail}`;
}

class Agent {
  /**
   * @param {object} opts { client, config, permissions, store, session, ctxInfo }
   */
  constructor({ client, config, permissions, store, session, ctxInfo, input }) {
    this.client = client;
    this.config = config;
    this.permissions = permissions;
    this.store = store;
    this.session = session;
    this.ctxInfo = ctxInfo;
    this.input = input || null;
    this.modelInfo = getModel(config.model);
    this.ac = null;
    this.interruptRequested = false;
    this.lastTurnUsage = 0;
    this.abortedMidStream = false;
  }

  /* ------------------------------------------------------------ */

  systemPrompt() {
    // Re-read memory/git cheaply each turn so #notes and commits stay fresh.
    const arenaMd = loadArenaMd(this.session.cwd);
    const git = gitInfo(this.session.cwd) || (this.ctxInfo && this.ctxInfo.git);
    return systemPromptFor({
      root: this.session.cwd,
      mode: this.permissions.mode,
      model: this.config.model,
      repoMap: this.ctxInfo ? this.ctxInfo.repoMap : '',
      git,
      arenaMd: arenaMd ? arenaMd.text : '',
      languages: this.ctxInfo ? this.ctxInfo.languages : '',
      fileCount: this.ctxInfo ? this.ctxInfo.fileCount : 0,
    });
  }

  interrupt() {
    this.interruptRequested = true;
    if (this.ac) this.ac.abort();
  }

  /** Entry: run a full turn for a user message. */
  async runTurn(userText) {
    this.interruptRequested = false;
    this.abortedMidStream = false;
    this.lastTurnUsage = 0;
    this.session.messages.push({ role: 'user', content: userText });
    try {
      await this.loop();
    } finally {
      this.store.save(this.session);
    }
  }

  /* ------------------------------------------------------------ */

  async loop() {
    let rounds = 0;
    for (;;) {
      if (this.interruptRequested) break;

      await this.maybeCompact(false);

      this.ac = new AbortController();
      const onInterrupt = (isCtrlC) => {
        this.interruptRequested = true;
        this.abortedMidStream = true;
        if (this.ac) this.ac.abort();
        if (isCtrlC) process.stderr.write('\n');
      };
      const stopKeys = this.input ? this.input.listenInterrupt(onInterrupt) : listenInterrupt(onInterrupt);

      let turn;
      try {
        turn = await this.streamOnce();
      } catch (err) {
        stopKeys();
        if (this.interruptRequested) {
          this.recordInterruption(turn);
          break;
        }
        throw err;
      }
      stopKeys();

      this.session.messages.push(turn.message);
      this.addUsage(turn.usage);
      this.store.save(this.session);

      if (this.interruptRequested) {
        this.recordInterruption(turn);
        break;
      }

      const calls = turn.message.tool_calls || [];
      if (calls.length === 0) return; // final answer delivered

      for (const tc of calls) {
        if (this.interruptRequested) break;
        await this.executeToolCall(tc);
      }
      this.store.save(this.session);

      if (this.interruptRequested) {
        this.recordInterruption(null);
        break;
      }

      rounds++;
      if (rounds >= this.config.maxTurns) {
        render.warn(`Reached the ${this.config.maxTurns}-step tool limit. Ask again to continue.`);
        this.session.messages.push({
          role: 'user',
          content: '[System] Tool-step limit reached. Summarize progress and what remains to do.',
        });
        return;
      }
    }
  }

  recordInterruption(partialTurn) {
    if (partialTurn && partialTurn.message && !this.session.messages.includes(partialTurn.message)) {
      this.session.messages.push(partialTurn.message);
    }
    // Strip dangling tool_calls that will never get results (keeps the API happy).
    const last = this.session.messages[this.session.messages.length - 1];
    if (last && last.role === 'assistant' && last.tool_calls) {
      for (const tc of last.tool_calls) {
        this.session.messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function?.name || 'unknown',
          content: 'The user interrupted before this tool ran. It was NOT executed.',
        });
      }
    }
    this.session.messages.push({ role: 'user', content: '[Request interrupted by user]' });
    render.printInterrupted();
  }

  /* ------------------------------------------------------------ */

  async streamOnce() {
    const messages = [{ role: 'system', content: this.systemPrompt() }, ...this.session.messages];
    const toolDefs = tools.definitions(this.permissions.mode);

    let text = '';
    let started = false;
    const acc = new Map();
    let usage = null;

    const spinner = new Spinner('Arena is thinking…').start();
    let firstToken = true;

    try {
      for await (const chunk of this.client.stream({
        messages,
        tools: toolDefs,
        temperature: this.config.temperature,
        maxTokens: this.modelInfo.maxOutputTokens,
        signal: this.ac.signal,
      })) {
        if (chunk.usage) usage = chunk.usage;
        const ch = chunk.choices && chunk.choices[0];
        if (!ch) continue;
        const d = ch.delta || {};
        if (typeof d.content === 'string' && d.content.length) {
          if (firstToken) {
            spinner.stop();
            firstToken = false;
            started = true;
            render.assistantStart();
          }
          text += d.content;
          render.assistantDelta(d.content);
        }
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const i = Number.isInteger(tc.index) ? tc.index : 0;
            const a = acc.get(i) || { id: '', name: '', args: '' };
            if (tc.id) a.id = tc.id;
            if (tc.function && tc.function.name) a.name += tc.function.name;
            if (tc.function && tc.function.arguments) a.args += tc.function.arguments;
            acc.set(i, a);
          }
          if (firstToken) {
            spinner.update('planning tool calls…');
          }
        }
      }
    } finally {
      spinner.stop();
      if (started) render.assistantEnd();
    }

    const toolCalls = [...acc.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([, v]) => ({
        id: v.id || genId(),
        type: 'function',
        function: { name: v.name, arguments: v.args || '{}' },
      }));

    const message = { role: 'assistant', content: text || null };
    if (toolCalls.length) message.tool_calls = toolCalls;
    return { message, usage };
  }

  /* ------------------------------------------------------------ */

  async executeToolCall(tc) {
    const name = tc.function && tc.function.name;
    const rawArgs = (tc.function && tc.function.arguments) || '{}';
    const tool = tools.get(name);

    let args = null;
    try {
      args = JSON.parse(rawArgs);
    } catch {
      /* handled below */
    }

    render.toolStart(name || 'unknown_tool', tool && args ? tool.shortDesc(args) : '');

    if (!tool) {
      const msg = `Unknown tool "${name}". Available tools: ${tools.definitions(this.permissions.mode).map((d) => d.function.name).join(', ')}.`;
      render.toolFailed(msg);
      this.session.messages.push({ role: 'tool', tool_call_id: tc.id, name: name || 'unknown', content: msg });
      return;
    }
    if (!args || typeof args !== 'object') {
      const msg = `Tool arguments were not valid JSON: ${String(rawArgs).slice(0, 200)}. Retry with valid JSON arguments.`;
      render.toolFailed(msg);
      this.session.messages.push({ role: 'tool', tool_call_id: tc.id, name, content: msg });
      return;
    }

    const auth = await this.permissions.authorize(name, args);
    if (this.interruptRequested) {
      render.toolDenied('interrupted');
      this.session.messages.push({ role: 'tool', tool_call_id: tc.id, name, content: 'Interrupted before execution.' });
      return;
    }
    if (!auth.ok) {
      render.toolDenied(auth.reason);
      this.session.messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name,
        content: `Permission denied by the user. ${auth.reason || ''} Adapt your approach or ask the user how to proceed.`,
      });
      return;
    }

    const spinner = new Spinner(`running ${name}…`).start();
    let out;
    let failed = false;
    try {
      out = await tool.execute(args, { root: this.session.cwd, session: this.session, verbose: this.config.verbose });
    } catch (err) {
      failed = true;
      out = { result: `Error: ${err.message}`, summary: `Failed — ${err.message}` };
    }
    spinner.stop();

    if (failed) render.toolFailed(out.summary.replace(/^Failed — /, ''));
    else render.toolResultBlock(out, { verbose: this.config.verbose });

    if (name === 'update_plan' && this.session.plan) render.printPlan(this.session.plan);

    this.session.messages.push({
      role: 'tool',
      tool_call_id: tc.id,
      name,
      content: truncateForModel(out.result),
    });
  }

  /* ------------------------------------------------------------ */

  addUsage(usage) {
    const u = this.session.usage || (this.session.usage = { promptTokens: 0, completionTokens: 0, turns: 0 });
    u.turns += 1;
    if (usage) {
      u.promptTokens += usage.prompt_tokens || 0;
      u.completionTokens += usage.completion_tokens || 0;
      this.lastTurnUsage = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
    } else {
      const est = estimateMessagesTokens(this.session.messages.slice(-4));
      u.promptTokens += est;
      this.lastTurnUsage = est;
    }
  }

  contextTokens() {
    return estimateTokens(this.systemPrompt()) + estimateMessagesTokens(this.session.messages);
  }

  /**
   * Compress history when it nears the model's context window.
   * @param {boolean} force true when invoked via /compact
   */
  async maybeCompact(force) {
    const windowSize = this.modelInfo.contextWindow;
    const used = this.contextTokens();
    const threshold = Math.floor(windowSize * 0.82);
    if (!force && used < threshold) return false;
    if (this.session.messages.length < 4) return false;

    const spinner = new Spinner(force ? 'Compacting conversation…' : `Context at ~${Math.round(used / 1000)}k tokens — compacting…`).start();
    try {
      const transcript = this.session.messages
        .map((m) => {
          const who = m.role.toUpperCase();
          if (m.role === 'assistant' && m.tool_calls) {
            const calls = m.tool_calls.map((t) => `${t.function.name}(${String(t.function.arguments).slice(0, 300)})`).join('; ');
            return `${who}: ${m.content || ''}\n  tool calls: ${calls}`;
          }
          return `${who}: ${typeof m.content === 'string' ? m.content.slice(0, 4000) : JSON.stringify(m.content).slice(0, 4000)}`;
        })
        .join('\n\n');

      const res = await this.client.chat({
        messages: [
          { role: 'system', content: COMPACT_SYSTEM },
          { role: 'user', content: compactRequest(transcript.slice(0, 120000)) },
        ],
        temperature: 0.1,
        maxTokens: 4096,
      });
      const summary = res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
      if (!summary) throw new Error('empty summary');
      this.session.messages = [
        { role: 'user', content: `[Context summary of the earlier conversation]\n${summary}` },
        { role: 'assistant', content: 'Understood — I have the context summary above and will continue from there.' },
      ];
      spinner.stop('✓ conversation compacted');
      return true;
    } catch (err) {
      spinner.stop();
      if (force) render.warn(`Compaction failed: ${err.message}`);
      return false;
    }
  }
}

module.exports = { Agent };
