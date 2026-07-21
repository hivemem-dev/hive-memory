#!/usr/bin/env node
// Claude Code hook adapter. Claude Code invokes this with the hook event
// JSON on stdin (see hooks.json) and expects JSON back on stdout.
// Builds a short summary of the event and stores it in hive-memory via MCP.
'use strict';

const fs = require('fs');
const { rememberViaMcp } = require('../lib/remember');
const { isSignificant } = require('../lib/significance');

// Tool names whose actual arguments are worth capturing verbatim - without
// this, every PostToolUse row collapsed into the bare tool name ("PostToolUse:
// Bash") with nothing distinguishing one call from the next.
function extractDetail(toolName, toolInput) {
  if (!toolInput) return '';
  if (toolName === 'Bash') {
    return toolInput.command ? String(toolInput.command).slice(0, 300) : '';
  }
  if (['Edit', 'MultiEdit', 'Write'].includes(toolName)) {
    return toolInput.file_path ? String(toolInput.file_path) : '';
  }
  if (toolName === 'NotebookEdit') {
    return toolInput.notebook_path ? String(toolInput.notebook_path) : '';
  }
  return '';
}

// Reads only the tail of the transcript file (session logs can grow large)
// and returns the last assistant text message - the actual substance of what
// the agent just did/said, not just the fact that "Stop" fired.
function readLastAssistantText(transcriptPath, maxBytes = 50000) {
  try {
    const stat = fs.statSync(transcriptPath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);

    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let obj;
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const content = obj?.message?.content;
      if (obj?.type === 'assistant' && Array.isArray(content)) {
        const textBlock = content.find(b => b.type === 'text' && b.text && b.text.trim());
        if (textBlock) return textBlock.text.trim();
      }
    }
  } catch {
    // transcript missing/unreadable - fall back to the bare event name
  }
  return '';
}

function buildSummary(name, event) {
  if (name === 'Stop' && event.transcript_path) {
    const lastText = readLastAssistantText(event.transcript_path);
    if (lastText) return `${name}: ${lastText.slice(0, 500)}`;
  }
  if (event.tool_name) {
    const detail = extractDetail(event.tool_name, event.tool_input);
    return detail ? `${name}: ${event.tool_name} - ${detail}` : `${name}: ${event.tool_name}`;
  }
  if (event.prompt) {
    return `${name}: ${String(event.prompt).slice(0, 200)}`;
  }
  return name;
}

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
  const summary = buildSummary(name, event);

  if (isSignificant(name, event)) {
    try {
      await rememberViaMcp({
        agent: 'claude-code',
        // A stable project identity must come from config, not from
        // event.cwd - the hook's cwd drifts with every `cd`/subprocess a
        // session runs, which used to fragment one workspace's memory
        // across dozens of one-off "projects" (e.g. a temp upload folder
        // visited once). HIVE_MEMORY_PROJECT is set explicitly in
        // hooks.json precisely so this stays fixed.
        project: process.env.HIVE_MEMORY_PROJECT || event.cwd,
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
