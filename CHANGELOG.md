# Changelog

## 0.5.0 — objective verify command, and what it found

- **Added: `node cli.js verify`.** Auto-builds a ground-truth test set from real history (every captured `UserPromptSubmit` question paired with the `Stop` row that answered it) and re-asks each as a `memory_recall` query, checking whether the real past answer surfaces in the top-K. No hand-written fixtures, no LLM judge - pure precision@K against this installation's own actual usage.
- **Finding (not yet fixed): retrieval hit rate on real captured chat history is low - 3% as shipped (1/30, top-5) on this installation's data**, versus 0% for a bare chronological dump and 0% for no memory at all. Root cause: `memory_recall`'s search pool mixes raw `UserPromptSubmit` rows in with `Stop` answer rows, and a re-asked question's top matches are almost always *other stored questions* worded similarly, not the answer - filtering the results down to `Stop` rows only raises the hit rate to 13% (4/30), which is the real ceiling of the current keyword+embedding search on short, casual, typo-heavy prompts against long generated answers. Recorded here rather than silently patched - the fix (e.g. excluding raw prompt rows from recall's candidate pool, or scoring key='Stop' higher) needs a decision on whether hook-captured chat log rows should be searchable answer candidates at all.

## 0.4.0 — session replay, skills, premortem

- **Added: `memory_session_start` / `memory_session_end` / `memory_replay`.** A `sessions` table tracks agent sessions keyed by the host agent's own `session_id`. The Claude Code adapter starts a session on `SessionStart` and ends it on `Stop` (with the last assistant message as the summary); `context-inject.js` now calls `memory_replay` at the start of every new session and prepends the previous session's recap to the injected context, ahead of the usual recent-memories list.
- **Added: `memory_skill_save` / `memory_skill_match` / `memory_skill_score`.** A `skills` table stores named, reusable task recipes distinct from one-off facts, with a running success rate. Saving under an existing name upserts instead of duplicating; matching ranks by success rate.
- **Added: `memory_premortem`.** Runs the same hybrid search as `memory_recall` but returns only `outcome=failure` and `type=convention` rows relevant to a described action - a filtered "what could go wrong here" check instead of a general lookup.
- **Fixed (dev-time only, caught before release): a stray backtick inside a SQL comment inside the schema-setup template literal in `db.js` silently broke the whole module (`SyntaxError: missing ) after argument list`), which made every MCP call hang until its caller's timeout. Removed the backtick from the comment.
- **Fixed: `memory_skill_match` required the entire query to appear as one substring**, so a two-word query like "deploy staging" wouldn't match a skill named "deploy-staging" even though both words were present. Now matches per-word (every word must appear somewhere in name or body), same tokenization philosophy as the FTS5 keyword search.

## 0.3.0 — correct/touch/link/convention

- **Added: `memory_correct`.** Fixes an existing entry's text in place (by id) instead of leaving stale/wrong facts around and remembering a corrected duplicate next to them. Clears the entry's embedding so the next recall re-embeds the corrected text.
- **Added: `memory_touch`.** Explicitly confirms an entry is still true/relevant, bumping `times_recalled` and resetting `updated_at` (unlike the implicit bump a recall hit does, which doesn't reset freshness).
- **Added: `memory_link`.** Links two entries by id with an optional relation label. Recall output now shows linked entries as indented `-> `/`<- ` lines under either side. Idempotent per (from, to, relation) triple.
- **Added: `memory_convention`.** Stores project rules/standards as a distinct `type='convention'` row. Conventions always sort first in `memory_recall`/`memory_recall_recent`, ahead of outcome and decay ranking.
- **Fixed: FTS5 query parsing on words with special characters.** `memory_recall`/`memory_recall_recent` search terms like "force-push" or anything containing `-`/`:` were being parsed as FTS5 query operators (e.g. NOT / column-filter) instead of literal words, so the search silently failed with "no such column" or missed results. Each word is now wrapped in a quoted FTS5 prefix query (`"word"*`) so special characters can't be misread as syntax.

## 0.2.0 — recall was silently broken; root-caused and fixed, plus semantic search

Found while investigating why `memory_recall` always returned "No matching memories found" despite `memory_remember` clearly writing rows:

- **Fixed: project scope drifted with cwd.** The Claude Code/Cursor adapters keyed memory by `event.cwd`, which changes with every `cd`/subprocess a session runs — one real workspace was silently fragmenting into dozens of disconnected one-off "projects". `HIVE_MEMORY_PROJECT` (when set) now takes priority over `event.cwd`, so a fixed value in the hook env keeps everything in one scope regardless of cwd drift.
- **Fixed: captured content was metadata, not facts.** `capture.js` stored bare tool names ("PostToolUse: Bash") instead of what actually happened, so there was nothing meaningful to search for. It now captures the real Bash command, the file path for Edit/Write/MultiEdit/NotebookEdit, and — on `Stop` — the agent's actual last message pulled from the transcript, instead of the bare word "Stop". As a side effect this also stops the old dedup bug where every identical "PostToolUse: Bash" row collapsed into one counter, destroying the history of which command ran when.
- **Added: hybrid semantic + keyword recall.** `memory_recall` now fuses SQLite FTS5 keyword matching with local, offline embedding search (`@huggingface/transformers`, `Xenova/all-MiniLM-L6-v2`, no API key/cost) via reciprocal rank fusion, so a fact surfaces even when the query doesn't share its exact wording. Runs only in the persistent MCP server session, not the latency-sensitive hook-capture path (`HIVE_MEMORY_LIGHTWEIGHT=1`). Falls back to keyword-only if the model can't load.
- **Improved:** FTS query now retries with OR-joined terms if the default AND match finds nothing, so a multi-word query doesn't fail outright just because one word doesn't match verbatim.
- **Improved:** `memory_stats` now also reports how many entries have an embedding.

## 0.1.0 — первая версия: MCP-сервер с personal/shared памятью, поиск по префиксам через SQLite FTS5, адаптеры для Claude Code и Cursor
