'use strict';

const tools = require('./tools');
const { askQuestion } = require('./ui/prompt');
const { style } = require('./ui/ansi');

const MODES = ['plan', 'default', 'acceptEdits', 'fullAuto'];

function normalizeMode(mode) {
  const m = String(mode || 'default');
  if (MODES.includes(m)) return m;
  const aliases = {
    plan: 'plan',
    default: 'default',
    acceptedits: 'acceptEdits',
    'accept-edits': 'acceptEdits',
    fullauto: 'fullAuto',
    'full-auto': 'fullAuto',
    yolo: 'fullAuto',
    dangerous: 'fullAuto',
  };
  return aliases[m.toLowerCase()] || 'default';
}

/** Convert a command into its allow-rule pattern (first token + wildcard). */
function commandRulePattern(command) {
  const first = String(command).trim().split(/\s+/)[0] || '*';
  return `${first} *`;
}

function ruleMatches(rule, name, args) {
  if (rule.tool !== name) return false;
  if (name === 'run_command') {
    const cmd = String(args.command || '').trim();
    const prefix = rule.pattern.replace(/\s*\*$/, '');
    return cmd === prefix || cmd.startsWith(prefix + ' ');
  }
  return true;
}

class Permissions {
  constructor({ mode = 'default', interactive = true, terminal = null } = {}) {
    this.mode = normalizeMode(mode);
    this.interactive = interactive;
    this.terminal = terminal;
    this.rules = []; // session allow-list: [{ tool, pattern, label }]
  }

  describe(name, args) {
    const t = tools.get(name);
    if (!t) return name;
    switch (name) {
      case 'run_command':
        return `$ ${String(args.command || '').split('\n')[0]}`;
      case 'write_file':
        return `create/overwrite file: ${args.path}`;
      case 'edit_file':
        return `edit file: ${args.path}`;
      case 'delete_file':
        return `delete ${args.recursive ? 'directory' : 'file'}: ${args.path}`;
      case 'git':
        return `git ${args.operation}${args.operation === 'commit' ? ` -m "${args.message}"` : ''}`;
      default:
        return `${name} ${t.shortDesc ? t.shortDesc(args) : ''}`.trim();
    }
  }

  addRule(tool, pattern, label) {
    this.rules.push({ tool, pattern, label });
  }

  ruleHit(name, args) {
    return this.rules.find((r) => ruleMatches(r, name, args));
  }

  /**
   * Decide whether a tool call may run. May prompt the user.
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async authorize(name, args) {
    // 1. Read-only calls are always fine (in every mode).
    if (tools.isReadOnlyCall(name, args)) return { ok: true };

    // 2. Full-auto: everything goes.
    if (this.mode === 'fullAuto') return { ok: true };

    // 3. Plan mode: no mutations, no command execution.
    if (this.mode === 'plan') {
      return { ok: false, reason: 'Plan mode is active (read-only). Ask the user to switch modes to apply changes.' };
    }

    // 4. Accept-edits: file writes auto-approved (deletes still prompt).
    if (this.mode === 'acceptEdits' && (name === 'write_file' || name === 'edit_file')) {
      return { ok: true };
    }

    // 5. Session allow-list.
    if (this.ruleHit(name, args)) return { ok: true };

    // 6. Non-interactive runs cannot prompt → deny.
    if (!this.interactive) {
      return {
        ok: false,
        reason:
          'Non-interactive run with no permission to execute this. Re-run with --full-auto (or --auto-edit for file edits), or pre-approve via settings.',
      };
    }

    // 7. Ask the user.
    const desc = this.describe(name, args);
    const canAlways = name === 'run_command';
    const choices = [
      { key: 'y', label: 'es' },
      { key: 'n', label: 'o' },
    ];
    if (canAlways) choices.push({ key: 'a', label: `lways allow "${commandRulePattern(args.command)}"` });

    if (this.terminal) this.terminal.suspend();
    let answer;
    try {
      answer = await askQuestion({
        title: 'Permission needed',
        lines: ['Arena Agent wants to ' + (name === 'run_command' ? 'run a command:' : 'perform:'), style.bold(desc)],
        choices,
        fallback: 'n',
      });
    } finally {
      if (this.terminal) this.terminal.resume();
    }

    if (answer === 'a' && canAlways) {
      const pattern = commandRulePattern(args.command);
      this.addRule(name, pattern, pattern);
      return { ok: true };
    }
    if (answer === 'y') return { ok: true };
    return { ok: false, reason: 'The user denied this action.' };
  }
}

module.exports = { Permissions, MODES, normalizeMode, commandRulePattern };
