'use strict';

// Tests for the human-facing cli.js `list` / `search` commands and the
// db.js `listAll()` they're built on. These are admin/debugging commands
// run directly by a person at a terminal (not through the MCP protocol),
// so listAll() intentionally does no agent-isolation filtering - see the
// comment on listAll() in db.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const dbPath = path.join(os.tmpdir(), `hive-memory-cliviewer-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.HIVE_MEMORY_DB = dbPath;

const { remember, listAll } = require('../db.js');

const CLI_PATH = path.join(__dirname, '..', 'cli.js');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      // ignore missing files
    }
  }
});

const projectA = '/cli-viewer-test/project-a';
const projectB = '/cli-viewer-test/project-b';

// Seed a small, deterministic dataset once for the whole file.
const seeded = {
  sharedA: remember({ scope: 'shared', agent: 'agentX', project: projectA, value: 'cliviewer shared note about widgets in project A' }),
  personalA_X: remember({ scope: 'personal', agent: 'agentX', project: projectA, value: 'cliviewer personal note of agentX in project A' }),
  personalA_Y: remember({ scope: 'personal', agent: 'agentY', project: projectA, value: 'cliviewer personal note of agentY in project A' }),
  sharedB: remember({ scope: 'shared', agent: 'agentX', project: projectB, value: 'cliviewer shared note about gadgets in project B' }),
  globalX: remember({ scope: 'global', agent: 'agentX', project: projectA, value: 'cliviewer global note of agentX, any project' }),
};

// --- db.listAll() direct tests ---

test('listAll(): no filters returns every entry', () => {
  const rows = listAll({ limit: 100 });
  const ids = rows.map(r => r.id);
  for (const key of Object.keys(seeded)) {
    assert.ok(ids.includes(seeded[key].id), `expected ${key} in unfiltered listAll()`);
  }
});

test('listAll(): filter by project only returns that project\'s rows', () => {
  const rows = listAll({ project: projectB, limit: 100 });
  const ids = rows.map(r => r.id);
  assert.ok(ids.includes(seeded.sharedB.id));
  assert.ok(!ids.includes(seeded.sharedA.id));
  assert.ok(!ids.includes(seeded.globalX.id), 'global row was written with project A, filtering by project B excludes it (listAll has no cross-project global semantics, it is a raw column filter)');
});

test('listAll(): filter by scope only returns all agents/projects for that scope', () => {
  const rows = listAll({ scope: 'personal', limit: 100 });
  const ids = rows.map(r => r.id);
  assert.ok(ids.includes(seeded.personalA_X.id));
  assert.ok(ids.includes(seeded.personalA_Y.id), 'listAll has no agent isolation - both agents\' personal rows are visible');
  assert.ok(!ids.includes(seeded.sharedA.id));
});

test('listAll(): filter by agent only returns all scopes/projects for that agent', () => {
  const rows = listAll({ agent: 'agentY', limit: 100 });
  const ids = rows.map(r => r.id);
  assert.ok(ids.includes(seeded.personalA_Y.id));
  assert.equal(rows.every(r => r.agent === 'agentY'), true);
});

test('listAll(): combined filters narrow correctly', () => {
  const rows = listAll({ project: projectA, scope: 'personal', agent: 'agentX', limit: 100 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, seeded.personalA_X.id);
});

test('listAll(): limit is respected', () => {
  const rows = listAll({ limit: 2 });
  assert.equal(rows.length, 2);
});

// --- cli.js list / search as a real spawned process ---

function runCli(args) {
  return spawnSync('node', [CLI_PATH, ...args], {
    env: { ...process.env, HIVE_MEMORY_DB: dbPath },
    encoding: 'utf8',
  });
}

test('cli.js list: prints a row per entry with expected columns', () => {
  const result = runCli(['list', '--project', projectA, '--limit', '50']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cliviewer shared note about widgets/);
  assert.match(result.stdout, /cliviewer personal note of agentX/);
  assert.match(result.stdout, /cliviewer global note of agentX/);
  assert.doesNotMatch(result.stdout, /cliviewer shared note about gadgets/, 'project B row should be excluded by --project filter');
});

test('cli.js list: --scope filter works', () => {
  const result = runCli(['list', '--scope', 'global', '--limit', '50']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cliviewer global note of agentX/);
  assert.doesNotMatch(result.stdout, /cliviewer shared note/);
});

test('cli.js list: no entries -> friendly message, exit 0', () => {
  const result = runCli(['list', '--project', '/nonexistent-project-xyz']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No entries found/);
});

test('cli.js search: finds entries across agents/scopes for the given project (admin view)', () => {
  const result = runCli(['search', 'cliviewer', '--project', projectA, '--limit', '50']);
  assert.equal(result.status, 0, result.stderr);
  // admin search should surface shared + personal (any agent) + global for
  // this project, since there's no single "current agent" at a terminal
  assert.match(result.stdout, /cliviewer shared note about widgets/);
  assert.match(result.stdout, /cliviewer personal note of agentX/);
  assert.match(result.stdout, /cliviewer personal note of agentY/);
  assert.match(result.stdout, /cliviewer global note of agentX/);
});

test('cli.js search: missing query -> usage error, exit 1', () => {
  const result = runCli(['search']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: node cli\.js search/);
});

test('cli.js: usage text mentions list and search', () => {
  const result = spawnSync('node', [CLI_PATH], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /list/);
  assert.match(result.stdout, /search/);
});
