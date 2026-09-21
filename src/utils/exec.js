'use strict';

const { spawn, spawnSync } = require('child_process');

/**
 * Run a binary (no shell) and capture output with caps and a timeout.
 * Returns { code, stdout, stderr, timedOut, error }.
 */
function execCapture(cmd, args, { cwd, timeoutMs = 30000, maxBytes = 60000, env } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;

    const child = spawn(cmd, args, {
      cwd,
      env: env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      if (outBytes < maxBytes) {
        stdout += d.toString();
        outBytes += d.length;
      }
    });
    child.stderr.on('data', (d) => {
      if (errBytes < maxBytes) {
        stderr += d.toString();
        errBytes += d.length;
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, error: err.message });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outBytes > maxBytes) stdout += `\n…[stdout truncated at ${maxBytes} bytes]`;
      if (errBytes > maxBytes) stderr += `\n…[stderr truncated at ${maxBytes} bytes]`;
      resolve({ code, stdout, stderr, timedOut, error: null });
    });
  });
}

/** Synchronous variant for cheap git probes at startup. */
function execCaptureSync(cmd, args, { cwd, timeoutMs = 5000 } = {}) {
  try {
    const r = spawnSync(cmd, args, { cwd, timeout: timeoutMs, encoding: 'utf8' });
    if (r.error) return null;
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  } catch {
    return null;
  }
}

module.exports = { execCapture, execCaptureSync };
