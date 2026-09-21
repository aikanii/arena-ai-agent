'use strict';

const fs = require('fs');
const path = require('path');
const { resolveInRoot, relFrom, walk, looksLikeTextFile } = require('../utils/fsx');
const { buildIgnore } = require('./list');

module.exports = {
  name: 'search_files',
  description:
    'Search file contents in the project workspace with a regular expression (ripgrep-style results: "file:line: text"). Respects .gitignore and skips binary files. Use `include` to narrow to a glob-like filter such as "*.ts".',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for (e.g. "function\\s+login" or a plain literal).' },
      path: { type: 'string', description: 'Directory to search in (default: project root).' },
      include: { type: 'string', description: 'Optional filename filter with * wildcards, e.g. "*.py".' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive search (default false).' },
      max_results: { type: 'integer', description: 'Maximum matches to return (default 50).' },
    },
    required: ['pattern'],
  },
  readOnly: true,
  shortDesc(args) {
    return `/${args.pattern}/` + (args.path ? ' in ' + args.path : '');
  },
  async execute(args, ctx) {
    const dirAbs = args.path ? resolveInRoot(ctx.root, args.path) : ctx.root;
    if (!fs.existsSync(dirAbs)) throw new Error(`Path not found: ${args.path}`);
    let regex;
    try {
      regex = new RegExp(args.pattern, args.ignore_case ? 'i' : '');
    } catch {
      const escaped = String(args.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(escaped, args.ignore_case ? 'i' : '');
    }
    const include = args.include
      ? new RegExp(
          '^' +
            String(args.include)
              .split('*')
              .map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
              .join('.*') +
            '$',
          args.ignore_case ? 'i' : ''
        )
      : null;

    const maxResults = Math.min(200, Math.max(1, Number(args.max_results) || 50));
    const ignore = buildIgnore(ctx.root);
    const baseRel = relFrom(ctx.root, dirAbs);
    const matches = [];
    let filesScanned = 0;

    walk(dirAbs, {
      ignore: {
        matches(rel, isDir) {
          const full = baseRel === '.' ? rel : `${baseRel}/${rel}`;
          return ignore.matches(full, isDir);
        },
      },
      maxEntries: 5000,
      maxDepth: 12,
      visit(rel, ent) {
        if (ent.isDirectory() || matches.length >= maxResults) return;
        const name = ent.name;
        if (!looksLikeTextFile(name)) return;
        if (include && !include.test(name)) return;
        const abs = path.join(dirAbs, rel);
        let stat;
        try {
          stat = fs.statSync(abs);
        } catch {
          return;
        }
        if (stat.size > 300 * 1024) return;
        filesScanned++;
        let text;
        try {
          text = fs.readFileSync(abs, 'utf8');
        } catch {
          return;
        }
        if (text.includes('\u0000')) return;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
          if (regex.test(lines[i])) {
            const relFull = baseRel === '.' ? rel : `${baseRel}/${rel}`;
            matches.push(`${relFull}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
          regex.lastIndex = 0;
        }
      },
    });

    if (matches.length === 0) {
      return {
        result: `No matches for /${args.pattern}/ (${filesScanned} files scanned).`,
        summary: `No matches for /${args.pattern}/`,
      };
    }
    const note = matches.length >= maxResults ? `\n… truncated at ${maxResults} matches` : '';
    return {
      result: matches.join('\n') + note,
      summary: `${matches.length} match${matches.length === 1 ? '' : 'es'} for /${args.pattern}/ in ${filesScanned} files`,
      details: { type: 'text', text: matches.slice(0, 12).join('\n') },
    };
  },
};
