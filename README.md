# hive-memory

MCP server for personal + shared memory that works with any MCP-compatible agent (Claude Code, Cursor, Codex CLI, ...). Personal entries are visible only to the agent that wrote them; shared entries are visible to every agent connected to the same project. Search is hybrid — SQLite FTS5 keyword matching fused with local, offline semantic search (see below) — ranked by past outcome (`success`/`failure`) and recall count.

Nine MCP tools: `memory_remember`, `memory_recall`, `memory_mark_outcome`, `memory_stats`, `memory_recall_recent`, `memory_correct`, `memory_touch`, `memory_link`, `memory_convention`.

## Correcting, confirming, linking, conventions

- **`memory_correct`** fixes an existing entry's text in place (id from a prior recall) instead of leaving the wrong fact around and remembering a corrected duplicate next to it.
- **`memory_touch`** confirms an entry is still true/relevant right now without changing its text - resets its recall-ranking freshness.
- **`memory_link`** connects two entries with an optional relation label (e.g. `caused-by`, `supersedes`). Linked entries show up as indented `-> `/`<- ` lines under either entry whenever it's recalled.
- **`memory_convention`** stores a project rule/standard (`type=convention`) instead of a one-off fact. Conventions always sort first in `memory_recall` and `memory_recall_recent`, regardless of recency or decay - they don't stop being true just because nobody hit them last week.

## Semantic recall

`memory_recall` combines two search methods and merges them with reciprocal rank fusion, so a fact surfaces whether the query shares its exact words or just its meaning:

- **Keyword (FTS5)** — exact/prefix word matches, same as before.
- **Semantic (local embeddings)** — [@huggingface/transformers](https://www.npmjs.com/package/@huggingface/transformers) running `Xenova/all-MiniLM-L6-v2` fully on-CPU/offline. No API key, no per-call cost — only a one-time ~90MB model download on first use (cached under `~/.cache`).

This only runs in the long-lived MCP server session (the one wired into the agent's `mcpServers` config) — the hook-capture path (`adapters/*/capture.js`) spawns a fresh process per event and sets `HIVE_MEMORY_LIGHTWEIGHT=1` to skip embedding there, so hook latency is unaffected. Any backlog of un-embedded rows (legacy entries, or ones written through the lightweight path) gets embedded lazily the next time `memory_recall` runs.

If the model can't load (e.g. no internet on first run), recall falls back to keyword-only search instead of failing.

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

**Set `HIVE_MEMORY_PROJECT` explicitly if you want one stable memory scope.** If unset, the Claude Code/Cursor hook adapters fall back to the hook event's current working directory - fine if each of your projects is its own repo/cwd, but if a session ever `cd`s elsewhere (a subprocess, a temp folder, a nested app dir), that becomes a brand-new, disconnected memory bucket. Pin `HIVE_MEMORY_PROJECT` in your hook commands and in your MCP server's `env` (must match) to keep everything under one project regardless of cwd drift.

## Tests

```bash
node --test tests/
```
