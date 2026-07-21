# Changelog

## 0.2.0 — recall was silently broken; root-caused and fixed, plus semantic search

Found while investigating why `memory_recall` always returned "No matching memories found" despite `memory_remember` clearly writing rows:

- **Fixed: project scope drifted with cwd.** The Claude Code/Cursor adapters keyed memory by `event.cwd`, which changes with every `cd`/subprocess a session runs — one real workspace was silently fragmenting into dozens of disconnected one-off "projects". `HIVE_MEMORY_PROJECT` (when set) now takes priority over `event.cwd`, so a fixed value in the hook env keeps everything in one scope regardless of cwd drift.
- **Fixed: captured content was metadata, not facts.** `capture.js` stored bare tool names ("PostToolUse: Bash") instead of what actually happened, so there was nothing meaningful to search for. It now captures the real Bash command, the file path for Edit/Write/MultiEdit/NotebookEdit, and — on `Stop` — the agent's actual last message pulled from the transcript, instead of the bare word "Stop". As a side effect this also stops the old dedup bug where every identical "PostToolUse: Bash" row collapsed into one counter, destroying the history of which command ran when.
- **Added: hybrid semantic + keyword recall.** `memory_recall` now fuses SQLite FTS5 keyword matching with local, offline embedding search (`@huggingface/transformers`, `Xenova/all-MiniLM-L6-v2`, no API key/cost) via reciprocal rank fusion, so a fact surfaces even when the query doesn't share its exact wording. Runs only in the persistent MCP server session, not the latency-sensitive hook-capture path (`HIVE_MEMORY_LIGHTWEIGHT=1`). Falls back to keyword-only if the model can't load.
- **Improved:** FTS query now retries with OR-joined terms if the default AND match finds nothing, so a multi-word query doesn't fail outright just because one word doesn't match verbatim.
- **Improved:** `memory_stats` now also reports how many entries have an embedding.

## 0.1.0 — первая версия: MCP-сервер с personal/shared памятью, поиск по префиксам через SQLite FTS5, адаптеры для Claude Code и Cursor
