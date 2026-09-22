'use strict';

const { LLMClient, ApiError } = require('./llm');

/**
 * Provider layer: normalizes the two wire protocols Arena Agent can speak.
 *
 *   - "anthropic" — Anthropic Messages API (what the Arena gateway exposes:
 *                   POST {root}/v1/messages, SSE streaming, tool_use blocks)
 *   - "openai"    — OpenAI-compatible chat completions (mock server and any
 *                   OpenAI-compatible endpoint)
 *
 * Both providers emit the same normalized event stream consumed by agent.js:
 *   { type: 'text', text }
 *   { type: 'toolcall', index, id?, nameDelta?, argsDelta? }
 *   { type: 'usage', promptTokens, completionTokens }
 */

/* ------------------------------------------------------------------ */
/* Protocol detection                                                  */
/* ------------------------------------------------------------------ */

function hostOf(baseUrl) {
  return String(baseUrl || '')
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .toLowerCase();
}

function isArenaHost(baseUrl) {
  return /(^|\.)arena\.ai$/.test(hostOf(baseUrl));
}

function detectProtocol(baseUrl, override) {
  if (override === 'anthropic' || override === 'openai') return override;
  return isArenaHost(baseUrl) ? 'anthropic' : 'openai';
}

/** Dashboard page where Arena API keys are created. */
function keysPageFor(baseUrl) {
  return `https://portal.${hostOf(baseUrl)}/dashboard/keys`;
}

/* ------------------------------------------------------------------ */
/* Message conversion (stored OpenAI-style ⇄ Anthropic)                */
/* ------------------------------------------------------------------ */

function toAnthropicMessages(messages) {
  let system = '';
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system += (system ? '\n\n' : '') + String(m.content || '');
      continue;
    }
    if (m.role === 'user') {
      out.push({ role: 'user', content: String(m.content || '') });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      if (typeof m.content === 'string' && m.content.trim()) {
        blocks.push({ type: 'text', text: m.content });
      }
      for (const tc of m.tool_calls || []) {
        let input = {};
        try {
          input = JSON.parse(tc.function.arguments || '{}');
        } catch {
          input = { _raw: tc.function.arguments };
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: '.' });
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: String(m.content == null ? '' : m.content),
      };
      const last = out[out.length - 1];
      if (
        last &&
        last.role === 'user' &&
        Array.isArray(last.content) &&
        last.content.length &&
        last.content.every((b) => b.type === 'tool_result')
      ) {
        last.content.push(block); // consecutive tool results merge into one user turn
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
  }
  return { system: system || undefined, messages: out };
}

function toAnthropicTools(toolDefs) {
  return toolDefs.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

function textFromAnthropicContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/* ------------------------------------------------------------------ */
/* SSE line parsing shared by both protocols                           */
/* ------------------------------------------------------------------ */

async function* sseEvents(bodyReader) {
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await bodyReader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line || line.startsWith(':') || line.startsWith('event:')) continue;
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data);
      } catch {
        /* skip keep-alives */
      }
    }
  }
}

function timedSignal(external, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('Request timed out')), ms);
  if (timer.unref) timer.unref();
  const onAbort = () => ctrl.abort(external && external.reason);
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function retryable(err) {
  if (!err || err.name === 'AbortError') return false;
  const s = err.status;
  if (s && (s === 408 || s === 429 || s >= 500)) return true;
  if (!s && /fetch failed|network|socket|timeout|ECONN/i.test(err.message || '')) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Anthropic Messages provider (Arena gateway)                         */
/* ------------------------------------------------------------------ */

class AnthropicProvider {
  constructor({ baseUrl, apiKey, model, timeoutMs = 180000 }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, ''); // gateway root — no /v1
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.protocol = 'anthropic';
  }

  headers() {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey || 'anonymous'}`,
      'anthropic-version': '2023-06-01',
      'user-agent': 'arena-agent-cli',
    };
  }

  buildBody({ system, messages, tools, temperature, maxTokens, stream }) {
    const body = {
      model: this.model,
      max_tokens: maxTokens || 16384,
      messages,
      temperature,
      stream: !!stream,
    };
    if (system) body.system = system;
    if (tools && tools.length) body.tools = tools;
    return body;
  }

  async rawPost(path, body, externalSignal) {
    if (!this.apiKey && !/^(127\.0\.0\.1|localhost)/.test(hostOf(this.baseUrl))) {
      const e = new Error('Missing Arena API key. Run `arena login` or set ARENA_API_KEY. Use --mock for an offline demo.');
      e.friendly = true;
      e.exitCode = 2;
      throw e;
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
        throw new ApiError(`Arena gateway error ${res.status}${text ? ` — ${text}` : ''}`, res.status);
      }
      return res;
    } finally {
      cleanup();
    }
  }

  /** Streaming, normalized events. */
  async *streamNormalized({ system, messages, tools, temperature, maxTokens, signal }) {
    const { system: sys, messages: msgs } = toAnthropicMessages([{ role: 'system', content: system }, ...messages]);
    const body = this.buildBody({ system: sys, messages: msgs, tools: toAnthropicTools(tools), temperature, maxTokens, stream: true });

    let res;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await this.rawPost('/v1/messages', body, signal);
        break;
      } catch (err) {
        lastErr = err;
        if (!retryable(err) || attempt === 2) throw err;
        await sleep(400 * Math.pow(2, attempt));
      }
    }
    if (!res) throw lastErr;

    const blockKind = new Map(); // block index → 'text' | 'tool'
    const toolOrdinal = new Map(); // block index → tool-call ordinal
    let toolCount = 0;
    let promptTokens = 0;

    for await (const ev of sseEvents(res.body.getReader())) {
      if (ev.type === 'error') {
        throw new ApiError(`Arena gateway stream error: ${(ev.error && ev.error.message) || 'unknown'}`, 500);
      }
      if (ev.type === 'message_start') {
        promptTokens = (ev.message && ev.message.usage && ev.message.usage.input_tokens) || 0;
        yield { type: 'usage', promptTokens, completionTokens: 0 };
        continue;
      }
      if (ev.type === 'content_block_start') {
        const b = ev.content_block || {};
        if (b.type === 'tool_use') {
          blockKind.set(ev.index, 'tool');
          toolOrdinal.set(ev.index, toolCount);
          yield { type: 'toolcall', index: toolCount, id: b.id, nameDelta: b.name || '', argsDelta: '' };
          toolCount++;
        } else {
          blockKind.set(ev.index, 'text');
        }
        continue;
      }
      if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        if (d.type === 'text_delta' && d.text) yield { type: 'text', text: d.text };
        else if (d.type === 'input_json_delta' && blockKind.get(ev.index) === 'tool') {
          yield { type: 'toolcall', index: toolOrdinal.get(ev.index), argsDelta: d.partial_json || '' };
        }
        continue;
      }
      if (ev.type === 'message_delta') {
        const outTokens = (ev.usage && ev.usage.output_tokens) || 0;
        yield { type: 'usage', promptTokens, completionTokens: outTokens };
        continue;
      }
      // message_stop / content_block_stop / ping — nothing to do
    }
  }

  /** Non-streaming simple completion (compaction, validation). */
  async complete({ system, userText, temperature = 0.1, maxTokens = 4096, signal }) {
    const body = {
      model: this.model,
      max_tokens: maxTokens,
      temperature,
      stream: false,
      messages: [{ role: 'user', content: userText }],
    };
    if (system) body.system = system;
    const res = await this.rawPost('/v1/messages', body, signal);
    const data = await res.json();
    return {
      text: textFromAnthropicContent(data.content),
      usage: {
        prompt_tokens: data.usage ? data.usage.input_tokens : 0,
        completion_tokens: data.usage ? data.usage.output_tokens : 0,
      },
    };
  }

  /** Cheap validity check for doctor / login validation. */
  async ping() {
    try {
      const r = await this.complete({ userText: 'ping', maxTokens: 1, temperature: 0 });
      return { ok: true, detail: `model ${this.model} responded` , usage: r.usage };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }
}

/* ------------------------------------------------------------------ */
/* OpenAI-compatible provider (mock server, custom endpoints)          */
/* ------------------------------------------------------------------ */

class OpenAIProvider {
  constructor({ baseUrl, apiKey, model, timeoutMs = 180000 }) {
    this.client = new LLMClient({ baseUrl, apiKey, model, timeoutMs });
    this.baseUrl = this.client.baseUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.protocol = 'openai';
  }

  async *streamNormalized({ system, messages, tools, temperature, maxTokens, signal }) {
    const full = [{ role: 'system', content: system }, ...messages];
    let promptTokens = 0;
    let completionTokens = 0;
    for await (const chunk of this.client.stream({ messages: full, tools, temperature, maxTokens, signal })) {
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens || promptTokens;
        completionTokens = chunk.usage.completion_tokens || completionTokens;
        yield { type: 'usage', promptTokens, completionTokens };
      }
      const ch = chunk.choices && chunk.choices[0];
      if (!ch) continue;
      const d = ch.delta || {};
      if (typeof d.content === 'string' && d.content.length) yield { type: 'text', text: d.content };
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          yield {
            type: 'toolcall',
            index: Number.isInteger(tc.index) ? tc.index : 0,
            id: tc.id,
            nameDelta: tc.function && tc.function.name,
            argsDelta: tc.function && tc.function.arguments,
          };
        }
      }
    }
  }

  async complete({ system, userText, temperature = 0.1, maxTokens = 4096, signal }) {
    const res = await this.client.chat({
      messages: [
        { role: 'system', content: system || '' },
        { role: 'user', content: userText },
      ],
      temperature,
      maxTokens,
      signal,
    });
    const msg = (res.choices && res.choices[0] && res.choices[0].message) || {};
    return {
      text: msg.content || '',
      usage: res.usage || {},
    };
  }

  async ping() {
    try {
      const models = await this.client.listModels();
      const ids = (models.data || []).map((m) => m.id).slice(0, 8).join(', ') || '(no model list)';
      return { ok: true, detail: ids };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }
}

/* ------------------------------------------------------------------ */

function makeProvider(config) {
  const opts = { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, timeoutMs: 180000 };
  return config.provider === 'anthropic' ? new AnthropicProvider(opts) : new OpenAIProvider(opts);
}

module.exports = {
  AnthropicProvider,
  OpenAIProvider,
  makeProvider,
  detectProtocol,
  isArenaHost,
  keysPageFor,
  toAnthropicMessages,
  toAnthropicTools,
  textFromAnthropicContent,
};
