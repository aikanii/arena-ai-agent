'use strict';

const fs = require('fs');
const { resolveInRoot, relFrom, readFileText, humanSize } = require('../utils/fsx');

module.exports = {
  name: 'read_file',
  description:
    'Read the contents of a file in the project workspace. Returns the file text (with a note when truncated). Use line_offset/line_limit for large files. For directories use list_files instead.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the project root (or absolute inside it).' },
      line_offset: { type: 'integer', description: '1-based line number to start reading from (default 1).' },
      line_limit: { type: 'integer', description: 'Maximum number of lines to return (default 2000).' },
    },
    required: ['path'],
  },
  readOnly: true,
  shortDesc(args) {
    return args.path;
  },
  async execute(args, ctx) {
    const abs = resolveInRoot(ctx.root, args.path);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      throw new Error(`"${args.path}" is a directory — use list_files or search_files instead.`);
    }
    const { text, size, truncated } = readFileText(abs);
    const allLines = text.split('\n');
    const offset = Math.max(1, Number(args.line_offset) || 1);
    const limit = Math.min(4000, Math.max(1, Number(args.line_limit) || 2000));
    const slice = allLines.slice(offset - 1, offset - 1 + limit);
    const moreLines = allLines.length > offset - 1 + limit;
    const rel = relFrom(ctx.root, abs);
    let body = slice.join('\n');
    let note = '';
    if (offset > 1) note += `(starting at line ${offset}) `;
    if (moreLines) note += `(showing lines ${offset}–${offset - 1 + slice.length} of ${allLines.length}; request more with line_offset)`;
    else if (truncated) note += '(file truncated by size)';
    const result = `${note ? note + '\n' : ''}${body}`;
    return {
      result,
      summary: `Read ${rel} (${allLines.length} lines, ${humanSize(size)})`,
      details: { type: 'text', text: body.split('\n').slice(0, 10).join('\n') },
    };
  },
};
