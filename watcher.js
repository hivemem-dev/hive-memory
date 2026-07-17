#!/usr/bin/env node
'use strict';
// Event-driven agent detector: watches for the config dirs/files of known
// agents (Claude Code, Cursor, Codex) via fs.watch (inotify) and prints a
// notice when one is installed but not yet attached. No polling - idle CPU
// is ~0, it only wakes up on real filesystem events.
//
// IMPORTANT: this script never writes to a user's config. It only detects
// and tells you what to run - the actual attach happens via
// `node cli.js attach <agent>`, a deliberate action the human takes.
//
// Run with a memory cap (this project's servers always get one):
//   node --max-old-space-size=64 watcher.js
//
// detectX() in adapters/lib/attach.js is read-only, so calling it on every
// fs event is cheap and side-effect free.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectClaudeCode, detectCursor, detectCodex } = require('./adapters/lib/attach');

const HOME = os.homedir();

const CLAUDE_DIR = path.join(HOME, '.claude');
const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');

const CURSOR_DIR = path.join(HOME, '.cursor');
const CURSOR_HOOKS = path.join(CURSOR_DIR, 'hooks.json');

const CODEX_DIR = path.join(HOME, '.codex');
const CODEX_CONFIG = path.join(CODEX_DIR, 'config.toml');

const AGENTS = [
  {
    name: 'Claude Code',
    cliName: 'claude-code',
    configPath: CLAUDE_SETTINGS,
    watchPaths: [CLAUDE_DIR, CLAUDE_SETTINGS],
    detect: detectClaudeCode,
  },
  {
    name: 'Cursor',
    cliName: 'cursor',
    configPath: CURSOR_HOOKS,
    watchPaths: [CURSOR_DIR],
    detect: detectCursor,
  },
  {
    name: 'Codex',
    cliName: 'codex',
    configPath: CODEX_CONFIG,
    watchPaths: [CODEX_DIR],
    detect: detectCodex,
  },
];

function log(msg) {
  console.log(`[hive-memory] ${msg}`);
}

function tildePath(p) {
  return p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p;
}

function checkAndNotify(agent) {
  const result = agent.detect(agent.configPath);
  if (result.found && !result.attached) {
    log(`Found ${agent.name} at ${tildePath(agent.configPath)} - not yet attached. Run: node cli.js attach ${agent.cliName}`);
  }
  // found && attached, or !found: nothing to say - stay quiet so the log
  // isn't spammed on every unrelated fs event.
}

// One pass at startup in case an agent is already installed.
for (const agent of AGENTS) checkAndNotify(agent);

// Then keep listening for changes. fs.watch throws ENOENT synchronously if
// the path doesn't exist yet - catch it once and skip, don't loop-retry.
function watchPath(targetPath, onEvent, label) {
  if (!fs.existsSync(targetPath)) {
    log(`${label}: ${tildePath(targetPath)} not found - agent not installed, skipping watch`);
    return;
  }
  try {
    fs.watch(targetPath, { persistent: true }, () => onEvent());
    log(`${label}: watching ${tildePath(targetPath)}`);
  } catch (err) {
    log(`${label}: failed to watch ${tildePath(targetPath)}: ${err.message}`);
  }
}

for (const agent of AGENTS) {
  for (const watchTarget of agent.watchPaths) {
    watchPath(watchTarget, () => checkAndNotify(agent), agent.name);
  }
}

log('watcher started, idle until agent configs change (detect-and-notify only, never edits config)');
