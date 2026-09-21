'use strict';

const fs = require('fs');
const { resolveInRoot, relFrom, atomicWrite, humanSize } = require('../utils/fsx');
const { diffLines } = require('../utils/diff');

module.exports = {
  name: 'write_file',
  description:
    'Create a file or overwrite an existing one with the full provided content. Parent directories are created automatically. Prefer edit_file for modifying existing files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the project root.' },
      content: { type: 'string', description: 'The complete file content to write.' },
    },
    required: ['path', 'content'],
  },
  readOnly: false,
  shortDesc(args) {
    return args.path;
  },
  async execute(args, ctx) {
    if (typeof args.content !== 'string') throw new Error('`content` must be a string.');
    const abs = resolveInRoot(ctx.root, args.path);
    const rel = relFrom(ctx.root, abs);
    let before = null;
    if (fs.existsSync(abs)) {
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) throw new Error(`"${args.path}" is a directory.`);
      try {
        before = fs.readFileSync(abs, 'utf8');
      } catch {
        before = null;
      }
    }
    atomicWrite(abs, args.content);
    const created = before === null;
    const entries = diffLines(before === null ? [] : before.split('\n'), args.content.split('\n'));
    const lineCount = args.content.split('\n').length;
    return {
      result: `Successfully ${created ? 'created' : 'overwrote'} ${rel} (${lineCount} lines, ${humanSize(args.content.length)}).`,
      summary: `${created ? 'Created' : 'Overwrote'} ${rel} (${lineCount} lines)`,
      details: { type: 'diff', entries },
    };
  },
};
