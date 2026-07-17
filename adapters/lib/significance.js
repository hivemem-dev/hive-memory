'use strict';
// Cheap significance filter for hook events, applied before rememberViaMcp.
// No AI calls - plain heuristics on event names/fields, so noisy read-only
// tool calls (Read/Grep/Glob/...) don't flood memory with junk entries.

// Claude Code PostToolUse: tool names that represent a real change.
const SIGNIFICANT_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'Bash', 'NotebookEdit']);

// Rare, low-volume events that are always worth recording.
const ALWAYS_SIGNIFICANT_EVENTS = new Set([
  'UserPromptSubmit', // Claude Code
  'SessionStart', // Claude Code
  'Stop', // Claude Code
  'beforeSubmitPrompt', // Cursor
  'stop', // Cursor
]);

function hasErrorSignal(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.tool_response && (event.tool_response.isError === true || event.tool_response.error)) {
    return true;
  }
  if (event.error) return true;
  return false;
}

function isSignificant(hookEventName, event) {
  if (ALWAYS_SIGNIFICANT_EVENTS.has(hookEventName)) return true;

  if (hookEventName === 'PostToolUse') {
    if (hasErrorSignal(event)) return true;
    return SIGNIFICANT_TOOL_NAMES.has(event && event.tool_name);
  }

  if (hookEventName === 'afterFileEdit') {
    // Cursor only fires this after a real file edit already happened.
    return true;
  }

  if (hookEventName === 'afterShellExecution') {
    // cursor-hooks-reference.md documents only command/output/duration for
    // this event - no error/exit-code field to check. Treat like Bash:
    // a real shell execution, always significant.
    return true;
  }

  // Unknown event name: fail safe to significant rather than silently
  // dropping something that might matter.
  return true;
}

module.exports = { isSignificant };
