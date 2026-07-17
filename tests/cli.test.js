'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI_PATH = path.join(__dirname, '..', 'cli.js');

function mkTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hive-memory-cli-test-'));
}

// cli.js resolves agent config paths from os.homedir(), which on POSIX
// reads $HOME - overriding HOME in the child env is enough to point it at
// a throwaway directory instead of the real ~/.claude, ~/.cursor, ~/.codex.
function runCli(args, home) {
  return spawnSync('node', [CLI_PATH, ...args], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
}

test('cli.js status: no agents installed -> all report "not found"', (t) => {
  const home = mkTmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const result = runCli(['status'], home);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Claude Code\s+not found/);
  assert.match(result.stdout, /Cursor\s+not found/);
  assert.match(result.stdout, /Codex\s+not found/);
});

test('cli.js attach cursor: agent installed -> writes real hooks.json and reports attached', (t) => {
  const home = mkTmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.cursor'));

  const result = runCli(['attach', 'cursor'], home);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Cursor:\s+attached/);

  const hooksPath = path.join(home, '.cursor', 'hooks.json');
  assert.ok(fs.existsSync(hooksPath));
  const written = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  assert.ok(JSON.stringify(written.hooks).includes('hive-memory/adapters/cursor/capture.js'));
});

test('cli.js attach cursor: agent not installed -> reports not found, creates nothing', (t) => {
  const home = mkTmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // no ~/.cursor created

  const result = runCli(['attach', 'cursor'], home);

  assert.match(result.stdout, /not found/);
  assert.ok(!fs.existsSync(path.join(home, '.cursor')));
});

test('cli.js attach cursor: called twice -> second run reports already attached, no duplicate hooks', (t) => {
  const home = mkTmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.cursor'));

  runCli(['attach', 'cursor'], home);
  const second = runCli(['attach', 'cursor'], home);

  assert.match(second.stdout, /already attached/);

  const hooksPath = path.join(home, '.cursor', 'hooks.json');
  const raw = fs.readFileSync(hooksPath, 'utf8');
  const occurrences = raw.split('hive-memory/adapters/cursor/capture.js').length - 1;
  assert.equal(occurrences, 4);
});

test('cli.js attach all: attaches every installed agent, skips the rest', (t) => {
  const home = mkTmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  // .cursor and .codex NOT created

  const result = runCli(['attach', 'all'], home);

  assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json')));
  assert.ok(!fs.existsSync(path.join(home, '.cursor')));
  assert.ok(!fs.existsSync(path.join(home, '.codex')));
  assert.match(result.stdout, /Claude Code:\s+attached/);
  assert.match(result.stdout, /Cursor:\s+not found/);
  assert.match(result.stdout, /Codex:\s+not found/);
});

test('cli.js status: reflects real attached state after a real attach', (t) => {
  const home = mkTmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.codex'));

  runCli(['attach', 'codex'], home);
  const result = runCli(['status'], home);

  assert.match(result.stdout, /Codex\s+found\s+attached/);
});

test('cli.js: no command -> prints usage, exits 0', () => {
  const result = spawnSync('node', [CLI_PATH], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage/);
});

test('cli.js attach: missing agent name -> exits 1 with usage error', () => {
  const result = spawnSync('node', [CLI_PATH, 'attach'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: node cli\.js attach/);
});
