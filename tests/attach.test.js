'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { attachClaudeCode, attachCursor, attachCodex } = require('../adapters/lib/attach');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hive-memory-attach-test-'));
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// --- attachClaudeCode ---

test('attachClaudeCode: missing settings.json -> creates file with our hooks, attached=true', (t) => {
  const dir = mkTmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, 'settings.json');

  const result = attachClaudeCode(settingsPath);

  assert.equal(result.attached, true);
  assert.ok(fs.existsSync(settingsPath));

  const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.ok(written.hooks.SessionStart);
  assert.ok(
    JSON.stringify(written.hooks).includes('hive-memory/adapters/claude-code/capture.js')
  );
});

test('attachClaudeCode: parent dir does not exist -> attached=false, reason=config not found', () => {
  const settingsPath = path.join(os.tmpdir(), `hive-memory-nonexistent-${Date.now()}`, 'settings.json');

  const result = attachClaudeCode(settingsPath);

  assert.equal(result.attached, false);
  assert.equal(result.reason, 'config not found');
  assert.ok(!fs.existsSync(settingsPath));
});

test('attachClaudeCode: existing settings.json with foreign hooks -> our hooks added, foreign hooks untouched', (t) => {
  const dir = mkTmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, 'settings.json');

  const foreign = {
    model: 'sonnet',
    hooks: {
      PostToolUse: [
        {
          matcher: 'Write|Edit|MultiEdit',
          hooks: [{ type: 'command', command: 'node /root/.claude/helpers/hook-handler.cjs post-edit', timeout: 10000 }],
        },
      ],
      SessionStart: [
        {
          matcher: 'startup',
          hooks: [{ type: 'command', command: '/root/.local/bin/mnemos prewarm', timeout: 10 }],
        },
      ],
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(foreign, null, 2));

  const result = attachClaudeCode(settingsPath);

  assert.equal(result.attached, true);

  const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  // foreign PostToolUse group survives
  assert.equal(written.hooks.PostToolUse.length, 2);
  assert.ok(
    written.hooks.PostToolUse.some((g) => g.matcher === 'Write|Edit|MultiEdit')
  );
  // our PostToolUse group was appended
  assert.ok(
    written.hooks.PostToolUse.some((g) =>
      g.hooks.some((h) => h.command.includes('hive-memory/adapters/claude-code/capture.js'))
    )
  );

  // foreign SessionStart group survives alongside ours (capture.js + context-inject.js)
  assert.equal(written.hooks.SessionStart.length, 3);
  assert.ok(written.hooks.SessionStart.some((g) => g.matcher === 'startup'));
  assert.ok(
    written.hooks.SessionStart.some((g) =>
      g.hooks.some((h) => h.command.includes('hive-memory/adapters/claude-code/context-inject.js'))
    )
  );

  // unrelated top-level field untouched
  assert.equal(written.model, 'sonnet');
});

test('attachClaudeCode: called twice -> second call attached=false, reason=already attached, no duplicate hooks', (t) => {
  const dir = mkTmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, 'settings.json');

  const first = attachClaudeCode(settingsPath);
  const second = attachClaudeCode(settingsPath);

  assert.equal(first.attached, true);
  assert.equal(second.attached, false);
  assert.equal(second.reason, 'already attached');

  const raw = fs.readFileSync(settingsPath, 'utf8');
  assert.equal(countOccurrences(raw, 'hive-memory/adapters/claude-code/capture.js'), 4);
});

// --- attachCursor ---

test('attachCursor: missing hooks.json -> creates file with our hooks, attached=true', (t) => {
  const dir = mkTmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hooksPath = path.join(dir, 'hooks.json');

  const result = attachCursor(hooksPath);

  assert.equal(result.attached, true);
  assert.ok(fs.existsSync(hooksPath));

  const written = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  assert.equal(written.version, 1);
  assert.ok(written.hooks.beforeSubmitPrompt);
  assert.ok(
    JSON.stringify(written.hooks).includes('hive-memory/adapters/cursor/capture.js')
  );
});

test('attachCursor: parent dir does not exist -> attached=false, reason=config not found', () => {
  const hooksPath = path.join(os.tmpdir(), `hive-memory-nonexistent-cursor-${Date.now()}`, 'hooks.json');

  const result = attachCursor(hooksPath);

  assert.equal(result.attached, false);
  assert.equal(result.reason, 'config not found');
  assert.ok(!fs.existsSync(hooksPath));
});

test('attachCursor: existing hooks.json with foreign hooks -> our hooks added, foreign hooks untouched', (t) => {
  const dir = mkTmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hooksPath = path.join(dir, 'hooks.json');

  const foreign = {
    version: 1,
    hooks: {
      afterFileEdit: [{ command: 'node /some/other/tool/capture.js afterFileEdit' }],
    },
  };
  fs.writeFileSync(hooksPath, JSON.stringify(foreign, null, 2));

  const result = attachCursor(hooksPath);

  assert.equal(result.attached, true);

  const written = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));

  assert.equal(written.hooks.afterFileEdit.length, 2);
  assert.ok(written.hooks.afterFileEdit.some((h) => h.command.includes('/some/other/tool/capture.js')));
  assert.ok(
    written.hooks.afterFileEdit.some((h) => h.command.includes('hive-memory/adapters/cursor/capture.js'))
  );
  assert.ok(written.hooks.beforeSubmitPrompt);
});

test('attachCursor: called twice -> second call attached=false, reason=already attached, no duplicate hooks', (t) => {
  const dir = mkTmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hooksPath = path.join(dir, 'hooks.json');

  const first = attachCursor(hooksPath);
  const second = attachCursor(hooksPath);

  assert.equal(first.attached, true);
  assert.equal(second.attached, false);
  assert.equal(second.reason, 'already attached');

  const raw = fs.readFileSync(hooksPath, 'utf8');
  assert.equal(countOccurrences(raw, 'hive-memory/adapters/cursor/capture.js'), 4);
});

// --- attachCodex ---

test('attachCodex: missing config.toml -> creates file with our block, attached=true', (t) => {
  const dir = mkTmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.toml');

  const result = attachCodex(configPath);

  assert.equal(result.attached, true);
  assert.ok(fs.existsSync(configPath));

  const written = fs.readFileSync(configPath, 'utf8');
  assert.ok(written.includes('[mcp_servers.hive-memory]'));
  assert.ok(written.includes('args = ["/root/hive-memory/server.js"]'));
});

test('attachCodex: parent dir does not exist -> attached=false, reason=config not found', () => {
  const configPath = path.join(os.tmpdir(), `hive-memory-nonexistent-codex-${Date.now()}`, 'config.toml');

  const result = attachCodex(configPath);

  assert.equal(result.attached, false);
  assert.equal(result.reason, 'config not found');
  assert.ok(!fs.existsSync(configPath));
});

test('attachCodex: existing config.toml with foreign mcp server -> our block appended, foreign block untouched', (t) => {
  const dir = mkTmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.toml');

  const foreign = '[mcp_servers.other-tool]\ncommand = "node"\nargs = ["/opt/other-tool/server.js"]\n';
  fs.writeFileSync(configPath, foreign);

  const result = attachCodex(configPath);

  assert.equal(result.attached, true);

  const written = fs.readFileSync(configPath, 'utf8');
  assert.ok(written.includes('[mcp_servers.other-tool]'));
  assert.ok(written.includes('args = ["/opt/other-tool/server.js"]'));
  assert.ok(written.includes('[mcp_servers.hive-memory]'));
});

test('attachCodex: called twice -> second call attached=false, reason=already attached, no duplicate block', (t) => {
  const dir = mkTmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.toml');

  const first = attachCodex(configPath);
  const second = attachCodex(configPath);

  assert.equal(first.attached, true);
  assert.equal(second.attached, false);
  assert.equal(second.reason, 'already attached');

  const raw = fs.readFileSync(configPath, 'utf8');
  assert.equal(countOccurrences(raw, '[mcp_servers.hive-memory]'), 1);
});
