'use strict';

// Tests for the third `global` scope (see db.js): visible to one agent
// across every project (not project-scoped like personal/shared), isolated
// per-agent like personal, and deduped by agent+text regardless of which
// project the write came from.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const dbPath = path.join(os.tmpdir(), `hive-memory-global-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.HIVE_MEMORY_DB = dbPath;

const { remember, recall, recallRecent } = require('../db.js');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      // ignore missing files
    }
  }
});

const projectA = '/global-test/project-a';
const projectB = '/global-test/project-b';

// --- visibility across projects ---

test('global entry written from project A is found via recall() from project B (explicit scope)', () => {
  const written = remember({
    scope: 'global',
    agent: 'agent1',
    project: projectA,
    value: 'globaltestvisibility user prefers terse answers',
  });

  const rows = recall({
    query: 'globaltestvisibility terse',
    project: projectB,
    agent: 'agent1',
    scope: 'global',
  });

  assert.ok(rows.some(r => r.id === written.id), 'global entry should be visible from a different project');
});

test('global entry written from project A is found via recall() from project B (implicit scope)', () => {
  const written = remember({
    scope: 'global',
    agent: 'agent1',
    project: projectA,
    value: 'globaltestimplicit user is a marketer not a developer',
  });

  // no explicit scope -> default visibility should still include this
  // agent's global entries no matter which project is asking
  const rows = recall({
    query: 'globaltestimplicit marketer',
    project: projectB,
    agent: 'agent1',
  });

  assert.ok(rows.some(r => r.id === written.id), 'global entry should be visible by default from a different project');
});

test('global entry written from project A is found via recallRecent() from project B', () => {
  const written = remember({
    scope: 'global',
    agent: 'agent1',
    project: projectA,
    value: 'globaltestrecent user timezone is Europe/Moscow',
  });

  const rows = recallRecent({ project: projectB, agent: 'agent1', limit: 50 });

  assert.ok(rows.some(r => r.id === written.id), 'recallRecent should surface this agent\'s global entries regardless of project');
});

// a personal entry, for contrast, must stay invisible from a different
// project - confirms we didn't accidentally widen personal too
test('personal entry (contrast) stays invisible from a different project', () => {
  const written = remember({
    scope: 'personal',
    agent: 'agent1',
    project: projectA,
    value: 'globaltestcontrastpersonal only visible in project A',
  });

  const rows = recall({
    query: 'globaltestcontrastpersonal',
    project: projectB,
    agent: 'agent1',
  });

  assert.ok(!rows.some(r => r.id === written.id), 'personal entries must remain project-scoped');
});

// --- per-agent isolation ---

test('global entry of one agent is NOT visible to a different agent (explicit scope)', () => {
  const written = remember({
    scope: 'global',
    agent: 'agent-owner',
    project: projectA,
    value: 'globaltestisolation secret preference of agent-owner',
  });

  const rows = recall({
    query: 'globaltestisolation secret',
    project: projectA,
    agent: 'agent-intruder',
    scope: 'global',
  });

  assert.ok(!rows.some(r => r.id === written.id), 'global entries must not leak to other agents');
});

test('global entry of one agent is NOT visible to a different agent (implicit scope)', () => {
  const written = remember({
    scope: 'global',
    agent: 'agent-owner',
    project: projectA,
    value: 'globaltestisolation2 another secret of agent-owner',
  });

  const rows = recall({
    query: 'globaltestisolation2 secret',
    project: projectA,
    agent: 'agent-intruder',
  });

  assert.ok(!rows.some(r => r.id === written.id), 'global entries must not leak to other agents by default either');
});

// --- dedup across projects ---

test('global dedup: same agent, same text, different projects -> single reinforced row', () => {
  const first = remember({
    scope: 'global',
    agent: 'agent-dedup',
    project: projectA,
    value: 'globaltestdedup user always wants code without comments',
  });
  assert.equal(first.deduped, false);

  const second = remember({
    scope: 'global',
    agent: 'agent-dedup',
    // different project, same normalized text (case/whitespace vary)
    project: projectB,
    value: '  Globaltestdedup   user always wants code without comments  ',
  });

  assert.equal(second.deduped, true);
  assert.equal(second.id, first.id, 'should reinforce the same row, not create a new one per project');

  const rows = recall({
    query: 'globaltestdedup comments',
    project: projectB,
    agent: 'agent-dedup',
    scope: 'global',
  });
  const matches = rows.filter(r => r.value.toLowerCase().includes('globaltestdedup'));
  assert.equal(matches.length, 1, 'must not create a duplicate row per project');
});

test('global dedup does not cross agents (contrast)', () => {
  const first = remember({
    scope: 'global',
    agent: 'agent-dedup-a',
    project: projectA,
    value: 'globaltestdedup2 shared-looking text but different agent',
  });
  const second = remember({
    scope: 'global',
    agent: 'agent-dedup-b',
    project: projectA,
    value: 'globaltestdedup2 shared-looking text but different agent',
  });

  assert.equal(second.deduped, false, 'different agents must not dedup against each other');
  assert.notEqual(second.id, first.id);
});
