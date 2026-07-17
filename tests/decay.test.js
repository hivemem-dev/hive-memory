'use strict';

// Tests the recall() ranking decay directly against db.js (not through the
// MCP server), since we need to backdate updated_at into the past to
// simulate old, un-recalled records — easier to do with a raw SQL UPDATE
// against the test DB file than by waiting real time or going through the
// public MCP tool surface.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const dbPath = path.join(os.tmpdir(), `hive-memory-decay-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.HIVE_MEMORY_DB = dbPath;

const { remember, recall, markOutcome } = require('../db.js');

const project = '/decay-test-project';
const DAY_MS = 24 * 60 * 60 * 1000;

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      // ignore missing files
    }
  }
});

// Raw connections for backdating rows — internal test setup only, not a
// pattern used by the actual server/tools.
function setUpdatedAt(id, daysAgo) {
  const raw = new Database(dbPath);
  try {
    raw.prepare('UPDATE memory SET updated_at = ? WHERE id = ?').run(Date.now() - daysAgo * DAY_MS, id);
  } finally {
    raw.close();
  }
}

function setTimesRecalled(id, n) {
  const raw = new Database(dbPath);
  try {
    raw.prepare('UPDATE memory SET times_recalled = ? WHERE id = ?').run(n, id);
  } finally {
    raw.close();
  }
}

test('fresh record outranks an equally-recalled old record', () => {
  const fresh = remember({ scope: 'shared', agent: 'a1', project, value: 'decaytest alpha fresh record about widgets' });
  const old = remember({ scope: 'shared', agent: 'a1', project, value: 'decaytest alpha old record about widgets' });

  setTimesRecalled(fresh.id, 5);
  setTimesRecalled(old.id, 5);
  setUpdatedAt(old.id, 90); // 3 half-lives back, decay factor 0.125

  const rows = recall({ query: 'decaytest alpha widgets', project, agent: 'a1', scope: 'shared' });
  const ids = rows.map((r) => r.id);

  assert.ok(ids.includes(fresh.id) && ids.includes(old.id), 'both records should be found');
  assert.ok(ids.indexOf(fresh.id) < ids.indexOf(old.id), 'fresh record should rank above the equally-recalled old one');
});

test('outcome=success beats a fresher outcome=unknown record regardless of decay', () => {
  const success = remember({ scope: 'shared', agent: 'a1', project, value: 'decaytest beta success record about gadgets' });
  const unknown = remember({ scope: 'shared', agent: 'a1', project, value: 'decaytest beta unknown record about gadgets' });

  markOutcome({ id: success.id, outcome: 'success' });
  setUpdatedAt(success.id, 120); // way past several half-lives
  // unknown stays fresh (updated_at = now from remember())

  const rows = recall({ query: 'decaytest beta gadgets', project, agent: 'a1', scope: 'shared' });
  const ids = rows.map((r) => r.id);

  assert.ok(ids.indexOf(success.id) < ids.indexOf(unknown.id), 'success record should rank above a fresher unknown record');
});

test('a never-recalled record is still returned, just ranked below a frequently recalled one', () => {
  const popular = remember({ scope: 'shared', agent: 'a1', project, value: 'decaytest gamma popular record about sprockets' });
  const fresh0 = remember({ scope: 'shared', agent: 'a1', project, value: 'decaytest gamma fresh record about sprockets' });

  setTimesRecalled(popular.id, 20);
  // fresh0 keeps times_recalled = 0

  const rows = recall({ query: 'decaytest gamma sprockets', project, agent: 'a1', scope: 'shared' });
  const ids = rows.map((r) => r.id);

  assert.ok(ids.includes(fresh0.id), 'a never-recalled record must still appear in results');
  assert.ok(ids.indexOf(popular.id) < ids.indexOf(fresh0.id), 'frequently recalled record should rank above a never-recalled one');
});
