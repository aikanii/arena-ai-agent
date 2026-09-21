'use strict';

const fs = require('fs');
const { resolveInRoot, relFrom, atomicWrite } = require('../utils/fsx');
const { diffLines } = require('../utils/diff');

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

module.exports = {
  name: 'edit_file',
  description:
    'Replace an exact string in an existing file. `old_string` must match the file content EXACTLY (including whitespace) and must be unique unless replace_all is true. Read the file first if you are unsure of the exact content.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the project root.' },
      old_string: { type: 'string', description: 'The exact text to find and replace.' },
      new_string: { type: 'string', description: 'The replacement text (may be empty to delete).' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  readOnly: false,
  shortDesc(args) {
    return args.path;
  },
  async execute(args, ctx) {
    const abs = resolveInRoot(ctx.root, args.path);
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${args.path} — check the path with list_files or search_files.`);
    const rel = relFrom(ctx.root, abs);
    const before = fs.readFileSync(abs, 'utf8');
    const oldStr = String(args.old_string);
    const newStr = String(args.new_string);
    if (oldStr === '') throw new Error('`old_string` cannot be empty.');

    const n = countOccurrences(before, oldStr);
    if (n === 0) {
      throw new Error(
        `old_string not found in ${args.path}. Re-read the file and copy the exact text (whitespace matters).`
      );
    }
    if (n > 1 && !args.replace_all) {
      throw new Error(
        `old_string matches ${n} locations in ${args.path}. Add surrounding context to make it unique, or set replace_all: true.`
      );
    }

    const after = args.replace_all ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr);
    atomicWrite(abs, after);

    const entries = diffLines(before.split('\n'), after.split('\n'));
    return {
      result: `Successfully edited ${rel}${args.replace_all ? ` (${n} replacements)` : ''}.`,
      summary: `Edited ${rel}${args.replace_all ? ` ×${n}` : ''}`,
      details: { type: 'diff', entries },
    };
  },
};
