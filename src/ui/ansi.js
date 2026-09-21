'use strict';

/**
 * Minimal ANSI styling helpers (zero dependencies).
 * Colors auto-disable when stdout is not a TTY or NO_COLOR is set.
 */

const enabled = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return !!process.stdout.isTTY;
})();

function wrap(open, close) {
  return (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
}

const style = {
  reset: wrap(0, 0),
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  black: wrap(30, 39),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  white: wrap(37, 39),
  gray: wrap(90, 39),
  orange: wrap('38;5;208', 39),
  purple: wrap('38;5;141', 39),
  bgRed: wrap(41, 49),
  bgYellow: wrap(43, 49),
};

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

function visibleLength(s) {
  return stripAnsi(s).length;
}

function termWidth() {
  return Math.max(40, process.stdout.columns || 100);
}

/** Greedy word-wrap that is aware of ANSI escapes (wraps on visible width). */
function wordWrap(text, width) {
  const out = [];
  for (const rawLine of String(text).split('\n')) {
    if (visibleLength(rawLine) <= width) {
      out.push(rawLine);
      continue;
    }
    // Split into tokens keeping ANSI codes attached to the following word.
    const tokens = rawLine.split(/(\s+)/);
    let line = '';
    let visLen = 0;
    for (const tok of tokens) {
      const tokVis = visibleLength(tok);
      if (visLen + tokVis > width && line.trim().length > 0) {
        out.push(line.replace(/\s+$/, ''));
        line = /^\s+$/.test(tok) ? '' : tok;
        visLen = /^\s+$/.test(tok) ? 0 : tokVis;
      } else {
        line += tok;
        visLen += tokVis;
      }
    }
    out.push(line.replace(/\s+$/, ''));
  }
  return out;
}

function truncateLine(s, width) {
  if (visibleLength(s) <= width) return s;
  // Safe truncation only for unstyled strings; styled strings are rare here.
  return stripAnsi(s).slice(0, Math.max(0, width - 1)) + '…';
}

function pad(s, width) {
  const vis = visibleLength(s);
  return vis >= width ? s : s + ' '.repeat(width - vis);
}

module.exports = { enabled, style, stripAnsi, visibleLength, termWidth, wordWrap, truncateLine, pad };
