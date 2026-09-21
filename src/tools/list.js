'use strict';

const fs = require('fs');
const path = require('path');
const { resolveInRoot, relFrom, walk } = require('../utils/fsx');
const { Ignore, DEFAULT_IGNORES, parseIgnoreFile } = require('../utils/ignore');

function buildIgnore(root) {
  const ignore = new Ignore(DEFAULT_IGNORES);
  try {
    const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    ignore.add(parseIgnoreFile(gi));
  } catch {
    /* no .gitignore */
  }
  try {
    const ai = fs.readFileSync(path.join(root, '.arenaignore'), 'utf8');
    ignore.add(parseIgnoreFile(ai));
  } catch {
    /* no .arenaignore */
  }
  return ignore;
}

module.exports = {
  name: 'list_files',
  description:
    'List files and directories in the project workspace as a tree. Respects .gitignore. Use it to orient yourself before reading or searching.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list (default: project root).' },
      depth: { type: 'integer', description: 'Maximum depth to descend (default 3, max 8).' },
      max_entries: { type: 'integer', description: 'Maximum entries to show (default 250).' },
    },
    required: [],
  },
  readOnly: true,
  shortDesc(args) {
    return args.path || '.';
  },
  async execute(args, ctx) {
    const dirAbs = args.path ? resolveInRoot(ctx.root, args.path) : ctx.root;
    if (!fs.existsSync(dirAbs)) throw new Error(`Path not found: ${args.path}`);
    if (!fs.statSync(dirAbs).isDirectory()) throw new Error(`"${args.path}" is not a directory — use read_file.`);
    const ignore = buildIgnore(ctx.root);
    const depth = Math.min(8, Math.max(1, Number(args.depth) || 3));
    const maxEntries = Math.min(1000, Math.max(20, Number(args.max_entries) || 250));

    const lines = [];
    let truncated = false;
    // Walk relative to the chosen directory, but apply ignore rules relative to root.
    const baseRel = relFrom(ctx.root, dirAbs);
    const n = walk(dirAbs, {
      ignore: {
        matches(rel, isDir) {
          const full = baseRel === '.' ? rel : `${baseRel}/${rel}`;
          return ignore.matches(full, isDir);
        },
      },
      maxEntries,
      maxDepth: depth,
      visit(rel, ent, d) {
        lines.push('  '.repeat(d) + (ent.isDirectory() ? rel.split('/').pop() + '/' : rel.split('/').pop()));
        if (ent.isDirectory() && d >= depth) lines.push('  '.repeat(d + 1) + '…');
      },
    });
    if (n >= maxEntries) {
      truncated = true;
      lines.push(`… truncated at ${maxEntries} entries (narrow the path or raise max_entries)`);
    }
    const rel = relFrom(ctx.root, dirAbs);
    return {
      result: `Directory listing of ${rel || '.'}${truncated ? ' (truncated)' : ''}:\n` + lines.join('\n'),
      summary: `Listed ${rel || '.'} (${n} entries${truncated ? ', truncated' : ''})`,
    };
  },
};

module.exports.buildIgnore = buildIgnore;
