'use strict';

const VALID = new Set(['pending', 'in_progress', 'done']);

module.exports = {
  name: 'update_plan',
  description:
    'Create or update the visible task plan for multi-step work. Provide the FULL plan each time (it replaces the previous one). Statuses: pending, in_progress, done. Mark exactly one item in_progress while working on it. Use for any task with more than two steps; skip for trivial tasks.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Complete list of plan items.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Short imperative description, e.g. "Add login route".' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  readOnly: true,
  shortDesc() {
    return 'update plan';
  },
  async execute(args, ctx) {
    if (!Array.isArray(args.todos) || args.todos.length === 0) {
      throw new Error('`todos` must be a non-empty array.');
    }
    const cleaned = args.todos.map((t) => ({
      content: String(t.content || '').slice(0, 200),
      status: VALID.has(t.status) ? t.status : 'pending',
    }));
    if (ctx.session) ctx.session.plan = cleaned;
    const done = cleaned.filter((t) => t.status === 'done').length;
    return {
      result: `Plan updated: ${cleaned.length} items (${done} done).`,
      summary: `Plan: ${done}/${cleaned.length} done`,
    };
  },
};
