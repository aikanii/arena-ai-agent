'use strict';

/**
 * Fast, dependency-free line diff.
 * Strategy: trim common prefix and suffix; everything in between is a
 * replacement region. This is exact for the vast majority of code edits and
 * always O(n) — good enough for terminal rendering and cheap enough to run
 * on every edit.
 */

function diffLines(aLines, bLines) {
  const a = Array.isArray(aLines) ? aLines : String(aLines || '').split('\n');
  const b = Array.isArray(bLines) ? bLines : String(bLines || '').split('\n');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out = [];
  for (let i = 0; i < start; i++) out.push({ t: ' ', s: a[i] });
  for (let i = start; i < endA; i++) out.push({ t: '-', s: a[i] });
  for (let i = start; i < endB; i++) out.push({ t: '+', s: b[i] });
  for (let i = endA; i < a.length; i++) out.push({ t: ' ', s: a[i] });
  return out;
}

/**
 * Collapse a diff to at most `maxLines` visible lines, keeping context around
 * changes. Returns an array of {t, s} entries where t === '…' marks elision.
 */
function collapseDiff(entries, { maxLines = 40, context = 3 } = {}) {
  if (entries.length <= maxLines) return entries;
  const keep = new Set();
  entries.forEach((e, i) => {
    if (e.t !== ' ') {
      for (let j = Math.max(0, i - context); j <= Math.min(entries.length - 1, i + context); j++) {
        keep.add(j);
      }
    }
  });
  const out = [];
  let skipped = 0;
  entries.forEach((e, i) => {
    if (keep.has(i)) {
      if (skipped > 0) {
        out.push({ t: '…', s: `${skipped} unchanged lines hidden` });
        skipped = 0;
      }
      out.push(e);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) out.push({ t: '…', s: `${skipped} unchanged lines hidden` });
  return out;
}

function diffStats(entries) {
  let added = 0;
  let removed = 0;
  for (const e of entries) {
    if (e.t === '+') added++;
    else if (e.t === '-') removed++;
  }
  return { added, removed };
}

module.exports = { diffLines, collapseDiff, diffStats };
