# hive-memory

MCP server for personal + shared memory that works with any MCP-compatible agent (Claude Code, Cursor, Codex CLI, ...). Personal entries are visible only to the agent that wrote them; shared entries are visible to every agent connected to the same project. Search is full-text (SQLite FTS5), ranked by past outcome (`success`/`failure`) and recall count.

Four MCP tools: `memory_remember`, `memory_recall`, `memory_mark_outcome`, `memory_stats`.

## Quick start

```bash
# 1. install
./install.sh

# 2. connect to your agent — install.sh prints the exact JSON block to paste
#    into ~/.claude.json under "mcpServers" (or the equivalent config for
#    Cursor / Codex CLI, see adapters/)

# 3. verify: from Claude Code, ask it to call memory_stats — should return
#    { "total": 0, "byScope": [], "latest": undefined } on first run
```

The database file is created automatically on first run of `server.js` (see `db.js`), at the path given by `HIVE_MEMORY_DB` (default `./hive-memory.db`).

## Adapters

`adapters/` wires the server into specific agents. Each adapter is a thin capture layer — no storage/search logic lives there, it only calls this server's existing MCP tools.

- `adapters/claude-code/` — hooks.json + capture.js (SessionStart, UserPromptSubmit, PostToolUse, Stop)
- `adapters/cursor/` — hooks.json + capture.js (beforeSubmitPrompt, afterShellExecution, afterFileEdit, stop)
- `adapters/codex/` — README only; MCP-compatible, connects to `server.js` directly, no hooks needed

## CLI

`cli.js` is the only thing that writes to an agent's config. It's explicit and human-triggered — no automatic edits happen anywhere in this project.

```bash
node cli.js status
# Agent         Installed    Attached
# Claude Code   found        attached
# Cursor        found        not attached
# Codex         not found    -

node cli.js attach cursor      # writes ~/.cursor/hooks.json for real
node cli.js attach all         # attaches every installed agent, skips the rest
```

## Auto-attach watcher

`watcher.js` detects installed agents and tells you what to run — it does not silently edit your config files. Event-driven via `fs.watch` (no polling, near-zero idle CPU): it wakes up when an agent's config dir/file appears or changes, checks (read-only) whether hive-memory is already attached, and if not, prints a one-line notice pointing at the `cli.js attach` command to run.

```bash
node --max-old-space-size=64 watcher.js
# [hive-memory] Found Cursor at ~/.cursor/hooks.json - not yet attached. Run: node cli.js attach cursor

# or in the background, this server's usual pattern:
screen -dmS hive-memory-watcher node --max-old-space-size=64 watcher.js
```

## Environment variables

See `.env.example`: `HIVE_MEMORY_AGENT`, `HIVE_MEMORY_PROJECT`, `HIVE_MEMORY_DB`.

## Tests

```bash
node --test tests/
```
