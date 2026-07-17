#!/usr/bin/env node
'use strict';
// Explicit, human-triggered commands for wiring hive-memory into an agent's
// config. This is the ONLY thing that ever writes to a user's
// settings.json / hooks.json / config.toml - watcher.js only detects and
// notifies, it never calls attach* itself.

const os = require('os');
const path = require('path');

const {
  attachClaudeCode,
  attachCursor,
  attachCodex,
  detectClaudeCode,
  detectCursor,
  detectCodex,
} = require('./adapters/lib/attach');

// db.js is required lazily inside cmdList/cmdSearch (not at top-level) -
// requiring it opens/creates the sqlite file as a side effect, and
// attach/status shouldn't touch the db at all.

const HOME = os.homedir();

const AGENTS = {
  'claude-code': {
    label: 'Claude Code',
    configPath: path.join(HOME, '.claude', 'settings.json'),
    attach: attachClaudeCode,
    detect: detectClaudeCode,
  },
  cursor: {
    label: 'Cursor',
    configPath: path.join(HOME, '.cursor', 'hooks.json'),
    attach: attachCursor,
    detect: detectCursor,
  },
  codex: {
    label: 'Codex',
    configPath: path.join(HOME, '.codex', 'config.toml'),
    attach: attachCodex,
    detect: detectCodex,
  },
};

function tildePath(p) {
  return p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p;
}

function attachOne(name) {
  const agent = AGENTS[name];
  const result = agent.attach(agent.configPath);
  if (result.attached) {
    console.log(`[hive-memory] ${agent.label}: attached (${tildePath(agent.configPath)})`);
  } else if (result.reason === 'already attached') {
    console.log(`[hive-memory] ${agent.label}: already attached`);
  } else {
    console.log(`[hive-memory] ${agent.label}: not found (${tildePath(agent.configPath)}) - skipped`);
  }
}

function cmdAttach(name) {
  if (!name) {
    console.error('Usage: node cli.js attach <claude-code|cursor|codex|all>');
    process.exitCode = 1;
    return;
  }
  if (name === 'all') {
    for (const key of Object.keys(AGENTS)) attachOne(key);
    return;
  }
  if (!AGENTS[name]) {
    console.error(`Unknown agent "${name}". Known: ${Object.keys(AGENTS).join(', ')}, all`);
    process.exitCode = 1;
    return;
  }
  attachOne(name);
}

function cmdStatus() {
  console.log('Agent         Installed    Attached');
  for (const key of Object.keys(AGENTS)) {
    const agent = AGENTS[key];
    const result = agent.detect(agent.configPath);
    const foundLabel = result.found ? 'found' : 'not found';
    const attachedLabel = result.found ? (result.attached ? 'attached' : 'not attached') : '-';
    console.log(`${agent.label.padEnd(14)}${foundLabel.padEnd(13)}${attachedLabel}`);
  }
}

// Minimal `--flag value` parser for list/search - no positional/flag mixing
// beyond one leading positional (search's <query>), which is all these two
// commands need. Not a general argv parser, just enough to avoid pulling in
// commander/yargs for two commands.
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      flags[a.slice(2)] = argv[i + 1];
      i++;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function cmdList(flags) {
  const db = require('./db');
  const limit = flags.limit ? parseInt(flags.limit, 10) : 50;
  const rows = db.listAll({ project: flags.project, scope: flags.scope, agent: flags.agent, limit });
  if (rows.length === 0) {
    console.log('No entries found.');
    return;
  }
  console.log('ID     Scope     Agent           Project                        Value                                                          Outcome   Recalled');
  for (const r of rows) {
    console.log(
      String(r.id).padEnd(7) +
      r.scope.padEnd(10) +
      truncate(r.agent, 15).padEnd(16) +
      truncate(r.project, 30).padEnd(31) +
      truncate(r.value, 60).padEnd(63) +
      r.outcome.padEnd(10) +
      String(r.times_recalled)
    );
  }
}

// scope is intentionally left unset here so db.recall()'s admin=true branch
// applies: shared+personal+global across every agent for the project. This
// is a human running the CLI at a terminal, not an agent - there's no
// single "current agent" to filter by, and admin mode exists specifically
// so the person who already owns the SQLite file isn't blocked by the same
// agent-isolation that keeps agents from reading each other's memories.
function cmdSearch(query, flags) {
  if (!query) {
    console.error('Usage: node cli.js search <query> [--project X] [--limit N]');
    process.exitCode = 1;
    return;
  }
  const db = require('./db');
  const project = flags.project || process.cwd();
  const limit = flags.limit ? parseInt(flags.limit, 10) : 10;
  const rows = db.recall({ query, project, limit, admin: true });
  if (rows.length === 0) {
    console.log('No matching memories found.');
    return;
  }
  console.log('ID     Scope     Agent           Value                                                          Outcome   Recalled');
  for (const r of rows) {
    console.log(
      String(r.id).padEnd(7) +
      r.scope.padEnd(10) +
      truncate(r.agent, 15).padEnd(16) +
      truncate(r.value, 60).padEnd(63) +
      r.outcome.padEnd(10) +
      String(r.times_recalled)
    );
  }
}

function main() {
  const [, , cmd, ...rest] = process.argv;

  if (cmd === 'attach') {
    cmdAttach(rest[0]);
  } else if (cmd === 'status') {
    cmdStatus();
  } else if (cmd === 'list') {
    const { flags } = parseArgs(rest);
    cmdList(flags);
  } else if (cmd === 'search') {
    const { positional, flags } = parseArgs(rest);
    cmdSearch(positional[0], flags);
  } else {
    console.log(
      'Usage:\n' +
      '  node cli.js status\n' +
      '  node cli.js attach <claude-code|cursor|codex|all>\n' +
      '  node cli.js list [--project X] [--scope personal|shared|global] [--agent X] [--limit N]\n' +
      '  node cli.js search <query> [--project X] [--limit N]'
    );
    if (cmd) process.exitCode = 1;
  }
}

main();
