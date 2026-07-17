#!/usr/bin/env node
// Claude Code hook adapter. Claude Code invokes this with the hook event
// JSON on stdin (see hooks.json) and expects JSON back on stdout.
// Builds a short summary of the event and stores it in hive-memory via MCP.
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
  if (event.tool_name) {
    summary = `${name}: ${event.tool_name}`;
  } else if (event.prompt) {
    summary = `${name}: ${String(event.prompt).slice(0, 200)}`;
  }

  if (isSignificant(name, event)) {
    try {
      await rememberViaMcp({
        agent: 'claude-code',
        project: event.cwd || process.env.HIVE_MEMORY_PROJECT,
        value: summary,
        key: name,
        scope: 'personal',
      });
    } catch (err) {
      console.error('hive-memory capture failed:', err.message);
    }
  }

  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
});
