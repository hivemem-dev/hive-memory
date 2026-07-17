'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');

// Spawns a fresh `node server.js` MCP process, does the initialize handshake,
// calls one tool, and returns its text content. One process per call —
// mirrors the manual `echo JSON | node server.js` testing this server was
// already verified with.
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

test('personal memory is isolated per agent, shared memory is visible to all', async (t) => {
  const dbPath = path.join(os.tmpdir(), `hive-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const project = '/test-project';

  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // ignore missing files
      }
    }
  });

  const agent1Env = { ...process.env, HIVE_MEMORY_AGENT: 'agent-1', HIVE_MEMORY_PROJECT: project, HIVE_MEMORY_DB: dbPath };
  const agent2Env = { ...process.env, HIVE_MEMORY_AGENT: 'agent-2', HIVE_MEMORY_PROJECT: project, HIVE_MEMORY_DB: dbPath };

  await t.test('agent-1 writes a personal entry', async () => {
    const result = await callTool(agent1Env, 'memory_remember', {
      value: 'personal-agent1-note about the auth bug',
      scope: 'personal',
    });
    assert.match(result, /^Stored new entry \(id \d+, scope personal\)$/);
  });

  await t.test('agent-1 writes a shared entry', async () => {
    const result = await callTool(agent1Env, 'memory_remember', {
      value: 'shared-agent1-note about the deploy process',
      scope: 'shared',
    });
    assert.match(result, /^Stored new entry \(id \d+, scope shared\)$/);
  });

  await t.test('agent-2 sees the shared entry but not agent-1\'s personal entry', async () => {
    const result = await callTool(agent2Env, 'memory_recall', { query: 'agent1' });
    assert.match(result, /\[shared\/agent-1\]/, 'shared entry should be visible');
    assert.doesNotMatch(result, /\[personal\/agent-1\]/, 'agent-1\'s personal entry must stay hidden from agent-2');
  });

  await t.test('agent-1 sees both its personal entry and the shared entry', async () => {
    const result = await callTool(agent1Env, 'memory_recall', { query: 'agent1' });
    assert.match(result, /\[personal\/agent-1\]/, 'own personal entry should be visible');
    assert.match(result, /\[shared\/agent-1\]/, 'shared entry should be visible');
  });
});

test('memory_remember deduplicates repeated entries for the same agent/scope', async (t) => {
  const Database = require('better-sqlite3');
  const dbPath = path.join(os.tmpdir(), `hive-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const project = '/test-project';

  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // ignore missing files
      }
    }
  });

  const agent1Env = { ...process.env, HIVE_MEMORY_AGENT: 'agent-1', HIVE_MEMORY_PROJECT: project, HIVE_MEMORY_DB: dbPath };

  let firstId;

  await t.test('agent-1 writes a personal entry', async () => {
    const result = await callTool(agent1Env, 'memory_remember', {
      value: 'exact repeat dedup test',
      scope: 'personal',
    });
    assert.match(result, /^Stored new entry \(id (\d+), scope personal\)$/);
    firstId = result.match(/^Stored new entry \(id (\d+), scope personal\)$/)[1];
  });

  await t.test('agent-1 writes the exact same string again -> reinforced, same id', async () => {
    const result = await callTool(agent1Env, 'memory_remember', {
      value: 'exact repeat dedup test',
      scope: 'personal',
    });
    assert.equal(result, `Reinforced existing entry (id ${firstId}, scope personal)`);
  });

  await t.test('agent-1 writes the same string with different case/whitespace -> reinforced, same id', async () => {
    const result = await callTool(agent1Env, 'memory_remember', {
      value: '  ExAcT   Repeat  Dedup Test  ',
      scope: 'personal',
    });
    assert.equal(result, `Reinforced existing entry (id ${firstId}, scope personal)`);
  });

  await t.test('times_recalled accumulated across the two dedup hits, and no extra row was created', async () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare('SELECT id, times_recalled FROM memory WHERE project = ?').all(project);
      assert.equal(rows.length, 1, 'only one row should exist, dedup must not insert new rows');
      assert.equal(rows[0].id, Number(firstId));
      assert.equal(rows[0].times_recalled, 2, 'times_recalled should increment once per dedup hit');
    } finally {
      db.close();
    }
  });
});

test('memory_remember does not dedupe the same text across different scopes', async (t) => {
  const dbPath = path.join(os.tmpdir(), `hive-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const project = '/test-project';

  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // ignore missing files
      }
    }
  });

  const agent1Env = { ...process.env, HIVE_MEMORY_AGENT: 'agent-1', HIVE_MEMORY_PROJECT: project, HIVE_MEMORY_DB: dbPath };

  await t.test('agent-1 writes a personal entry', async () => {
    const result = await callTool(agent1Env, 'memory_remember', {
      value: 'cross-scope dedup text',
      scope: 'personal',
    });
    assert.match(result, /^Stored new entry \(id \d+, scope personal\)$/);
  });

  await t.test('agent-1 writes the same text as shared -> new entry, not reinforced', async () => {
    const result = await callTool(agent1Env, 'memory_remember', {
      value: 'cross-scope dedup text',
      scope: 'shared',
    });
    assert.match(result, /^Stored new entry \(id \d+, scope shared\)$/, 'different scope must not be deduped against personal');
  });
});

test('memory_remember does not dedupe personal entries across different agents', async (t) => {
  const dbPath = path.join(os.tmpdir(), `hive-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const project = '/test-project';

  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // ignore missing files
      }
    }
  });

  const agent1Env = { ...process.env, HIVE_MEMORY_AGENT: 'agent-1', HIVE_MEMORY_PROJECT: project, HIVE_MEMORY_DB: dbPath };
  const agent2Env = { ...process.env, HIVE_MEMORY_AGENT: 'agent-2', HIVE_MEMORY_PROJECT: project, HIVE_MEMORY_DB: dbPath };

  await t.test('agent-1 writes a personal entry', async () => {
    const result = await callTool(agent1Env, 'memory_remember', {
      value: 'cross-agent dedup text',
      scope: 'personal',
    });
    assert.match(result, /^Stored new entry \(id \d+, scope personal\)$/);
  });

  await t.test('agent-2 writes the same text as personal -> new entry, isolated from agent-1', async () => {
    const result = await callTool(agent2Env, 'memory_remember', {
      value: 'cross-agent dedup text',
      scope: 'personal',
    });
    assert.match(result, /^Stored new entry \(id \d+, scope personal\)$/, 'personal scope must stay isolated per agent, not deduped');
  });
});
