'use strict';

const fs = require('fs');
const path = require('path');
const { homeDir } = require('./session');
const { DEFAULT_BASE_URL } = require('./llm');
const { DEFAULT_MODEL } = require('./models');
const { normalizeMode } = require('./permissions');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolve configuration with precedence:
 * CLI flags > environment > project .arena/settings.json > ~/.arena-agent/config.json > defaults
 */
function resolveConfig(flags = {}, root = process.cwd()) {
  const globalCfg = readJson(path.join(homeDir(), 'config.json')) || {};
  const projectCfg = readJson(path.join(root, '.arena', 'settings.json')) || {};

  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');

  const baseUrl = pick(flags.baseUrl, process.env.ARENA_BASE_URL, projectCfg.baseUrl, globalCfg.baseUrl, DEFAULT_BASE_URL);
  const apiKey = pick(flags.apiKey, process.env.ARENA_API_KEY, projectCfg.apiKey, globalCfg.apiKey, '');
  const model = pick(flags.model, process.env.ARENA_MODEL, projectCfg.model, globalCfg.model, DEFAULT_MODEL);

  let mode = 'default';
  if (flags.mode) mode = normalizeMode(flags.mode);
  else if (flags.fullAuto) mode = 'fullAuto';
  else if (flags.autoEdit) mode = 'acceptEdits';
  else if (flags.plan) mode = 'plan';
  else if (process.env.ARENA_PERMISSION_MODE) mode = normalizeMode(process.env.ARENA_PERMISSION_MODE);
  else if (projectCfg.permissionMode) mode = normalizeMode(projectCfg.permissionMode);
  else if (globalCfg.permissionMode) mode = normalizeMode(globalCfg.permissionMode);

  return {
    baseUrl,
    apiKey,
    model,
    mode,
    mock: !!(flags.mock || process.env.ARENA_MOCK === '1'),
    verbose: !!flags.verbose,
    maxTurns: Number(pick(flags.maxTurns, process.env.ARENA_MAX_TURNS, projectCfg.maxTurns, globalCfg.maxTurns, 40)),
    temperature: Number(pick(flags.temperature, process.env.ARENA_TEMPERATURE, projectCfg.temperature, globalCfg.temperature, 0.2)),
  };
}

module.exports = { resolveConfig };
