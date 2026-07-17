'use strict';

// Tests for db.js recallRecent() (direct, like decay.test.js) and for the
// context-inject.js SessionStart hook adapter (spawned end-to-end, like
// cli.test.js/basic.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const CONTEXT_INJECT_PATH = path.join(__dirname, '..', 'adapters', 'claude-code', 'context-inject.js');
const DB_JS_PATH = require.resolve('../db.js');

function mkDbPath() {
  return path.join(os.tmpdir(), `hive-memory-context-inject-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

// Points db.js at a fresh test DB and returns a fresh require of it. db.js
// opens its connection at module load time (module-level `const db = ...`),
// so the cache has to be cleared between test DBs within this one file.
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

// --- db.js recallRecent() ---

test('db.js recallRecent: works without a query, ranks success first, does not bump times_recalled', (t) => {
  const dbPath = mkDbPath();
  t.after(() => cleanupDb(dbPath));

  const { remember, recallRecent, markOutcome } = freshDb(dbPath);
  const project = '/context-inject-db-test-project';

  const a = remember({ scope: 'shared', agent: 'agent-x', project, value: 'first remembered fact' });
  const b = remember({ scope: 'shared', agent: 'agent-x', project, value: 'second remembered fact' });
  markOutcome({ id: a.id, outcome: 'success' });

  const rows1 = recallRecent({ project, agent: 'agent-x', limit: 10 });
  assert.equal(rows1.length, 2, 'both entries should come back with no query at all');
  assert.equal(rows1[0].id, a.id, 'success entry should rank first');

  const before = rows1.find((r) => r.id === b.id).times_recalled;
  recallRecent({ project, agent: 'agent-x', limit: 10 }); // extra call, should not count as a recall
  const rows2 = recallRecent({ project, agent: 'agent-x', limit: 10 });
  const after = rows2.find((r) => r.id === b.id).times_recalled;

  assert.equal(after, before, 'recallRecent must never increment times_recalled');
  assert.equal(after, 0, 'times_recalled should stay at its initial value');
});

test('db.js recallRecent: respects personal/shared visibility like recall()', (t) => {
  const dbPath = mkDbPath();
  t.after(() => cleanupDb(dbPath));

  const { remember, recallRecent } = freshDb(dbPath);
  const project = '/context-inject-visibility-test-project';

  remember({ scope: 'personal', agent: 'agent-a', project, value: 'agent-a private note' });
  remember({ scope: 'shared', agent: 'agent-a', project, value: 'shared note visible to all' });

  const rowsForB = recallRecent({ project, agent: 'agent-b', limit: 10 });
  const values = rowsForB.map((r) => r.value);

  assert.ok(values.includes('shared note visible to all'), 'shared entries should be visible to other agents');
  assert.ok(!values.includes('agent-a private note'), 'personal entries must stay isolated to their own agent');
});

// --- context-inject.js (SessionStart hook adapter) ---

test('context-inject.js: injects additionalContext when memories exist for the project', (t) => {
  const dbPath = mkDbPath();
  t.after(() => cleanupDb(dbPath));

  const { remember } = freshDb(dbPath);
  const project = '/context-inject-integration-project';
  remember({ scope: 'shared', agent: 'claude-code', project, value: 'the deploy uses pm2-runtime in docker' });

  const result = runContextInject({ hook_event_name: 'SessionStart', cwd: project }, dbPath);

  assert.equal(result.status, 0, `context-inject.js exited nonzero. stderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /Previous context from hive-memory/);
  assert.match(output.hookSpecificOutput.additionalContext, /the deploy uses pm2-runtime in docker/);
});

test('context-inject.js: no memories for the project -> valid JSON, no crash, no additionalContext', (t) => {
  const dbPath = mkDbPath();
  t.after(() => cleanupDb(dbPath));

  // Create the DB file (with schema) but leave it empty for this project.
  freshDb(dbPath);
  const project = '/context-inject-empty-project';

  const result = runContextInject({ hook_event_name: 'SessionStart', cwd: project }, dbPath);

  assert.equal(result.status, 0, `context-inject.js exited nonzero. stderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput, undefined, 'no memories should mean no additionalContext injected');
  assert.equal(output.continue, true);
});
