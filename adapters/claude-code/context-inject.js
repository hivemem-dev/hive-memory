#!/usr/bin/env node
// Claude Code hook adapter. Runs on SessionStart alongside capture.js.
// Pulls the most relevant recent hive-memory entries for this project and
// injects them into the new session via hookSpecificOutput.additionalContext
// (Claude Code SessionStart hook contract - see
// base/docs/public/architecture/hooks.mdx). Graceful degradation: any
// failure (server unreachable, timeout, etc.) falls back to {"continue":
// true} instead of crashing the hook.
'use strict';

const { recallRecentViaMcp } = require('../lib/remember');

const NO_MEMORIES_TEXT = 'No memories yet for this project.';

// Caps on the additionalContext text injected at the start of every new
// session, so a pile-up of memory entries can't silently bloat the prompt.
const MAX_ENTRY_CHARS = 200; // truncate any single bullet's value past this length
const MAX_TOTAL_CHARS = 2000; // ~500 tokens at a rough 4 chars/token estimate

let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', async () => {
  let event = {};
  try {
    event = JSON.parse(input || '{}');
  } catch {
    // non-JSON or empty stdin - nothing to key the lookup on
  }

  // Same fixed-project priority as capture.js - see the comment there.
  const project = process.env.HIVE_MEMORY_PROJECT || event.cwd;

  try {
    const result = await recallRecentViaMcp({ agent: 'claude-code', project, limit: 20 });
    const text = result?.content?.[0]?.text || '';

    if (!text || text === NO_MEMORIES_TEXT) {
      process.stdout.write(JSON.stringify({ continue: true }));
      return;
    }

    const lines = text.split('\n').filter((line) => line.trim());

    const bulletList = [];
    let totalChars = 0;
    let omitted = 0;
    for (let i = 0; i < lines.length; i++) {
      const value = lines[i].length > MAX_ENTRY_CHARS
        ? `${lines[i].slice(0, MAX_ENTRY_CHARS)}…`
        : lines[i];
      const bullet = `- ${value}`;
      const addedChars = bullet.length + (bulletList.length > 0 ? 1 : 0); // +1 for the joining newline
      if (totalChars + addedChars > MAX_TOTAL_CHARS) {
        omitted = lines.length - bulletList.length;
        break;
      }
      bulletList.push(bullet);
      totalChars += addedChars;
    }

    const bullets = bulletList.join('\n');

    let additionalContext = `## Previous context from hive-memory\n\n${bullets}`;
    if (omitted > 0) {
      additionalContext += `\n\n_(${omitted} more entries omitted — budget limit)_`;
    }

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext,
      },
    }));
  } catch (err) {
    console.error('hive-memory context-inject failed:', err.message);
    process.stdout.write(JSON.stringify({ continue: true }));
  }
});
