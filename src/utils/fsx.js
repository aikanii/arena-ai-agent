'use strict';

const fs = require('fs');
const path = require('path');

class WorkspaceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkspaceError';
    this.friendly = true;
  }
}

/**
 * Resolve a tool-supplied path inside the project workspace.
 * Absolute paths are allowed only when they point inside the root.
 */
function resolveInRoot(root, p) {
  if (!p || typeof p !== 'string') throw new WorkspaceError('A `path` argument is required.');
  const rootAbs = path.resolve(root);
  let abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(rootAbs, p);
  // Lexical normalization of .. segments happens in path.resolve/normalize.
  const rel = path.relative(rootAbs, abs);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new WorkspaceError(`Path escapes the project workspace: ${p}`);
  }
  return abs;
}

function relFrom(root, abs) {
  const r = path.relative(path.resolve(root), abs);
  return r === '' ? '.' : r.split(path.sep).join('/');
}

function humanSize(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function isProbablyBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

const TEXT_EXTS = new Set([
  '.md', '.txt', '.rst', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.swift', '.dart', '.scala', '.sql',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.vue', '.svelte', '.xml', '.svg', '.env', '.gitignore', '.dockerignore', '.editorconfig',
  '.lock', '.csv', '.tsv', '.graphql', '.gql', '.proto', '.tf', '.hcl', '.lua', '.pl', '.r',
]);

function looksLikeTextFile(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '') return true; // e.g. Makefile, Dockerfile
  return TEXT_EXTS.has(ext);
}

/**
 * Read a file with size/binary guards. Returns { text, truncated, size, lineCount }.
 */
function readFileText(abs, { maxBytes = 250 * 1024 } = {}) {
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new WorkspaceError(`Not a file: ${abs}`);
  const size = stat.size;
  const fd = fs.openSync(abs, 'r');
  try {
    const toRead = Math.min(size, maxBytes);
    const buf = Buffer.alloc(toRead);
    fs.readSync(fd, buf, 0, toRead, 0);
    if (isProbablyBinary(buf)) throw new WorkspaceError('Binary file — cannot display contents.');
    let text = buf.toString('utf8');
    const truncated = size > toRead;
    if (truncated) text += `\n…[truncated: file is ${humanSize(size)}, showing first ${humanSize(toRead)}]`;
    return { text, truncated, size, lineCount: text.split('\n').length };
  } finally {
    fs.closeSync(fd);
  }
}

function ensureDirFor(abs) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function atomicWrite(abs, content) {
  ensureDirFor(abs);
  const tmp = abs + '.arena-tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, abs);
}

/**
 * Walk a directory tree depth-first, calling `visit(relPath, dirent, depth)`.
 * If `visit` returns false for a directory, that subtree is pruned.
 * Stops early once `maxEntries` items have been visited.
 */
function walk(root, { ignore, maxEntries = 500, maxDepth = 8, visit }) {
  const rootAbs = path.resolve(root);
  let count = 0;

  function rec(dirAbs, rel, depth) {
    if (depth > maxDepth || count >= maxEntries) return;
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });
    for (const ent of entries) {
      if (count >= maxEntries) return;
      const relChild = rel ? `${rel}/${ent.name}` : ent.name;
      const isDir = ent.isDirectory();
      if (ent.isSymbolicLink()) continue; // avoid cycles
      if (ignore && ignore.matches(relChild, isDir)) continue;
      count++;
      const r = visit(relChild, ent, depth);
      if (isDir && r !== false) rec(path.join(dirAbs, ent.name), relChild, depth + 1);
    }
  }

  rec(rootAbs, '', 0);
  return count;
}

module.exports = {
  WorkspaceError,
  resolveInRoot,
  relFrom,
  humanSize,
  isProbablyBinary,
  looksLikeTextFile,
  readFileText,
  ensureDirFor,
  exists,
  atomicWrite,
  walk,
};
