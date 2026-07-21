'use strict';

// FTS5's default operator between space-separated terms is AND - a query
// where even one word doesn't appear verbatim used to return zero results.
// recall() now retries with OR-joined terms when the strict AND match finds
// nothing, so a partial word overlap still surfaces something.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const dbPath = path.join(os.tmpdir(), `hive-memory-fts-fallback-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.HIVE_MEMORY_DB = dbPath;

const { remember, recall } = require('../db.js');

const project = '/fts-fallback-test-project';

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      // ignore missing files
    }
  }
});

test('recall(): a query where every word matches verbatim (AND) still works as before', () => {
  remember({ scope: 'shared', agent: 'a1', project, value: 'ftsfallback alpha bravo charlie' });

  const rows = recall({ query: 'ftsfallback alpha bravo', project, agent: 'a1', limit: 5 });
  assert.ok(rows.some(r => r.value.includes('ftsfallback alpha bravo charlie')));
});

test('recall(): a query with one word absent from the text falls back to OR and still finds it', () => {
  remember({ scope: 'shared', agent: 'a1', project, value: 'ftsfallback delta echo about widgets' });

  // "foxtrot" appears nowhere in the stored text - a strict AND match would
  // find zero rows; the OR fallback should still surface it via the other words.
  const rows = recall({ query: 'ftsfallback foxtrot echo', project, agent: 'a1', limit: 5 });
  assert.ok(
    rows.some(r => r.value.includes('ftsfallback delta echo about widgets')),
    'OR fallback should surface the row via the words that do match'
  );
});

test('recall(): a query sharing no words with anything stored still returns nothing (not everything)', () => {
  remember({ scope: 'shared', agent: 'a1', project, value: 'ftsfallback golf hotel about sprockets' });

  const rows = recall({ query: 'zzznomatch1 zzznomatch2', project, agent: 'a1', limit: 5 });
  assert.equal(rows.length, 0, 'the OR fallback must not degrade into matching everything');
});
