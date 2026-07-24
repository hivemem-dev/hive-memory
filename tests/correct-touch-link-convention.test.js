'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');

// Same spawn-and-handshake helper as basic.test.js - kept duplicated per the
// existing per-file pattern in this test suite rather than introducing a
// shared module.
function callTool(env, toolName, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });

    let buffer = '';
    let stderr = '';
    let awaitingCallResult = false;

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP call to ${toolName} timed out. stderr: ${stderr}`));
    }, 10000);

    function send(msg) {
      child.stdin.write(JSON.stringify(msg) + '\n');
    }

    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;

        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }

        if (!awaitingCallResult && msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: toolName, arguments: args },
          });
          awaitingCallResult = true;
        } else if (awaitingCallResult && msg.id === 2) {
          clearTimeout(timer);
          child.stdin.end();
          child.kill();
          const text = msg.result?.content?.[0]?.text ?? '';
          resolve(text);
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'hive-memory-test', version: '0.1.0' },
      },
    });
  });
}

function freshEnv(project) {
  const dbPath = path.join(os.tmpdir(), `hive-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return {
    env: { ...process.env, HIVE_MEMORY_AGENT: 'agent-1', HIVE_MEMORY_PROJECT: project, HIVE_MEMORY_DB: dbPath, HIVE_MEMORY_LIGHTWEIGHT: '1' },
    dbPath,
  };
}

function cleanupDb(t, dbPath) {
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // ignore missing files
      }
    }
  });
}

test('memory_correct fixes a stored entry in place, no duplicate row', async (t) => {
  const { env, dbPath } = freshEnv('/correct-test-project');
  cleanupDb(t, dbPath);

  const stored = await callTool(env, 'memory_remember', { value: 'the deploy script lives in scripts/deploy.sh', scope: 'shared' });
  const id = stored.match(/id (\d+)/)[1];

  const corrected = await callTool(env, 'memory_correct', { id: Number(id), value: 'the deploy script lives in bin/deploy.sh' });
  assert.equal(corrected, `Corrected #${id}`);

  const recalled = await callTool(env, 'memory_recall', { query: 'deploy script' });
  assert.match(recalled, /bin\/deploy\.sh/);
  assert.doesNotMatch(recalled, /scripts\/deploy\.sh/);

  const Database = require('better-sqlite3');
  const raw = new Database(dbPath, { readonly: true });
  try {
    const rows = raw.prepare('SELECT id FROM memory WHERE project = ?').all('/correct-test-project');
    assert.equal(rows.length, 1, 'correct must not create a second row');
  } finally {
    raw.close();
  }
});

test('memory_correct on an unknown id reports an error, does not throw', async (t) => {
  const { env, dbPath } = freshEnv('/correct-missing-test');
  cleanupDb(t, dbPath);

  const result = await callTool(env, 'memory_correct', { id: 999999, value: 'whatever' });
  assert.match(result, /No entry with id 999999/);
});

test('memory_touch bumps times_recalled without changing the text', async (t) => {
  const { env, dbPath } = freshEnv('/touch-test-project');
  cleanupDb(t, dbPath);

  const stored = await callTool(env, 'memory_remember', { value: 'the staging env uses a separate redis instance', scope: 'shared' });
  const id = stored.match(/id (\d+)/)[1];

  const result = await callTool(env, 'memory_touch', { id: Number(id) });
  assert.equal(result, `Confirmed #${id} still relevant`);

  const Database = require('better-sqlite3');
  const raw = new Database(dbPath, { readonly: true });
  try {
    const row = raw.prepare('SELECT value, times_recalled FROM memory WHERE id = ?').get(Number(id));
    assert.equal(row.value, 'the staging env uses a separate redis instance');
    assert.equal(row.times_recalled, 1);
  } finally {
    raw.close();
  }
});

test('memory_link connects two entries and both directions show it on recall', async (t) => {
  const { env, dbPath } = freshEnv('/link-test-project');
  cleanupDb(t, dbPath);

  const a = await callTool(env, 'memory_remember', { value: 'auth middleware started returning 429s under load', scope: 'shared' });
  const b = await callTool(env, 'memory_remember', { value: 'fixed by adding a Cloudflare fallback combo for auth', scope: 'shared' });
  const idA = a.match(/id (\d+)/)[1];
  const idB = b.match(/id (\d+)/)[1];

  const linkResult = await callTool(env, 'memory_link', { from_id: Number(idA), to_id: Number(idB), relation: 'fixed-by' });
  assert.equal(linkResult, `Linked #${idA} -> #${idB} (fixed-by)`);

  const recallA = await callTool(env, 'memory_recall', { query: '429s under load' });
  assert.match(recallA, new RegExp(`-> fixed-by #${idB}`));

  const recallB = await callTool(env, 'memory_recall', { query: 'Cloudflare fallback combo' });
  assert.match(recallB, new RegExp(`<- fixed-by #${idA}`));
});

test('memory_link is idempotent for the same from/to/relation triple', async (t) => {
  const { env, dbPath } = freshEnv('/link-dedup-test');
  cleanupDb(t, dbPath);

  const a = await callTool(env, 'memory_remember', { value: 'link dedup entry one', scope: 'shared' });
  const b = await callTool(env, 'memory_remember', { value: 'link dedup entry two', scope: 'shared' });
  const idA = a.match(/id (\d+)/)[1];
  const idB = b.match(/id (\d+)/)[1];

  await callTool(env, 'memory_link', { from_id: Number(idA), to_id: Number(idB), relation: 'relates-to' });
  const second = await callTool(env, 'memory_link', { from_id: Number(idA), to_id: Number(idB), relation: 'relates-to' });
  assert.equal(second, `Already linked #${idA} -> #${idB} (relates-to)`);

  const Database = require('better-sqlite3');
  const raw = new Database(dbPath, { readonly: true });
  try {
    const rows = raw.prepare('SELECT id FROM memory_links WHERE from_id = ? AND to_id = ?').all(Number(idA), Number(idB));
    assert.equal(rows.length, 1, 'repeat link with same relation must not insert a second row');
  } finally {
    raw.close();
  }
});

test('memory_convention stores a convention-typed row and it sorts above older facts', async (t) => {
  const { env, dbPath } = freshEnv('/convention-test-project');
  cleanupDb(t, dbPath);

  await callTool(env, 'memory_remember', { value: 'widget deploy took 40 minutes on friday', scope: 'shared' });
  const conv = await callTool(env, 'memory_convention', { value: 'always run tests before widget deploy' });
  assert.match(conv, /^Stored new convention \(id \d+, scope shared\)$/);

  const recent = await callTool(env, 'memory_recall_recent', {});
  const lines = recent.split('\n').filter(l => !l.startsWith('    '));
  assert.match(lines[0], /\(convention\) always run tests before widget deploy/, 'convention must sort first regardless of recency');
});

test('memory_convention defaults to shared scope, visible to other agents', async (t) => {
  const dbPath = path.join(os.tmpdir(), `hive-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const project = '/convention-shared-test';
  const agent1Env = { ...process.env, HIVE_MEMORY_AGENT: 'agent-1', HIVE_MEMORY_PROJECT: project, HIVE_MEMORY_DB: dbPath, HIVE_MEMORY_LIGHTWEIGHT: '1' };
  const agent2Env = { ...process.env, HIVE_MEMORY_AGENT: 'agent-2', HIVE_MEMORY_PROJECT: project, HIVE_MEMORY_DB: dbPath, HIVE_MEMORY_LIGHTWEIGHT: '1' };

  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // ignore missing files
      }
    }
  });

  await callTool(agent1Env, 'memory_convention', { value: 'never force-push main' });
  const recall = await callTool(agent2Env, 'memory_recall', { query: 'force-push main' });
  assert.match(recall, /\[shared\/agent-1\].*\(convention\) never force-push main/);
});
