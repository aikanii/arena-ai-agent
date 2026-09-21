'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { homeDir } = require('./session');

const CLIENT_ID = 'arena-agent-cli';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/**
 * baseUrl points at the API version root (…/v1). OAuth + account endpoints
 * live at the service root, so strip a trailing version segment.
 */
function serviceRoot(baseUrl) {
  return String(baseUrl).replace(/\/+$/, '').replace(/\/v\d+$/, '');
}

/* ------------------------------------------------------------------ */
/* Credential store (~/.arena-agent/auth.json, chmod 600)              */
/* ------------------------------------------------------------------ */

function authPath() {
  return path.join(homeDir(), 'auth.json');
}

function loadCredentials() {
  try {
    return JSON.parse(fs.readFileSync(authPath(), 'utf8'));
  } catch {
    return null;
  }
}

function saveCredentials(creds) {
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(authPath(), JSON.stringify(creds, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(authPath(), 0o600);
  } catch {
    /* best effort */
  }
}

function clearCredentials() {
  try {
    fs.unlinkSync(authPath());
    return true;
  } catch {
    return false;
  }
}

/** Token from a previous `arena login`, if it applies to this endpoint. */
function getStoredToken(baseUrl) {
  const c = loadCredentials();
  if (!c || !c.accessToken) return null;
  if (c.endpoint && baseUrl && c.endpoint !== baseUrl) return null; // signed in against a different endpoint
  return c.accessToken;
}

/* ------------------------------------------------------------------ */
/* Small fetch helper                                                  */
/* ------------------------------------------------------------------ */

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* OAuth 2.0 Device Authorization Grant (RFC 8628)                     */
/* ------------------------------------------------------------------ */

class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
    this.friendly = true;
  }
}

/**
 * Step 1 — request a device code.
 * Returns { device_code, user_code, verification_uri, verification_uri_complete?, interval, expires_in }.
 */
async function requestDeviceCode(baseUrl) {
  const url = serviceRoot(baseUrl);
  let res;
  try {
    res = await fetchWithTimeout(url + '/oauth/device/code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, scope: 'agent:full' }),
    });
  } catch (err) {
    throw new AuthError(`Could not reach ${url}/oauth/device/code — ${err.message}. Check your network / ARENA_BASE_URL.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.device_code) {
    throw new AuthError(`Device authorization failed (${res.status}${data.error_description ? ': ' + data.error_description : ''}).`);
  }
  return data;
}

/**
 * Step 2 — poll the token endpoint until the user approves (or denies/expires).
 * Calls onStatus(stage) with 'pending' | 'slow_down' for UI feedback.
 * Returns the raw token response { access_token, refresh_token?, expires_in?, ... }.
 */
async function pollForToken(baseUrl, deviceData, onStatus = () => {}) {
  const url = serviceRoot(baseUrl);
  let interval = Math.max(1, Number(deviceData.interval) || 5) * 1000;
  const deadline = Date.now() + (Number(deviceData.expires_in) || 600) * 1000;

  for (;;) {
    if (Date.now() > deadline) {
      throw new AuthError('The sign-in code expired before approval. Run `arena login` again.');
    }
    await new Promise((r) => setTimeout(r, interval));

    let res;
    try {
      res = await fetchWithTimeout(
        url + '/oauth/token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ grant_type: DEVICE_GRANT, device_code: deviceData.device_code, client_id: CLIENT_ID }),
        },
        20000
      );
    } catch {
      onStatus('network'); // transient: keep polling
      continue;
    }

    const body = await res.json().catch(() => ({}));
    if (res.ok && body.access_token) return body;

    switch (body.error) {
      case 'authorization_pending':
        onStatus('pending');
        continue;
      case 'slow_down':
        interval += 5000;
        onStatus('slow_down');
        continue;
      case 'access_denied':
        throw new AuthError('Authorization was denied in the browser.');
      case 'expired_token':
        throw new AuthError('The sign-in code expired. Run `arena login` again.');
      default:
        throw new AuthError(`OAuth error: ${body.error || res.status}${body.error_description ? ' — ' + body.error_description : ''}`);
    }
  }
}

/**
 * Full device login: request code → (caller shows instructions) → poll → credentials.
 * `onDeviceCode(deviceData)` is invoked right after the code is issued so the
 * UI can render it before polling starts.
 */
async function deviceLogin(baseUrl, { onDeviceCode } = {}) {
  const deviceData = await requestDeviceCode(baseUrl);
  if (onDeviceCode) await onDeviceCode(deviceData);
  const tokens = await pollForToken(baseUrl, deviceData);
  const creds = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
    tokenType: tokens.token_type || 'Bearer',
    endpoint: baseUrl.replace(/\/+$/, ''),
    obtainedAt: new Date().toISOString(),
    account: tokens.account || null,
  };
  return creds;
}

/** Best-effort account lookup for a token. */
async function fetchAccount(baseUrl, accessToken) {
  try {
    const res = await fetchWithTimeout(serviceRoot(baseUrl) + '/me', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* OS helpers: browser + clipboard                                     */
/* ------------------------------------------------------------------ */

function openUrl(url) {
  try {
    let cmd;
    let args;
    if (process.platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else if (process.platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '', url.replace(/&/g, '^&')];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function copyToClipboard(text) {
  const candidates =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'win32'
        ? [['clip', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ];
  for (const [cmd, args] of candidates) {
    try {
      const r = require('child_process').spawnSync(cmd, args, {
        input: text,
        stdio: ['pipe', 'ignore', 'ignore'],
        timeout: 3000,
      });
      if (r.status === 0) return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

module.exports = {
  CLIENT_ID,
  AuthError,
  authPath,
  loadCredentials,
  saveCredentials,
  clearCredentials,
  getStoredToken,
  deviceLogin,
  fetchAccount,
  serviceRoot,
  openUrl,
  copyToClipboard,
};
