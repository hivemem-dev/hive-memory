'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');

// Same spawn-and-handshake helper as the other MCP-level test files - kept
// duplicated per the existing per-file pattern in this test suite.
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

test('memory_replay reports no session before any session has ended', async (t) => {
  const { env, dbPath } = freshEnv('/replay-empty-test');
  cleanupDb(t, dbPath);

  const result = await callTool(env, 'memory_replay', {});
  assert.equal(result, 'No previous session recorded yet.');
});

test('memory_session_start then memory_session_end makes the session replayable', async (t) => {
  const { env, dbPath } = freshEnv('/replay-test');
  cleanupDb(t, dbPath);

  await callTool(env, 'memory_session_start', { session_key: 'sess-1' });
  await callTool(env, 'memory_session_end', { session_key: 'sess-1', summary: 'Fixed the deploy script path bug and shipped it.' });

  const result = await callTool(env, 'memory_replay', {});
  assert.match(result, /Previous session \(/);
  assert.match(result, /Fixed the deploy script path bug/);
});

test('memory_replay only ever returns a finished session, not the in-progress one', async (t) => {
  const { env, dbPath } = freshEnv('/replay-inprogress-test');
  cleanupDb(t, dbPath);

  await callTool(env, 'memory_session_start', { session_key: 'sess-1' });
  await callTool(env, 'memory_session_end', { session_key: 'sess-1', summary: 'first session done' });
  await callTool(env, 'memory_session_start', { session_key: 'sess-2' });

  const result = await callTool(env, 'memory_replay', {});
  assert.match(result, /first session done/, 'must recap the finished sess-1, not the in-progress sess-2');
});

test('memory_skill_save then memory_skill_match finds it, memory_skill_score updates its rate', async (t) => {
  const { env, dbPath } = freshEnv('/skill-test-project');
  cleanupDb(t, dbPath);

  const saved = await callTool(env, 'memory_skill_save', {
    name: 'deploy-staging',
    body: 'Run scripts/deploy.sh staging, wait for health check, then tag the release.',
  });
  assert.match(saved, /^Saved new skill "deploy-staging" \(id \d+\)$/);
  const id = saved.match(/id (\d+)/)[1];

  const matched = await callTool(env, 'memory_skill_match', { query: 'deploy staging' });
  assert.match(matched, /deploy-staging/);
  assert.match(matched, /\(0\/0 succeeded\)/);

  const scored = await callTool(env, 'memory_skill_score', { id: Number(id), outcome: 'success' });
  assert.equal(scored, `Scored skill #${id} as success`);

  const matchedAgain = await callTool(env, 'memory_skill_match', { query: 'deploy staging' });
  assert.match(matchedAgain, /\(1\/1 succeeded\)/);
});

test('memory_skill_save upserts by name instead of creating a duplicate', async (t) => {
  const { env, dbPath } = freshEnv('/skill-upsert-test');
  cleanupDb(t, dbPath);

  const first = await callTool(env, 'memory_skill_save', { name: 'rollback', body: 'v1 of the rollback steps' });
  const firstId = first.match(/id (\d+)/)[1];

  const second = await callTool(env, 'memory_skill_save', { name: 'rollback', body: 'v2 of the rollback steps, corrected' });
  assert.equal(second, `Updated existing skill "rollback" (id ${firstId})`);

  const Database = require('better-sqlite3');
  const raw = new Database(dbPath, { readonly: true });
  try {
    const rows = raw.prepare('SELECT id, body FROM skills WHERE name = ?').all('rollback');
    assert.equal(rows.length, 1, 'save under the same name must update, not duplicate');
    assert.equal(rows[0].body, 'v2 of the rollback steps, corrected');
  } finally {
    raw.close();
  }
});

test('memory_premortem surfaces a related past failure but not an unrelated success', async (t) => {
  const { env, dbPath } = freshEnv('/premortem-test-project');
  cleanupDb(t, dbPath);

  const failure = await callTool(env, 'memory_remember', { value: 'force-pushing main overwrote a teammate\'s commit', scope: 'shared' });
  const failureId = failure.match(/id (\d+)/)[1];
  await callTool(env, 'memory_mark_outcome', { id: Number(failureId), outcome: 'failure' });

  await callTool(env, 'memory_remember', { value: 'the deploy dashboard uses grafana on port 3000', scope: 'shared' });

  const result = await callTool(env, 'memory_premortem', { action: 'force push main to fix a bad commit' });
  assert.match(result, /Before doing this, hive-memory flags:/);
  assert.match(result, /force-pushing main overwrote/);
  assert.doesNotMatch(result, /grafana/);
});

test('memory_premortem surfaces a matching convention', async (t) => {
  const { env, dbPath } = freshEnv('/premortem-convention-test');
  cleanupDb(t, dbPath);

  await callTool(env, 'memory_convention', { value: 'never force-push the main branch' });

  const result = await callTool(env, 'memory_premortem', { action: 'force push main branch' });
  assert.match(result, /\(convention\) never force-push the main branch/);
});

test('memory_premortem reports nothing when no failures/conventions match', async (t) => {
  const { env, dbPath } = freshEnv('/premortem-empty-test');
  cleanupDb(t, dbPath);

  await callTool(env, 'memory_remember', { value: 'the widget service redeploy takes about 3 minutes', scope: 'shared' });

  const result = await callTool(env, 'memory_premortem', { action: 'redeploy the widget service' });
  assert.equal(result, 'No known risks or conventions found for this - no history to flag.');
});
