'use strict';

const { execCapture } = require('../utils/exec');

const READ_OPS = new Set(['status', 'diff', 'log', 'show', 'branch']);

const SCHEMA_OP = {
  type: 'string',
  enum: ['status', 'diff', 'log', 'show', 'branch', 'add', 'commit'],
  description: 'The git operation to perform.',
};

module.exports = {
  name: 'git',
  description:
    'Interact with the project Git repository. Read-only ops: status, diff (staged:true for --staged), log, show <ref>, branch. Write ops (need user approval): add (all changes), commit with `message`. Prefer this over running git via run_command.',
  parameters: {
    type: 'object',
    properties: {
      operation: SCHEMA_OP,
      staged: { type: 'boolean', description: 'For diff: show staged changes.' },
      limit: { type: 'integer', description: 'For log: number of commits (default 10).' },
      ref: { type: 'string', description: 'For show: a commit ref or ref:path.' },
      message: { type: 'string', description: 'For commit: the commit message.' },
    },
    required: ['operation'],
  },
  readOnly: false,
  isReadOnlyCall(args) {
    return READ_OPS.has(args && args.operation);
  },
  shortDesc(args) {
    return 'git ' + String(args.operation || '');
  },
  async execute(args, ctx) {
    const op = args.operation;
    let gitArgs;
    switch (op) {
      case 'status':
        gitArgs = ['status', '--porcelain=v1', '--branch'];
        break;
      case 'diff':
        gitArgs = args.staged ? ['diff', '--staged'] : ['diff'];
        break;
      case 'log': {
        const n = Math.min(50, Math.max(1, Number(args.limit) || 10));
        gitArgs = ['log', '--oneline', '--decorate', `-${n}`];
        break;
      }
      case 'show':
        if (!args.ref) throw new Error('`ref` is required for git show.');
        gitArgs = ['show', '--stat', '-p', String(args.ref)];
        break;
      case 'branch':
        gitArgs = ['branch', '--all', '--list'];
        break;
      case 'add':
        gitArgs = ['add', '-A'];
        break;
      case 'commit':
        if (!args.message) throw new Error('`message` is required for git commit.');
        gitArgs = ['commit', '-m', String(args.message)];
        break;
      default:
        throw new Error(`Unknown git operation: ${op}`);
    }

    const r = await execCapture('git', gitArgs, { cwd: ctx.root, timeoutMs: 30000, maxBytes: 40000 });
    const out = (r.stdout || '').trimEnd();
    const err = (r.stderr || '').trimEnd();
    const text = [out, err && op === 'status' ? '' : err].filter(Boolean).join('\n');
    if (r.code !== 0 && !text) {
      throw new Error(`git ${op} failed with exit code ${r.code}`);
    }
    const result = text || `(git ${op}: nothing to show)`;
    const first = result.split('\n')[0].slice(0, 100);
    return {
      result,
      summary: `git ${op} → ${first}${result.includes('\n') ? ' …' : ''}`,
      details: { type: 'text', text: result },
    };
  },
};
