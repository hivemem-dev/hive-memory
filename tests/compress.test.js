'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { summarize } = require('../lib/compress');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');

// Same one-shot MCP handshake helper used by tests/basic.test.js.
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

test('summarize leaves short text (< 150 chars) unchanged', () => {
  const short = 'Короткая заметка про баг.';
  assert.equal(summarize(short), short);
});

test('summarize leaves a single long sentence unchanged (nothing to rank)', () => {
  // One sentence, no period-triggered split, well over 150 chars.
  const oneSentence = 'Это очень длинное единственное предложение без точек в середине которое всё равно не должно ломаться и должно вернуться как есть потому что делить нечего';
  assert.ok(oneSentence.length >= 150);
  assert.equal(summarize(oneSentence), oneSentence);
});

test('summarize picks the important sentences from a longer Russian text, in original order', () => {
  const ru = [
    'Сервер стал показывать ошибку подключения к базе данных после обновления вчера вечером.',
    'База данных PostgreSQL используется для хранения всех пользовательских сессий и данных заказов.',
    'Кстати, в тот же день обновили ещё и библиотеку логирования до новой версии.',
    'Ошибка возникает потому что пул соединений исчерпан из-за утечки соединений в новом коде.',
    'Интерфейс админки тоже стал работать немного медленнее, но это не критично.',
    'Нужно откатить последний коммит с изменением работы с пулом соединений, чтобы вернуть стабильность.',
  ].join(' ');

  const result = summarize(ru);

  assert.ok(result.length < ru.length, 'summary should be shorter than the original');
  assert.ok(!result.includes('библиотеку логирования'), 'tangential sentence about logging library should be dropped');
  assert.ok(
    result.includes('пул соединений исчерпан'),
    'the key root-cause sentence should survive summarization'
  );

  // Result must be a subsequence of the original sentences, in original order:
  // check that the sentences composing the result appear in the source text
  // in the same relative order they appear in the result.
  const resultSentences = result.split(/(?<=[.!?])\s+/u);
  let searchFrom = 0;
  for (const s of resultSentences) {
    const idx = ru.indexOf(s, searchFrom);
    assert.ok(idx !== -1, `sentence "${s}" should be found verbatim in the source text`);
    searchFrom = idx + s.length;
  }
});

test('summarize picks the important sentences from a longer English text (language-independent)', () => {
  const en = [
    'The server started throwing a database connection error after last night deployment.',
    'The PostgreSQL database is used to store all user sessions and order data.',
    'By the way, the logging library was also upgraded to a new version that same day.',
    'The error happens because the connection pool is exhausted due to a connection leak in the new code.',
    'The admin dashboard also became slightly slower, but that is not critical.',
    'We need to revert the last commit that changed connection pool handling to restore stability.',
  ].join(' ');

  const result = summarize(en);

  assert.ok(result.length < en.length, 'summary should be shorter than the original');
  assert.ok(!result.includes('logging library'), 'tangential sentence about the logging library should be dropped');
  assert.ok(!result.includes('admin dashboard'), 'tangential sentence about the admin dashboard should be dropped');
  assert.ok(
    result.includes('connection pool is exhausted'),
    'the key root-cause sentence should survive summarization'
  );
});

// Regression test for a real bug the coordinator caught by hand: bare
// TextRank (no stop-word filtering) picked the throwaway "погода/солнечно"
// sentence as important because it shares the filler word "сегодня" with
// the opening sentence, while dropping the actual root-cause sentence about
// the exhausted connection pool. Must stay fixed permanently.
test('summarize regression: does not let an off-topic sentence outrank the root-cause sentence', () => {
  const text = 'Сегодня утром сервер стал очень медленно отвечать на запросы. '
    + 'Пул соединений с базой данных был исчерпан из-за утечки памяти в коде. '
    + 'Кстати, погода сегодня хорошая и на улице солнечно. '
    + 'Мы нашли причину — забыли закрывать соединения после каждого запроса. '
    + 'После добавления явного закрытия соединений проблема исчезла полностью. '
    + 'Также обновили библиотеку логирования до последней версии на всякий случай.';

  const result = summarize(text, { maxSentences: 2 });

  assert.ok(
    result.includes('Пул соединений') || result.includes('пул соединений'),
    'root-cause sentence about the exhausted connection pool must survive summarization'
  );
  assert.ok(!result.includes('погода'), 'off-topic weather sentence must not be selected');
  assert.ok(!result.includes('солнечно'), 'off-topic weather sentence must not be selected');
});

test('memory_remember summarizes long multi-sentence text before storing (server.js integration)', async (t) => {
  const dbPath = path.join(os.tmpdir(), `hive-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const project = '/test-project-compress';

  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // ignore missing files
      }
    }
  });

  const env = { ...process.env, HIVE_MEMORY_AGENT: 'agent-compress', HIVE_MEMORY_PROJECT: project, HIVE_MEMORY_DB: dbPath };

  const longText = [
    'Сервер стал показывать ошибку подключения к базе данных после обновления вчера вечером.',
    'База данных PostgreSQL используется для хранения всех пользовательских сессий и данных заказов.',
    'Кстати, в тот же день обновили ещё и библиотеку логирования до новой версии.',
    'Ошибка возникает потому что пул соединений исчерпан из-за утечки соединений в новом коде.',
    'Интерфейс админки тоже стал работать немного медленнее, но это не критично.',
    'Нужно откатить последний коммит с изменением работы с пулом соединений, чтобы вернуть стабильность.',
  ].join(' ');

  await t.test('write a long multi-sentence entry', async () => {
    const result = await callTool(env, 'memory_remember', {
      value: longText,
      scope: 'personal',
    });
    assert.match(result, /^Stored new entry \(id \d+, scope personal\)$/);
  });

  await t.test('stored value is shorter than the original (summarize is wired into server.js)', async () => {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare('SELECT value FROM memory WHERE project = ?').get(project);
      assert.ok(row, 'row should exist');
      assert.ok(row.value.length < longText.length, 'stored value should be shorter than the raw input');
      assert.notEqual(row.value, longText, 'stored value must not equal the raw untouched input');
    } finally {
      db.close();
    }
  });
});
