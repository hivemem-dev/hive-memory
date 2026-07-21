'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const { isSignificant } = require('../adapters/lib/significance');

// --- Unit tests: isSignificant() itself, no process spawning ---

test('isSignificant: PostToolUse + Read (no error) -> false', () => {
  assert.equal(isSignificant('PostToolUse', { tool_name: 'Read' }), false);
});

test('isSignificant: PostToolUse + Grep (no error) -> false', () => {
  assert.equal(isSignificant('PostToolUse', { tool_name: 'Grep' }), false);
});

test('isSignificant: PostToolUse + Glob (no error) -> false', () => {
  assert.equal(isSignificant('PostToolUse', { tool_name: 'Glob' }), false);
});

test('isSignificant: PostToolUse + Edit -> true (real change)', () => {
  assert.equal(isSignificant('PostToolUse', { tool_name: 'Edit' }), true);
});

test('isSignificant: PostToolUse + Write -> true (real change)', () => {
  assert.equal(isSignificant('PostToolUse', { tool_name: 'Write' }), true);
});

test('isSignificant: PostToolUse + Bash -> true (real change)', () => {
  assert.equal(isSignificant('PostToolUse', { tool_name: 'Bash' }), true);
});

test('isSignificant: PostToolUse + Read with tool_response.isError -> true (error matters even for Read)', () => {
  assert.equal(
    isSignificant('PostToolUse', { tool_name: 'Read', tool_response: { isError: true } }),
    true
  );
});

test('isSignificant: PostToolUse + Grep with tool_response.error string -> true', () => {
  assert.equal(
    isSignificant('PostToolUse', { tool_name: 'Grep', tool_response: { error: 'boom' } }),
    true
  );
});

test('isSignificant: PostToolUse + Read with top-level event.error -> true', () => {
  assert.equal(isSignificant('PostToolUse', { tool_name: 'Read', error: 'boom' }), true);
});

test('isSignificant: UserPromptSubmit -> always true', () => {
  assert.equal(isSignificant('UserPromptSubmit', {}), true);
});

test('isSignificant: SessionStart -> always true', () => {
  assert.equal(isSignificant('SessionStart', {}), true);
});

test('isSignificant: Stop -> always true', () => {
  assert.equal(isSignificant('Stop', {}), true);
});

test('isSignificant: beforeSubmitPrompt (Cursor) -> always true', () => {
  assert.equal(isSignificant('beforeSubmitPrompt', {}), true);
});

test('isSignificant: stop (Cursor) -> always true', () => {
  assert.equal(isSignificant('stop', {}), true);
});

test('isSignificant: afterFileEdit (Cursor) -> always true', () => {
  assert.equal(isSignificant('afterFileEdit', { file_path: '/tmp/x.js' }), true);
});

test('isSignificant: afterShellExecution (Cursor) -> always true (no error field documented)', () => {
  assert.equal(
    isSignificant('afterShellExecution', { command: 'ls', output: '', duration: 5 }),
    true
  );
});

test('isSignificant: unknown event name -> fail-safe true', () => {
  assert.equal(isSignificant('SomeFutureHook', {}), true);
});

// --- Integration tests: spawn capture.js for real, check what lands in sqlite ---

const CLAUDE_CODE_CAPTURE = path.join(__dirname, '..', 'adapters', 'claude-code', 'capture.js');
const CURSOR_CAPTURE = path.join(__dirname, '..', 'adapters', 'cursor', 'capture.js');

function runCapture(scriptPath, env, stdinPayload) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`capture.js timed out. stderr: ${stderr}`));
    }, 10000);

    child.on('close', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.stdin.write(JSON.stringify(stdinPayload));
    child.stdin.end();
  });
}

function countMemoryRows(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM memory').get().n;
  } finally {
    db.close();
  }
}

function readMemoryRows(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT project, value FROM memory').all();
  } finally {
    db.close();
  }
}

test('capture.js integration: significant PostToolUse (Edit) is written to memory', async (t) => {
  const dbPath = path.join(os.tmpdir(), `hive-memory-sig-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // ignore missing files
      }
    }
  });

  const env = { ...process.env, HIVE_MEMORY_AGENT: 'sig-test', HIVE_MEMORY_PROJECT: '/test-project', HIVE_MEMORY_DB: dbPath };

  await runCapture(CLAUDE_CODE_CAPTURE, env, {
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    cwd: '/test-project',
  });

  assert.equal(countMemoryRows(dbPath), 1, 'a significant PostToolUse (Edit) should be stored');
});

test('capture.js integration: insignificant PostToolUse (Read, no error) is NOT written to memory', async (t) => {
  const dbPath = path.join(os.tmpdir(), `hive-memory-sig-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // ignore missing files
      }
    }
  });

  const env = { ...process.env, HIVE_MEMORY_AGENT: 'sig-test', HIVE_MEMORY_PROJECT: '/test-project', HIVE_MEMORY_DB: dbPath };

  const { stdout } = await runCapture(CLAUDE_CODE_CAPTURE, env, {
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    cwd: '/test-project',
  });

  // capture.js must still emit a valid hook-output JSON even when it skips the write.
  assert.match(stdout, /"continue":true/);

  assert.ok(!fs.existsSync(dbPath), 'no db file should have been created for an insignificant event');
});

test('capture.js integration: Bash PostToolUse captures the real command, not just the tool name', async (t) => {
  const dbPath = path.join(os.tmpdir(), `hive-memory-sig-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // ignore missing files
      }
    }
  });

  const env = { ...process.env, HIVE_MEMORY_AGENT: 'sig-test', HIVE_MEMORY_PROJECT: '/test-project', HIVE_MEMORY_DB: dbPath };

  await runCapture(CLAUDE_CODE_CAPTURE, env, {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    cwd: '/test-project',
  });

  const rows = readMemoryRows(dbPath);
  assert.equal(rows.length, 1);
  assert.match(rows[0].value, /npm test/, 'the actual command should be in the stored value, not just "Bash"');
});

test('capture.js integration: Edit PostToolUse captures the file path', async (t) => {
  const dbPath = path.join(os.tmpdir(), `hive-memory-sig-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // ignore missing files
      }
    }
  });

  const env = { ...process.env, HIVE_MEMORY_AGENT: 'sig-test', HIVE_MEMORY_PROJECT: '/test-project', HIVE_MEMORY_DB: dbPath };

  await runCapture(CLAUDE_CODE_CAPTURE, env, {
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: '/repo/src/index.js' },
    cwd: '/test-project',
  });

  const rows = readMemoryRows(dbPath);
  assert.equal(rows.length, 1);
  assert.match(rows[0].value, /\/repo\/src\/index\.js/, 'the edited file path should be in the stored value');
});

test('capture.js integration: Stop captures the last assistant message from the transcript, not the bare word "Stop"', async (t) => {
  const dbPath = path.join(os.tmpdir(), `hive-memory-sig-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const transcriptPath = path.join(os.tmpdir(), `hive-memory-transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // ignore missing files
      }
    }
    try {
      fs.unlinkSync(transcriptPath);
    } catch {
      // ignore
    }
  });

  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed the off-by-one error in the pagination loop.' }] } }),
  ].join('\n'));

  const env = { ...process.env, HIVE_MEMORY_AGENT: 'sig-test', HIVE_MEMORY_PROJECT: '/test-project', HIVE_MEMORY_DB: dbPath };

  await runCapture(CLAUDE_CODE_CAPTURE, env, {
    hook_event_name: 'Stop',
    transcript_path: transcriptPath,
    cwd: '/test-project',
  });

  const rows = readMemoryRows(dbPath);
  assert.equal(rows.length, 1);
  assert.match(rows[0].value, /off-by-one error in the pagination loop/, 'should capture the real last assistant message');
  assert.doesNotMatch(rows[0].value, /^Stop$/, 'must not be the bare event name');
});

test('capture.js integration: HIVE_MEMORY_PROJECT stays fixed even when event.cwd differs (regression: cwd used to fragment memory into one bucket per directory)', async (t) => {
  const dbPath = path.join(os.tmpdir(), `hive-memory-sig-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // ignore missing files
      }
    }
  });

  const env = { ...process.env, HIVE_MEMORY_AGENT: 'sig-test', HIVE_MEMORY_PROJECT: '/stable-project', HIVE_MEMORY_DB: dbPath };

  await runCapture(CLAUDE_CODE_CAPTURE, env, {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    cwd: '/some/transient/subdir/that/changed',
  });

  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT project FROM memory').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].project, '/stable-project', 'HIVE_MEMORY_PROJECT must win over event.cwd');
  } finally {
    db.close();
  }
});
