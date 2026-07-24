'use strict';

// Regression test for the noise fix found via `node cli.js verify`: raw
// UserPromptSubmit hook-capture rows must never come back as a recall
// result (a re-asked question's closest match was almost always another
// stored question, crowding out the real answer) - but this must NOT
// silently exclude ordinary remembered facts, which are stored with
// key = NULL. See EXCLUDE_PROMPTS_CLAUSE in db.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const dbPath = path.join(os.tmpdir(), `hive-memory-exclude-prompts-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.HIVE_MEMORY_DB = dbPath;

const { remember, recall, recallHybrid } = require('../db.js');

const project = '/exclude-prompts-test';
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

test('recall() never returns a key=UserPromptSubmit row, even when it is the closest keyword match', () => {
  remember({ scope: 'personal', agent, project, key: 'UserPromptSubmit', value: 'omniroute cloudflare fallback combo where is it configured' });
  remember({ scope: 'personal', agent, project, key: 'Stop', value: 'The omniroute cloudflare fallback combo lives in the database, set up via direct writes since the CLI is broken.' });
  remember({ scope: 'personal', agent, project, key: 'UserPromptSubmit', value: 'omniroute cloudflare fallback combo where is it set up again' });

  const rows = recall({ query: 'omniroute cloudflare fallback combo', project, agent, limit: 5 });
  assert.ok(rows.length > 0, 'the Stop answer should still be found');
  assert.ok(rows.every(r => r.key !== 'UserPromptSubmit'), 'no UserPromptSubmit row should ever appear in recall results');
  assert.ok(rows.some(r => r.key === 'Stop'), 'the real Stop answer must be among the results');
});

test('recall() still returns ordinary remembered facts with key = NULL (not swallowed by the exclusion)', () => {
  const r = remember({ scope: 'shared', agent, project: project + '-facts', value: 'the staging redis instance is separate from prod' });
  assert.equal(r.deduped, false);

  const rows = recall({ query: 'staging redis instance', project: project + '-facts', agent, limit: 5 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, r.id);
});

test('recallHybrid() also excludes UserPromptSubmit rows from its fused results', async () => {
  const p = project + '-hybrid';
  remember({ scope: 'personal', agent, project: p, key: 'UserPromptSubmit', value: 'is the widget deploy pipeline still using the old bin path' });
  const answer = remember({ scope: 'personal', agent, project: p, key: 'Stop', value: 'No, the widget deploy pipeline was moved to bin/deploy.sh last week.' });

  const rows = await recallHybrid({ query: 'widget deploy pipeline old bin path', project: p, agent, limit: 5 });
  assert.ok(rows.every(r => r.key !== 'UserPromptSubmit'));
  assert.ok(rows.some(r => r.id === answer.id));
});
