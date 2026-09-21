'use strict';

/**
 * Model registry for the Arena Agent API.
 * Unknown model names fall back to conservative defaults so any
 * OpenAI-compatible endpoint/model can be pointed at this CLI.
 */

const DEFAULT_MODEL = 'arena-agent';

const MODELS = {
  'arena-agent': {
    label: 'Arena Agent (flagship)',
    contextWindow: 200000,
    maxOutputTokens: 16384,
  },
  'arena-agent-fast': {
    label: 'Arena Agent Fast',
    contextWindow: 200000,
    maxOutputTokens: 8192,
  },
  'arena-agent-mini': {
    label: 'Arena Agent Mini',
    contextWindow: 128000,
    maxOutputTokens: 8192,
  },
};

function getModel(name) {
  const m = MODELS[name];
  if (m) return { name, ...m };
  return { name, label: name, contextWindow: 128000, maxOutputTokens: 8192 };
}

module.exports = { DEFAULT_MODEL, MODELS, getModel };
