#!/usr/bin/env node
// Cursor hook adapter. Cursor invokes this with the hook event JSON on
// stdin (see hooks.json). Builds a short summary of the event and stores
// it in hive-memory via MCP.
'use strict';

const { rememberViaMcp } = require('../lib/remember');
const { isSignificant } = require('../lib/significance');

let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', async () => {
  let event = {};
  try {
    event = JSON.parse(input || '{}');
  } catch {
    // non-JSON or empty stdin - fall back to the event name from argv
  }

  const name = event.hook_event_name || process.argv[2] || 'event';
  let summary = name;
  if (event.command) {
    summary = `${name}: ${event.command}`;
  } else if (event.file_path) {
    summary = `${name}: ${event.file_path}`;
  } else if (event.prompt) {
    summary = `${name}: ${String(event.prompt).slice(0, 200)}`;
  }

  const project = (event.workspace_roots && event.workspace_roots[0]) || process.env.HIVE_MEMORY_PROJECT;

  if (isSignificant(name, event)) {
    try {
      await rememberViaMcp({
        agent: 'cursor',
        project,
        value: summary,
        key: name,
        scope: 'personal',
      });
    } catch (err) {
      console.error('hive-memory capture failed:', err.message);
    }
  }

  // Cursor hooks only look at specific output fields per event (e.g.
  // `continue` for beforeSubmitPrompt); an empty object is a safe no-op
  // for hooks that don't define output fields.
  process.stdout.write(JSON.stringify({ continue: true }));
});
