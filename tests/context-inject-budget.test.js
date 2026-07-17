'use strict';

// Tests for the additionalContext character budget in context-inject.js:
// MAX_ENTRY_CHARS (per-bullet truncation) and MAX_TOTAL_CHARS (overall cap
// with an "N more entries omitted" trailer). Same spawn-the-hook approach as
// tests/context-inject.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const CONTEXT_INJECT_PATH = path.join(__dirname, '..', 'adapters', 'claude-code', 'context-inject.js');
const DB_JS_PATH = require.resolve('../db.js');

const MAX_ENTRY_CHARS = 200;
const MAX_TOTAL_CHARS = 2000;

function mkDbPath() {
  return path.join(os.tmpdir(), `hive-memory-context-inject-budget-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      // ignore missing files
    }
  }
}

function freshDb(dbPath) {
  process.env.HIVE_MEMORY_DB = dbPath;
  delete require.cache[DB_JS_PATH];
  return require('../db.js');
}

function runContextInject(event, dbPath) {
  const env = { ...process.env, HIVE_MEMORY_DB: dbPath };
  return spawnSync('node', [CONTEXT_INJECT_PATH], {
    input: JSON.stringify(event),
    env,
    encoding: 'utf8',
  });
}

test('context-inject.js: truncates a single very long entry to MAX_ENTRY_CHARS with an ellipsis', (t) => {
  const dbPath = mkDbPath();
  t.after(() => cleanupDb(dbPath));

  const { remember } = freshDb(dbPath);
  const project = '/context-inject-budget-long-entry-project';
  const longValue = 'x'.repeat(500); // well past MAX_ENTRY_CHARS
  remember({ scope: 'shared', agent: 'claude-code', project, value: longValue });

  const result = runContextInject({ hook_event_name: 'SessionStart', cwd: project }, dbPath);

  assert.equal(result.status, 0, `context-inject.js exited nonzero. stderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout);
  const ctx = output.hookSpecificOutput.additionalContext;

  assert.ok(!ctx.includes(longValue), 'the full untruncated value should not appear in the output');
  assert.match(ctx, /…$/, 'truncated line should end with an ellipsis');

  // The rendered line is "#id [scope/agent] value" - MAX_ENTRY_CHARS caps
  // the whole rendered line, so the bullet's line content (minus the "- "
  // prefix and the trailing ellipsis) must be exactly MAX_ENTRY_CHARS chars.
  const bulletLine = ctx.split('\n').find((l) => l.startsWith('- #1'));
  assert.ok(bulletLine, 'expected the bullet for entry #1 to be present');
  const lineContent = bulletLine.slice(2); // strip the "- " bullet marker
  assert.equal(lineContent.length, MAX_ENTRY_CHARS + 1, 'line should be MAX_ENTRY_CHARS chars plus the ellipsis character');
  assert.ok(!/more entries omitted/.test(ctx), 'a single truncated entry should not trigger the omitted-entries trailer');
});

test('context-inject.js: many short entries exceeding MAX_TOTAL_CHARS get cut off with an omitted-count trailer', (t) => {
  const dbPath = mkDbPath();
  t.after(() => cleanupDb(dbPath));

  const { remember } = freshDb(dbPath);
  const project = '/context-inject-budget-many-entries-project';

  // Each entry ~100 chars, well under MAX_ENTRY_CHARS but 20 of them push
  // the total comfortably past MAX_TOTAL_CHARS (2000).
  const entryCount = 20;
  for (let i = 0; i < entryCount; i++) {
    remember({
      scope: 'shared',
      agent: 'claude-code',
      project,
      value: `entry number ${i} - ${'y'.repeat(90)}`,
    });
  }

  const result = runContextInject({ hook_event_name: 'SessionStart', cwd: project }, dbPath);

  assert.equal(result.status, 0, `context-inject.js exited nonzero. stderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout);
  const ctx = output.hookSpecificOutput.additionalContext;

  const trailerMatch = ctx.match(/_\((\d+) more entries omitted — budget limit\)_/);
  assert.ok(trailerMatch, 'output should contain the omitted-entries trailer');
  const omittedCount = Number(trailerMatch[1]);
  assert.ok(omittedCount > 0, 'omitted count should be greater than zero');

  // Sanity: content before the trailer should stay within budget.
  const beforeTrailer = ctx.slice(0, ctx.indexOf(trailerMatch[0]));
  assert.ok(beforeTrailer.length <= MAX_TOTAL_CHARS + '## Previous context from hive-memory\n\n'.length + 10,
    'text preceding the trailer should respect the total character budget (with small header slack)');

  const bulletCount = (ctx.match(/^- /gm) || []).length;
  assert.ok(bulletCount < entryCount, 'fewer bullets than entries created should appear due to the budget cutoff');
  assert.equal(bulletCount + omittedCount, entryCount, 'shown bullets plus omitted count should equal total entries');
});

test('context-inject.js: a few short entries within budget produce no omitted-entries trailer', (t) => {
  const dbPath = mkDbPath();
  t.after(() => cleanupDb(dbPath));

  const { remember } = freshDb(dbPath);
  const project = '/context-inject-budget-small-project';

  remember({ scope: 'shared', agent: 'claude-code', project, value: 'short fact one' });
  remember({ scope: 'shared', agent: 'claude-code', project, value: 'short fact two' });
  remember({ scope: 'shared', agent: 'claude-code', project, value: 'short fact three' });

  const result = runContextInject({ hook_event_name: 'SessionStart', cwd: project }, dbPath);

  assert.equal(result.status, 0, `context-inject.js exited nonzero. stderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout);
  const ctx = output.hookSpecificOutput.additionalContext;

  assert.ok(!/more entries omitted/.test(ctx), 'small entry sets within budget should not show the omitted trailer');
  assert.match(ctx, /short fact one/);
  assert.match(ctx, /short fact two/);
  assert.match(ctx, /short fact three/);
});
