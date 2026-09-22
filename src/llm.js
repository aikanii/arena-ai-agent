'use strict';

const pkg = require('../package.json');

const DEFAULT_BASE_URL = 'https://api.preview.arena.ai'; // Arena gateway root (Anthropic protocol; no /v1 suffix)

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.friendly = true;
  }
}

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.friendly = true;
    this.exitCode = 2;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function retryable(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;
  const s = err.status;
  if (s && (s === 408 || s === 429 || s >= 500)) return true;
  if (!s && /fetch failed|network|socket|timeout|ECONN/i.test(err.message || '')) return true;
  return false;
}

/** Combine an external AbortSignal with a timeout. */
function timedSignal(external, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('Request timed out')), ms);
  if (timer.unref) timer.unref();
  const onAbort = () => ctrl.abort(external.reason);
  if (external) {
    if (external.aborted) onAbort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    cleanup() {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onAbort);
    },
  };
}

class LLMClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, apiKey = '', model = 'arena-agent', timeoutMs = 180000 } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  headers() {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey || 'anonymous'}`,
      'user-agent': `arena-agent-cli/${pkg.version}`,
    };
  }

  buildBody({ messages, tools, temperature = 0.2, maxTokens, stream }) {
    const body = {
      model: this.model,
      messages,
      temperature,
      stream: !!stream,
    };
    if (maxTokens) body.max_tokens = maxTokens;
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    return body;
  }

  async rawRequest(path, body, externalSignal) {
    if (!this.apiKey && !/^(127\.0\.0\.1|localhost)/.test(this.baseUrl.replace(/^https?:\/\//, ''))) {
      throw new ConfigError(
        'Missing API key. Set ARENA_API_KEY (or pass --api-key). Use --mock for an offline demo.'
      );
    }
    const { signal, cleanup } = timedSignal(externalSignal, this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        let text = '';
        try {
          text = (await res.text()).slice(0, 500);
        } catch {
          /* ignore */
        }
        const err = new ApiError(
          `Arena Agent API error ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`,
          res.status
        );
        err.bodyText = text;
        throw err;
      }
      return res;
    } finally {
      cleanup();
    }
  }

  /** Non-streaming completion. */
  async chat({ messages, tools, temperature, maxTokens, signal }) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.rawRequest(
          '/chat/completions',
          this.buildBody({ messages, tools, temperature, maxTokens, stream: false }),
          signal
        );
        return await res.json();
      } catch (err) {
        lastErr = err;
        if (!retryable(err) || attempt === 2) throw err;
        await sleep(400 * Math.pow(2, attempt));
      }
    }
    throw lastErr;
  }

  /**
   * Streaming completion. Yields parsed SSE chunks.
   * If the server rejects streaming, transparently falls back to a single
   * non-streaming request and yields it as one synthetic chunk.
   */
  async *stream({ messages, tools, temperature, maxTokens, signal }) {
    let res;
    try {
      res = await this.rawRequest(
        '/chat/completions',
        this.buildBody({ messages, tools, temperature, maxTokens, stream: true }),
        signal
      );
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && /stream/i.test(err.bodyText || '')) {
        const full = await this.chat({ messages, tools, temperature, maxTokens, signal });
        const msg = (full.choices && full.choices[0] && full.choices[0].message) || {};
        yield {
          choices: [
            {
              delta: {
                content: msg.content || '',
                tool_calls: msg.tool_calls,
              },
              finish_reason: 'stop',
            },
          ],
          usage: full.usage,
        };
        return;
      }
      throw err;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (!line || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          try {
            yield JSON.parse(data);
          } catch {
            /* skip malformed keep-alives */
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  async listModels(signal) {
    const { signal: s, cleanup } = timedSignal(signal, 8000);
    try {
      const res = await fetch(this.baseUrl + '/models', { headers: this.headers(), signal: s });
      if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
      return await res.json();
    } finally {
      cleanup();
    }
  }
}

module.exports = { LLMClient, ApiError, ConfigError, DEFAULT_BASE_URL };
