'use strict';
// Idempotent "plug hive-memory into an agent's config" logic, called for
// real by cli.js ("attach" command, writes files) and checked read-only by
// watcher.js (detect* below, no writes - watcher only notifies, it never
// edits a user's config on its own). No fs.watch here either way - just the
// merge/write/detect operations, kept pure and easy to unit-test.

const fs = require('fs');
const path = require('path');

const CLAUDE_CODE_HOOKS = require('../claude-code/hooks.json');
const CURSOR_HOOKS = require('../cursor/hooks.json');

const CLAUDE_CODE_MARKER = 'hive-memory/adapters/claude-code/capture.js';
const CURSOR_MARKER = 'hive-memory/adapters/cursor/capture.js';
const CODEX_MARKER = '[mcp_servers.hive-memory]';

const CODEX_BLOCK =
  '[mcp_servers.hive-memory]\n' +
  'command = "node"\n' +
  'args = ["/root/hive-memory/server.js"]\n' +
  'env = { HIVE_MEMORY_AGENT = "codex", HIVE_MEMORY_PROJECT = "/root/hive-memory" }\n';

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// Claude Code: settings.json "hooks" section is
// { [eventName]: [ { matcher?, hooks: [{type, command, timeout, async?}] } ] }.
// Adds our hook-group objects to each event's array without touching
// existing (possibly unrelated) entries in that array.
function attachClaudeCode(settingsPath) {
  const parentDir = path.dirname(settingsPath);
  if (!fs.existsSync(parentDir)) {
    return { attached: false, reason: 'config not found' };
  }

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    const parsed = readJson(settingsPath);
    settings = parsed && typeof parsed === 'object' ? parsed : {};
  }

  if (JSON.stringify(settings.hooks || {}).includes(CLAUDE_CODE_MARKER)) {
    return { attached: false, reason: 'already attached' };
  }

  settings.hooks = settings.hooks || {};
  for (const eventName of Object.keys(CLAUDE_CODE_HOOKS.hooks)) {
    const existing = settings.hooks[eventName] || [];
    settings.hooks[eventName] = existing.concat(CLAUDE_CODE_HOOKS.hooks[eventName]);
  }

  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return { attached: true, reason: 'attached' };
}

// Cursor: hooks.json is { version: 1, hooks: { [eventName]: [{command}] } }.
// Same append-don't-replace merge as Claude Code.
function attachCursor(hooksPath) {
  const parentDir = path.dirname(hooksPath);
  if (!fs.existsSync(parentDir)) {
    return { attached: false, reason: 'config not found' };
  }

  let config = { version: 1, hooks: {} };
  if (fs.existsSync(hooksPath)) {
    const parsed = readJson(hooksPath);
    if (parsed && typeof parsed === 'object') config = parsed;
  }
  config.hooks = config.hooks || {};
  if (config.version === undefined) config.version = 1;

  if (JSON.stringify(config.hooks).includes(CURSOR_MARKER)) {
    return { attached: false, reason: 'already attached' };
  }

  for (const eventName of Object.keys(CURSOR_HOOKS.hooks)) {
    const existing = config.hooks[eventName] || [];
    config.hooks[eventName] = existing.concat(CURSOR_HOOKS.hooks[eventName]);
  }

  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + '\n');
  return { attached: true, reason: 'attached' };
}

// Codex: config.toml is plain text - no TOML parser, just substring check
// and text append.
function attachCodex(configTomlPath) {
  const parentDir = path.dirname(configTomlPath);
  if (!fs.existsSync(parentDir)) {
    return { attached: false, reason: 'config not found' };
  }

  let content = '';
  if (fs.existsSync(configTomlPath)) {
    content = fs.readFileSync(configTomlPath, 'utf8');
  }

  if (content.includes(CODEX_MARKER)) {
    return { attached: false, reason: 'already attached' };
  }

  let next = content;
  if (next.length > 0 && !next.endsWith('\n')) next += '\n';
  if (next.length > 0) next += '\n';
  next += CODEX_BLOCK;

  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(configTomlPath, next);
  return { attached: true, reason: 'attached' };
}

// --- Read-only detectors: same "is it installed / already attached?"
// question as the attach* functions above, but never touch the filesystem
// beyond reading. Used by watcher.js to decide whether to print a notice,
// and by cli.js "status".

function detectClaudeCode(settingsPath) {
  const parentDir = path.dirname(settingsPath);
  if (!fs.existsSync(parentDir)) return { found: false, attached: false };

  let attached = false;
  if (fs.existsSync(settingsPath)) {
    const parsed = readJson(settingsPath);
    const hooks = parsed && typeof parsed === 'object' ? parsed.hooks : null;
    attached = JSON.stringify(hooks || {}).includes(CLAUDE_CODE_MARKER);
  }
  return { found: true, attached };
}

function detectCursor(hooksPath) {
  const parentDir = path.dirname(hooksPath);
  if (!fs.existsSync(parentDir)) return { found: false, attached: false };

  let attached = false;
  if (fs.existsSync(hooksPath)) {
    const parsed = readJson(hooksPath);
    const hooks = parsed && typeof parsed === 'object' ? parsed.hooks : null;
    attached = JSON.stringify(hooks || {}).includes(CURSOR_MARKER);
  }
  return { found: true, attached };
}

function detectCodex(configTomlPath) {
  const parentDir = path.dirname(configTomlPath);
  if (!fs.existsSync(parentDir)) return { found: false, attached: false };

  let attached = false;
  if (fs.existsSync(configTomlPath)) {
    attached = fs.readFileSync(configTomlPath, 'utf8').includes(CODEX_MARKER);
  }
  return { found: true, attached };
}

module.exports = {
  attachClaudeCode,
  attachCursor,
  attachCodex,
  detectClaudeCode,
  detectCursor,
  detectCodex,
};
