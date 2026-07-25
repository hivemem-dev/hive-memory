'use strict';

// Tests db.extractQaFixtures / db.verifyRetrieval directly against db.js
// (not through the MCP server) - same rationale as decay.test.js: these are
// reporting functions, not MCP tools, and exercising them needs several
// pre-seeded rows with specific ids/keys that's easiest to set up with
// direct remember() calls.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const dbPath = path.join(os.tmpdir(), `hive-memory-verify-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.HIVE_MEMORY_DB = dbPath;

const { remember, extractQaFixtures, verifyRetrieval, addLink } = require('../db.js');

const project = '/verify-test-project';
const agent = 'claude-code';

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      // ignore missing files
    }
  }
});

test('extractQaFixtures pairs a real question with the Stop row that follows it', () => {
  remember({ scope: 'personal', agent, project, key: 'UserPromptSubmit', value: 'is the widget deploy script safe to delete now that we moved to bin/deploy.sh' });
  remember({ scope: 'personal', agent, project, key: 'PostToolUse', value: 'PostToolUse: Bash - ls scripts/' });
  remember({ scope: 'personal', agent, project, key: 'Stop', value: 'Yes, scripts/deploy.sh is unused now, safe to delete.' });

  const fixtures = extractQaFixtures({ project, agent, sampleSize: 10 });
  assert.equal(fixtures.length, 1);
  assert.match(fixtures[0].question, /safe to delete/);
  assert.match(fixtures[0].answerSnippet, /safe to delete/);
});

test('extractQaFixtures skips short/trivial prompts', () => {
  const dbPath2 = path.join(os.tmpdir(), `hive-memory-verify-test2-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.HIVE_MEMORY_DB = dbPath2;
  delete require.cache[require.resolve('../db.js')];
  const freshDb = require('../db.js');

  freshDb.remember({ scope: 'personal', agent, project: '/short-prompt-test', key: 'UserPromptSubmit', value: 'ok' });
  freshDb.remember({ scope: 'personal', agent, project: '/short-prompt-test', key: 'Stop', value: 'Got it, done.' });

  const fixtures = freshDb.extractQaFixtures({ project: '/short-prompt-test', agent, sampleSize: 10 });
  assert.equal(fixtures.length, 0, 'a 2-char prompt is not a real question, must not become a fixture');

  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath2 + suffix); } catch { /* ignore */ }
  }
  process.env.HIVE_MEMORY_DB = dbPath;
  delete require.cache[require.resolve('../db.js')];
});

test('verifyRetrieval: a question sharing keywords with its answer is found; a near-duplicate question does not steal the slot from answersOnlyRecall', async () => {
  const dbPath3 = path.join(os.tmpdir(), `hive-memory-verify-test3-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.HIVE_MEMORY_DB = dbPath3;
  delete require.cache[require.resolve('../db.js')];
  const freshDb = require('../db.js');
  const p = '/verify-hit-test';

  freshDb.remember({ scope: 'personal', agent, project: p, key: 'UserPromptSubmit', value: 'where does the omniroute cloudflare fallback combo get configured' });
  freshDb.remember({ scope: 'personal', agent, project: p, key: 'Stop', value: 'The omniroute cloudflare fallback combo is configured directly in the database, the setup CLI is broken.' });

  // A near-duplicate re-ask of the same question, textually closer to the
  // original question than the answer is - this is exactly the kind of row
  // that crowded out real answers in the production hit-rate test.
  freshDb.remember({ scope: 'personal', agent, project: p, key: 'UserPromptSubmit', value: 'where is the omniroute cloudflare fallback combo set up again' });

  const report = await freshDb.verifyRetrieval({ project: p, agent, sampleSize: 10, k: 3 });
  assert.equal(report.sampleSize, 1);
  assert.ok(report.answersOnlyRecall.rate >= report.hybridRecall.rate - 1e-9, 'filtering to answer-only rows should never score worse than the raw top-k');

  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath3 + suffix); } catch { /* ignore */ }
  }
  process.env.HIVE_MEMORY_DB = dbPath;
  delete require.cache[require.resolve('../db.js')];
});

test('verifyRetrieval: a distilled fact linked to the raw answer (relation "distills") counts as a hit in its place', async () => {
  const dbPath4 = path.join(os.tmpdir(), `hive-memory-verify-test4-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.HIVE_MEMORY_DB = dbPath4;
  delete require.cache[require.resolve('../db.js')];
  const freshDb = require('../db.js');
  const p = '/verify-distill-test';

  freshDb.remember({ scope: 'personal', agent, project: p, key: 'UserPromptSubmit', value: 'where does the zorbatron fallback config actually live on disk' });
  const answer = freshDb.remember({ scope: 'personal', agent, project: p, key: 'Stop', value: 'The zorbatron fallback config lives in /etc/zorbatron/fallback.yaml, the old docs are wrong.' });
  // A hand-distilled fact carrying the same knowledge, filed as a cleaner
  // shared-scope row rather than the raw captured Stop text.
  const fact = freshDb.remember({ scope: 'shared', agent, project: p, value: 'zorbatron fallback config path: /etc/zorbatron/fallback.yaml (not the old docs location).' });
  freshDb.addLink({ fromId: fact.id, toId: answer.id, relation: 'distills' });

  const report = await freshDb.verifyRetrieval({ project: p, agent, sampleSize: 10, k: 5 });
  assert.equal(report.sampleSize, 1);
  assert.equal(report.results[0].answerId, answer.id);
  // Whichever of {raw answer, distilled fact} actually lands in the top-k,
  // this must count as a hit - a fact standing in for its raw answer is the
  // system working as intended, not a miss.
  assert.equal(report.hybridRecall.hits, 1, 'a linked distilled fact taking the answer\'s slot must still count as a hit');

  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath4 + suffix); } catch { /* ignore */ }
  }
  process.env.HIVE_MEMORY_DB = dbPath;
  delete require.cache[require.resolve('../db.js')];
});

test('verifyRetrieval returns zeroed report when there are no fixtures', async () => {
  const report = await verifyRetrieval({ project: '/nonexistent-verify-project', agent, sampleSize: 10, k: 5 });
  assert.equal(report.sampleSize, 0);
  assert.equal(report.hybridRecall.rate, 0);
  assert.equal(report.recentOnlyRecall.rate, 0);
});
