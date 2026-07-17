# Codex CLI adapter

No hook scripts here — Codex CLI is MCP-compatible and can call `memory_remember` / `memory_recall` / `memory_mark_outcome` / `memory_stats` directly, without any capture layer in between.

Confirmed native MCP support via `~/.codex/config.toml`:

```toml
[mcp_servers.hive-memory]
command = "node"
args = ["/root/hive-memory/server.js"]
env = { HIVE_MEMORY_AGENT = "codex", HIVE_MEMORY_PROJECT = "/path/to/project" }
```

Restart Codex CLI — the four `memory_*` tools show up alongside its other tools.
