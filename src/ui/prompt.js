'use strict';

const readline = require('readline');
const { StringDecoder } = require('string_decoder');
const { style, wordWrap, termWidth } = require('./ansi');

/**
 * Ask a y/n/a style permission question.
 * Returns one of the provided choice keys. On non-TTY stdin the fallback is
 * returned immediately (never blocks scripted runs).
 */
function askQuestion({ title, lines = [], choices, fallback = 'n' }) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      resolve(fallback);
      return;
    }
    const w = termWidth();
    process.stdout.write('\n' + style.yellow('╭─ ' + title + ' ') + style.yellow('─'.repeat(Math.max(2, Math.min(w, 64) - title.length - 4))) + style.yellow('╮') + '\n');
    for (const l of lines) {
      for (const wl of wordWrap(l, Math.min(w, 64) - 4)) {
        process.stdout.write(style.yellow('│') + ' ' + wl + '\n');
      }
    }
    const optStr = choices.map((c) => `(${style.bold(c.key)})${c.label}`).join('  ');
    process.stdout.write(style.yellow('╰▸ ') + optStr + '\n');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const ask = () => {
      rl.question(style.dim('  choice ▸ '), (answerRaw) => {
        const answer = answerRaw.trim().toLowerCase();
        if (!answer) {
          rl.close();
          resolve(fallback);
          return;
        }
        const hit = choices.find((c) => c.key === answer || c.key.startsWith(answer));
        if (hit) {
          rl.close();
          resolve(hit.key);
          return;
        }
        process.stdout.write(style.gray('  enter one of: ' + choices.map((c) => c.key).join(' / ')) + '\n');
        ask();
      });
    };
    ask();
  });
}

/* ------------------------------------------------------------------ */
/* Raw-mode terminal input driver                                      */
/* ------------------------------------------------------------------ */

const EOF_SYMBOL = Symbol('eof');
const SIGINT_SYMBOL = Symbol('sigint');

/** Surrogate-aware length of the final character (never split an emoji). */
function lastCharLen(s) {
  if (!s) return 0;
  if (s.length >= 2 && s.codePointAt(s.length - 2) > 0xffff) return 2;
  return 1;
}

/**
 * Owns terminal input for the whole session. A single persistent raw-mode
 * listener feeds:
 *   - line editing for the REPL prompt (history, paste, multi-line)
 *   - a type-ahead queue for lines entered while the agent is busy
 *   - esc / ctrl-c interrupt detection while the agent is working
 */
class TerminalInput {
  constructor() {
    this.EOF = EOF_SYMBOL;
    this.SIGINT = SIGINT_SYMBOL;
    this.history = [];
    this.pendingLines = [];
    this.resolver = null; // { resolve, main, cont }
    this.interruptCb = null;
    this.entry = { buffer: '', full: '', inPaste: false, histIdx: 0 };
    this.decoder = new StringDecoder('utf8');
    this.attached = false;
    this.suspended = false; // true while another UI (permission prompt) owns input
  }

  suspend() {
    this.suspended = true;
  }

  resume() {
    this.suspended = false;
  }

  get tty() {
    return !!process.stdin.isTTY;
  }

  attach() {
    if (this.attached || !this.tty) return;
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', (chunk) => this.feed(this.decoder.write(chunk)));
      this.attached = true;
    } catch {
      /* leave cooked mode; features degrade gracefully */
    }
  }

  close() {
    if (!this.attached) return;
    try {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    } catch {
      /* ignore */
    }
    this.attached = false;
  }

  /* ------------------------------------------------------------- */

  feed(s) {
    if (this.suspended) {
      // A readline-based prompt owns input right now; still honor interrupts.
      if (this.interruptCb && (s.includes('\x1b') || s.includes('\x03'))) {
        this.interruptCb(s.includes('\x03'));
      }
      return;
    }
    while (s.length > 0) {
      const e = this.entry;

      if (e.inPaste) {
        const end = s.indexOf('\x1b[201~');
        if (end === -1) {
          e.buffer += s.replace(/\r\n|\r|\n/g, '\n');
          s = '';
        } else {
          e.buffer += s.slice(0, end).replace(/\r\n|\r|\n/g, '\n');
          s = s.slice(end + 6);
          e.inPaste = false;
        }
        this.redraw();
        continue;
      }
      if (s.startsWith('\x1b[200~')) {
        e.inPaste = true;
        s = s.slice(6);
        continue;
      }

      const c = s[0];

      /* ---------------- escapes ---------------- */
      if (c === '\x1b') {
        if (this.resolver) {
          if (s.startsWith('\x1b[A')) {
            if (this.history.length && e.histIdx > 0) {
              e.histIdx--;
              e.buffer = this.history[e.histIdx];
            }
            s = s.slice(3);
            this.redraw();
            continue;
          }
          if (s.startsWith('\x1b[B')) {
            if (e.histIdx < this.history.length) {
              e.histIdx++;
              e.buffer = e.histIdx === this.history.length ? '' : this.history[e.histIdx];
            }
            s = s.slice(3);
            this.redraw();
            continue;
          }
          const m = /^\x1b\[[0-9;]*[A-Za-z]/.exec(s);
          if (m) {
            s = s.slice(m[0].length);
            continue;
          }
          s = s.slice(1); // bare/unknown escape: ignore while editing
          continue;
        }
        // Not at a prompt: esc interrupts the running turn.
        const m = /^\x1b(\[[0-9;]*[A-Za-z])?/.exec(s);
        if (this.interruptCb) this.interruptCb(false);
        this.clearEntry();
        s = s.slice(m ? m[0].length : 1);
        continue;
      }

      /* ---------------- ctrl keys ---------------- */
      if (c === '\x03') {
        if (this.resolver) {
          if (e.buffer.length || e.full.length) {
            e.buffer = '';
            e.full = '';
            this.redraw();
            process.stdout.write(style.gray('  (^C again to quit)') + '\n');
            this.redraw();
          } else {
            this.finishResolve(SIGINT_SYMBOL);
          }
        } else {
          if (this.interruptCb) this.interruptCb(true);
          this.clearEntry();
        }
        s = s.slice(1);
        continue;
      }

      if (c === '\x04') {
        if (this.resolver && !e.buffer.length && !e.full.length) {
          this.finishResolve(EOF_SYMBOL);
        }
        s = s.slice(1);
        continue;
      }

      /* ---------------- enter ---------------- */
      if (c === '\r' || c === '\n') {
        s = s.slice(1);
        if (this.resolver && e.buffer.endsWith('\\')) {
          e.full += e.buffer.slice(0, -1) + '\n';
          e.buffer = '';
          process.stdout.write('\n');
          this.redraw();
          continue;
        }
        this.finishEntry();
        continue;
      }

      /* ---------------- editing ---------------- */
      if (c === '\x7f' || c === '\b') {
        if (this.resolver) {
          e.buffer = e.buffer.slice(0, e.buffer.length - lastCharLen(e.buffer));
          this.redraw();
        } else if (e.buffer.length) {
          e.buffer = e.buffer.slice(0, e.buffer.length - lastCharLen(e.buffer));
        }
        s = s.slice(1);
        continue;
      }
      if (c === '\x15') {
        e.buffer = '';
        if (this.resolver) this.redraw();
        s = s.slice(1);
        continue;
      }
      if (c === '\x17') {
        e.buffer = e.buffer.replace(/\S+\s*$/, '');
        if (this.resolver) this.redraw();
        s = s.slice(1);
        continue;
      }

      if (c < ' ' && c !== '\t') {
        s = s.slice(1);
        continue;
      }

      // printable (silent type-ahead while the agent is busy)
      e.buffer += c;
      if (this.resolver) this.redraw();
      s = s.slice(1);
    }
  }

  clearEntry() {
    this.entry = { buffer: '', full: '', inPaste: false, histIdx: this.history.length };
  }

  finishEntry() {
    const e = this.entry;
    const value = e.full + e.buffer;
    const hidden = !!(this.resolver && this.resolver.hidden);
    this.clearEntry();
    if (value.trim() && !hidden) {
      this.history.push(value);
      if (this.history.length > 200) this.history.shift();
    }
    if (this.resolver) {
      this.finishResolve(value);
    } else if (value.trim()) {
      this.pendingLines.push(value); // type-ahead while agent is busy
    }
  }

  finishResolve(val) {
    const r = this.resolver;
    this.resolver = null;
    if (typeof val === 'string') process.stdout.write('\n');
    if (r) r.resolve(val);
  }

  redraw() {
    if (!this.resolver || !this.tty) return;
    const prompt = this.entry.full ? this.resolver.cont : this.resolver.main;
    if (this.resolver.hidden) {
      process.stdout.write('\r\x1b[2K' + prompt + style.gray('•'.repeat(Math.min(this.entry.buffer.length, 24))));
      return;
    }
    process.stdout.write('\r\x1b[2K' + prompt + this.entry.buffer.replace(/\n/g, '⏎'));
  }

  /* ------------------------------------------------------------- */

  /** Read one user entry. Resolves string | EOF | SIGINT. With {hidden:true} input is not echoed (secrets). */
  readLine(prompt, { hidden = false } = {}) {
    if (!this.tty) return this.readLinePiped();
    this.attach();

    if (this.pendingLines.length && !hidden) {
      const v = this.pendingLines.shift();
      process.stdout.write(style.bold(style.purple(prompt)) + v.split('\n')[0].slice(0, 200) + '\n');
      return Promise.resolve(v);
    }

    return new Promise((resolve) => {
      this.resolver = { resolve, main: style.bold(style.purple(prompt)), cont: style.dim('⋮ '), hidden };
      this.entry.histIdx = this.history.length;
      this.redraw();
    });
  }

  /** Fallback for piped stdin (one-shot scripting; the REPL requires a TTY). */
  readLinePiped() {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      let got = false;
      rl.on('line', (line) => {
        got = true;
        rl.close();
        resolve(line);
      });
      rl.on('close', () => {
        if (!got) resolve(EOF_SYMBOL);
      });
    });
  }

  /** While the agent is running, esc or ctrl-c interrupt the active turn. */
  listenInterrupt(onInterrupt) {
    if (!this.tty) return () => {};
    this.attach();
    this.interruptCb = onInterrupt;
    return () => {
      if (this.interruptCb === onInterrupt) this.interruptCb = null;
    };
  }
}

module.exports = { askQuestion, TerminalInput };
