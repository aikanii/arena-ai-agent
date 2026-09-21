'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { walk, humanSize } = require('./utils/fsx');
const { Ignore, DEFAULT_IGNORES, parseIgnoreFile } = require('./utils/ignore');
const { execCaptureSync } = require('./utils/exec');

const LANG_BY_EXT = {
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust', '.java': 'Java',
  '.php': 'PHP', '.cs': 'C#', '.cpp': 'C++', '.c': 'C', '.h': 'C/C++',
  '.swift': 'Swift', '.kt': 'Kotlin', '.dart': 'Dart', '.scala': 'Scala',
  '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS', '.vue': 'Vue', '.svelte': 'Svelte',
  '.sh': 'Shell', '.sql': 'SQL', '.md': 'Markdown',
};

function loadIgnore(root) {
  const ignore = new Ignore(DEFAULT_IGNORES);
  for (const name of ['.gitignore', '.arenaignore']) {
    try {
      ignore.add(parseIgnoreFile(fs.readFileSync(path.join(root, name), 'utf8')));
    } catch {
      /* not present */
    }
  }
  return ignore;
}

/** Build a compact textual repo map for the system prompt. */
function buildRepoMap(root) {
  const ignore = loadIgnore(root);
  const files = [];
  let truncated = false;
  const maxFiles = 400;

  walk(root, {
    ignore,
    maxEntries: maxFiles,
    maxDepth: 7,
    visit(rel, ent) {
      if (ent.isDirectory()) return;
      files.push(rel);
    },
  });
  if (files.length >= maxFiles) truncated = true;

  // Language histogram
  const hist = {};
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const lang = LANG_BY_EXT[ext];
    if (lang) hist[lang] = (hist[lang] || 0) + 1;
  }
  const languages = Object.entries(hist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([l, n]) => `${l} (${n})`)
    .join(', ');

  // Render grouped by top-level directory.
  const groups = new Map();
  for (const f of files.slice(0, maxFiles)) {
    const top = f.includes('/') ? f.split('/')[0] + '/' : '(root)';
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top).push(f);
  }
  const lines = [];
  for (const [top, list] of groups) {
    if (top !== '(root)') lines.push(`${top}`);
    for (const f of list.slice(0, 60)) {
      lines.push(top === '(root)' ? `  ${f}` : `  ${f.slice(top.length)}`);
    }
    if (list.length > 60) lines.push(`  … ${list.length - 60} more in ${top}`);
  }
  let mapText = lines.join('\n');
  const budget = 6000;
  if (mapText.length > budget) {
    mapText = mapText.slice(0, budget) + '\n… (map truncated)';
    truncated = true;
  }
  return { mapText, languages, fileCount: files.length, truncated };
}

/** Cheap git facts via synchronous probes. */
function gitInfo(root) {
  const branch = execCaptureSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  if (!branch || branch.code !== 0) return null;
  const info = { branch: branch.stdout.trim() || 'HEAD', dirty: false, changed: 0, lastCommit: null };
  const status = execCaptureSync('git', ['status', '--porcelain=v1'], { cwd: root });
  if (status && status.code === 0) {
    const lines = status.stdout.split('\n').filter(Boolean);
    info.changed = lines.length;
    info.dirty = lines.length > 0;
  }
  const last = execCaptureSync('git', ['log', '-1', '--pretty=%h %s'], { cwd: root });
  if (last && last.code === 0 && last.stdout.trim()) info.lastCommit = last.stdout.trim().slice(0, 80);
  return info;
}

/** ARENA.md memory: project-level first, then user-level fallback. */
function loadArenaMd(root) {
  const candidates = [path.join(root, 'ARENA.md'), path.join(os.homedir(), '.arena-agent', 'ARENA.md')];
  for (const c of candidates) {
    try {
      const text = fs.readFileSync(c, 'utf8');
      if (text.trim()) return { path: c, text: text.slice(0, 20000) };
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function gatherContext(root) {
  const map = buildRepoMap(root);
  return {
    repoMap: map.mapText,
    languages: map.languages,
    fileCount: map.fileCount,
    git: gitInfo(root),
    arenaMd: loadArenaMd(root),
  };
}

/** A few facts used by `arena init` to seed ARENA.md. */
function projectFacts(root) {
  const facts = { name: path.basename(root), scripts: null, hasGit: false, readme: false };
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pj.scripts && Object.keys(pj.scripts).length) facts.scripts = pj.scripts;
    if (pj.name) facts.name = pj.name;
  } catch {
    /* not node */
  }
  facts.hasGit = fs.existsSync(path.join(root, '.git'));
  facts.readme = ['README.md', 'README.rst', 'README'].some((n) => fs.existsSync(path.join(root, n)));
  return facts;
}

module.exports = { gatherContext, buildRepoMap, gitInfo, loadArenaMd, projectFacts, loadIgnore };
