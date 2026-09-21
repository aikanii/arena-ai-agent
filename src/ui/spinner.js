'use strict';

const { style } = require('./ansi');

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Tiny spinner. On non-TTY output it degrades to a single log line so
 * piped/scripted runs still get meaningful output without cursor noise.
 */
class Spinner {
  constructor(text = '') {
    this.text = text;
    this.timer = null;
    this.i = 0;
    this.active = false;
  }

  get tty() {
    return !!process.stdout.isTTY;
  }

  start(text) {
    if (text) this.text = text;
    if (this.active) return this;
    this.active = true;
    if (!this.tty) {
      if (this.text) process.stdout.write(this.text + '\n');
      return this;
    }
    this.timer = setInterval(() => this.render(), 80);
    if (this.timer.unref) this.timer.unref();
    this.render();
    return this;
  }

  update(text) {
    this.text = text;
    if (!this.active) return this.start(text);
    if (this.tty) this.render();
    return this;
  }

  render() {
    const frame = FRAMES[this.i++ % FRAMES.length];
    process.stdout.write(`\r\x1b[2K${style.cyan(frame)} ${style.dim(this.text)}`);
  }

  stop(finalText) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.active = false;
    if (this.tty) process.stdout.write('\r\x1b[2K');
    if (finalText) process.stdout.write(finalText + '\n');
    return this;
  }
}

module.exports = { Spinner };
