'use strict';

const tools = [
  require('./read'),
  require('./write'),
  require('./edit'),
  require('./delete'),
  require('./list'),
  require('./search'),
  require('./bash'),
  require('./git'),
  require('./plan'),
];

const byName = new Map(tools.map((t) => [t.name, t]));

function get(name) {
  return byName.get(name);
}

/** Tools excluded from the model's view in plan mode (read-only planning). */
const PLAN_MODE_BLOCKED = new Set(['write_file', 'edit_file', 'delete_file', 'run_command']);

function definitions(mode) {
  const list = mode === 'plan' ? tools.filter((t) => !PLAN_MODE_BLOCKED.has(t.name)) : tools;
  return list.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** Whether a specific tool call is read-only (used by the permission layer). */
function isReadOnlyCall(name, args) {
  const t = byName.get(name);
  if (!t) return false;
  if (typeof t.isReadOnlyCall === 'function') return t.isReadOnlyCall(args);
  return !!t.readOnly;
}

module.exports = { get, definitions, isReadOnlyCall, all: tools };
