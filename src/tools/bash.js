'use strict';

const fs = require('fs');
const { execCapture } = require('../utils/exec');

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;

function pickShell() {
  if (process.platform === 'win32') return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c']];
  const shell = process.env.ARENA_SHELL || '/bin/bash';
  if (fs.existsSync(shell)) return [shell, ['-c']];
  return ['/bin/sh', ['-c']];
}

module.exports = {
  name: 'run_command',
  description:
    'Run a shell command in the project workspace and return stdout, stderr and the exit code. Use it to run tests, builds, linters, install dependencies, start dev servers briefly, or inspect the environment. Commands that exceed the timeout are killed. Do not use it for interactive programs.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
      timeout_ms: { type: 'integer', description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).` },
      description: { type: 'string', description: 'One-line description of what this command does (shown to the user).' },
    },
    required: ['command'],
  },
  readOnly: false,
  shortDesc(args) {
    return '$ ' + String(args.command || '').split('\n')[0].slice(0, 100);
  },
  async execute(args, ctx) {
    if (typeof args.command !== 'string' || !args.command.trim()) {
      throw new Error('`command` is required.');
    }
    const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number(args.timeout_ms) || DEFAULT_TIMEOUT_MS));
    const [shell, prefixArgs] = pickShell();
    const r = await execCapture(shell, [...prefixArgs, args.command], {
      cwd: ctx.root,
      timeoutMs: timeout,
      maxBytes: 30000,
      env: { ...process.env, ARENA_AGENT: '1', CI: process.env.CI || '' },
    });

    const parts = [];
    parts.push(`Command: ${args.command}`);
    parts.push(`Exit code: ${r.timedOut ? 'TIMEOUT (killed)' : r.code === null ? 'ERROR' : r.code}`);
    if (r.error) parts.push(`Spawn error: ${r.error}`);
    if (r.stdout.trim()) parts.push('STDOUT:\n' + r.stdout.trimEnd());
    if (r.stderr.trim()) parts.push('STDERR:\n' + r.stderr.trimEnd());
    if (!r.stdout.trim() && !r.stderr.trim() && !r.error) parts.push('(no output)');

    const ok = r.code === 0 && !r.timedOut;
    const exitLabel = r.timedOut ? 'timeout' : `exit ${r.code === null ? '?' : r.code}`;
    const firstOut = (r.stdout.trim() || r.stderr.trim() || '(no output)').split('\n')[0].slice(0, 120);
    return {
      result: parts.join('\n'),
      summary: `${ok ? '✓' : '✗'} ${exitLabel} · ${firstOut}${args.description ? ' — ' + args.description : ''}`,
      details: { type: 'text', text: [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n--- stderr ---\n') },
    };
  },
};
