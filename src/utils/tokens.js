'use strict';

/** Rough token estimate (~4 chars per token) used for context budgeting. */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

function estimateMessageTokens(msg) {
  let chars = 4; // per-message overhead
  if (typeof msg.content === 'string') chars += msg.content.length;
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      chars += (tc.function?.name || '').length + (tc.function?.arguments || '').length + 8;
    }
  }
  if (msg.role) chars += msg.role.length;
  return Math.ceil(chars / 4);
}

function estimateMessagesTokens(messages) {
  return messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
}

module.exports = { estimateTokens, estimateMessageTokens, estimateMessagesTokens };
