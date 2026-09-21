'use strict';

const fs = require('fs');
const { resolveInRoot, relFrom, walk } = require('../utils/fsx');

module.exports = {
  name: 'delete_file',
  description:
    'Delete a file or (with recursive: true) a directory. Only use when the user explicitly asked for deletion. Irreversible unless under version control.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File or directory path, relative to the project root.' },
      recursive: { type: 'boolean', description: 'Required to delete a directory and everything inside it.' },
    },
    required: ['path'],
  },
  readOnly: false,
  shortDesc(args) {
    return args.path;
  },
  async execute(args, ctx) {
    const abs = resolveInRoot(ctx.root, args.path);
    if (!fs.existsSync(abs)) throw new Error(`Path not found: ${args.path}`);
    const rel = relFrom(ctx.root, abs);
    if (rel === '.') throw new Error('Refusing to delete the project root.');
    const stat = fs.statSync(abs);
    if (stat.isDirectory() && !args.recursive) {
      throw new Error(`"${args.path}" is a directory. Pass recursive: true to delete it.`);
    }
    if (stat.isDirectory()) {
      let count = 0;
      walk(abs, { maxEntries: 2000, visit: () => { count++; } });
      fs.rmSync(abs, { recursive: true, force: true });
      return { result: `Deleted directory ${rel} (${count} entries).`, summary: `Deleted ${rel}/ (${count} entries)` };
    }
    fs.rmSync(abs, { force: true });
    return { result: `Deleted file ${rel}.`, summary: `Deleted ${rel}` };
  },
};
