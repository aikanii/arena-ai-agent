'use strict';

/**
 * Minimal gitignore-style ignore matcher (no dependencies).
 * Supports: comments, negation (!), directory-only patterns (trailing /),
 * anchored patterns (leading / or containing /), and *, ?, ** wildcards.
 */

const DEFAULT_IGNORES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'target',
  '.idea',
  '.gradle',
  '.DS_Store',
  '.arena-agent',
  'vendor/bundle',
  'tmp',
];

function escapeRegExp(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function wildcardToRegExp(segment) {
  let re = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '*') {
      if (segment[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += escapeRegExp(ch);
    }
  }
  return re;
}

function compilePattern(raw) {
  let p = String(raw).trim();
  if (!p || p.startsWith('#')) return null;
  let negate = false;
  if (p.startsWith('!')) {
    negate = true;
    p = p.slice(1);
  }
  const dirOnly = p.endsWith('/');
  p = p.replace(/\/+$/, '').replace(/^\/+/, '');
  if (!p) return null;

  const anchored = raw.trim().startsWith('/') || raw.trim().startsWith('!/') || p.includes('/');
  const segments = p.split('/');
  const body = segments.map(wildcardToRegExp).join('/');

  let regex;
  if (anchored) {
    // Match the exact relative path, or anything underneath it (for directories).
    regex = new RegExp(`^${body}(?:/.*)?$`);
  } else {
    // Match a basename at any depth, or anything underneath a matching dir.
    regex = new RegExp(`(?:^|/)${body}(?:/.*)?$`);
  }

  return {
    negate,
    dirOnly,
    test(relPath /* posix-style, no leading slash */) {
      if (dirOnly && !relPath.endsWith('/') && !isDirCandidate(relPath)) return false;
      return regex.test(relPath);
    },
  };
}

// The walker annotates directories before calling matches(); we pass that via
// a trailing slash convention handled in Ignore.matches below instead.
function isDirCandidate() {
  return true;
}

class Ignore {
  constructor(patterns = []) {
    this.rules = patterns.map(compilePattern).filter(Boolean);
  }

  add(patterns) {
    for (const p of [].concat(patterns)) {
      const r = compilePattern(p);
      if (r) this.rules.push(r);
    }
  }

  /**
   * @param {string} relPath posix-style relative path, no leading slash
   * @param {boolean} isDir whether the path is a directory
   */
  matches(relPath, isDir = false) {
    const probe = isDir ? relPath + '/__dir__' : relPath;
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) {
        // Directory-only patterns still apply to paths *inside* matched dirs,
        // which the regex covers via the (?:/.*)? suffix.
        if (!rule.test(relPath)) continue;
      } else if (!rule.test(probe) && !rule.test(relPath)) {
        continue;
      }
      ignored = !rule.negate;
    }
    return ignored;
  }
}

/** Parse the text of a .gitignore / .arenaignore file. */
function parseIgnoreFile(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

module.exports = { Ignore, DEFAULT_IGNORES, parseIgnoreFile };
