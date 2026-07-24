const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.HIVE_MEMORY_DB || path.join(process.cwd(), 'hive-memory.db');

// Half-life (days) for recall ranking decay: a record with no new recalls
// loses half its effective weight after this many days. Doesn't delete or
// touch stored data, only how recall() orders results.
const HALF_LIFE_DAYS = 30;

// Local semantic search: this model runs fully offline/on-CPU via
// @huggingface/transformers, no API key and no per-call cost (only a
// one-time model download, cached under node_modules/.../.cache). Keeps
// hive-memory free to run as often as the hooks fire.
//
// EmbeddingGemma over the previous Xenova/all-MiniLM-L6-v2: measured on this
// installation's own captured Russian conversation history (node cli.js
// verify), MiniLM found the right past answer again only 30% of the time
// (semantic-only, top-5) vs 70% for EmbeddingGemma - MiniLM is
// English-centric and was missing most Russian matches. Costs ~1.2GB on
// disk / model load vs MiniLM's ~90MB - only worth it because this install
// has the RAM headroom for it.
const EMBEDDING_MODEL = 'onnx-community/embeddinggemma-300m-ONNX';

// EmbeddingGemma is trained asymmetrically - queries and stored documents
// need different prompt prefixes to get good similarity scores (see the
// model card). Getting this wrong doesn't error, it just silently produces
// worse rankings, so it's applied unconditionally rather than left optional.
const QUERY_PREFIX = 'task: search result | query: ';
const PASSAGE_PREFIX = 'title: none | text: ';

// Second-pass reranker: the embedding/FTS search above is a fast, rough
// first sort (a librarian grabbing 20 books that look roughly right off the
// shelf) - this model does a slower, careful second read, comparing the
// query against each candidate directly rather than just comparing two
// pre-computed vectors, and re-sorts by that. int8-quantized BGE reranker
// (multilingual, includes Russian) - measured on this installation's real
// data: scored the correct past answer at 0.999 vs -9.5 to -10.6 for
// unrelated ones, a wide and reliable margin. ~560MB on disk/load, on top
// of the embedding model - only worth it with RAM to spare.
const RERANKER_MODEL = 'tss-deposium/bge-reranker-v2-m3-onnx-int8';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// times_recalled + 1 as the base so records with 0 recalls still carry some
// weight (a brand-new record isn't ranked below an identical brand-new one
// with 0 vs 0 just because of float rounding, and it doesn't get sorted to
// the absolute bottom relative to other never-recalled records).
db.function('decay_score', (timesRecalled, updatedAt) => {
  const ageDays = (Date.now() - updatedAt) / (1000 * 60 * 60 * 24);
  return (timesRecalled + 1) * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
});

db.exec(`
CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK(scope IN ('personal', 'shared', 'global')),
  agent TEXT NOT NULL,
  project TEXT NOT NULL,
  key TEXT,
  value TEXT NOT NULL,
  outcome TEXT CHECK(outcome IN ('success', 'failure', 'unknown')) DEFAULT 'unknown',
  times_recalled INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scope_project ON memory(scope, project);
CREATE INDEX IF NOT EXISTS idx_agent ON memory(agent);

-- Links between two memory rows (e.g. "this fact caused that failure"),
-- undirected in practice but stored as from/to since a relation label can
-- read one-directionally ("supersedes", "caused-by"). relation defaults to
-- '' rather than NULL so the UNIQUE constraint actually dedupes repeat
-- links - SQLite treats every NULL as distinct, so a NULL relation column
-- would let the same pair be linked over and over.
CREATE TABLE IF NOT EXISTS memory_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL REFERENCES memory(id),
  to_id INTEGER NOT NULL REFERENCES memory(id),
  relation TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(from_id, to_id, relation)
);

-- One row per agent session (as identified by the host agent's own
-- session_id, e.g. Claude Code's hook payload). started_at is set when the
-- session starts; ended_at/summary are filled in when it ends. A row with
-- ended_at IS NULL is still in progress, which is exactly why
-- getLastEndedSession() (ORDER BY ended_at DESC) naturally skips the current
-- session without needing to explicitly exclude it.
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL UNIQUE,
  agent TEXT NOT NULL,
  project TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_agent_project ON sessions(agent, project, ended_at);

-- Reusable task recipes, distinct from memory facts: a skill has a name
-- you look it up by and a running success rate, not just a value and an
-- outcome enum. UNIQUE(agent, project, scope, name) so memory_skill_save
-- upserts (refines an existing recipe) instead of piling up near-duplicates
-- under slightly different names.
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK(scope IN ('personal', 'shared', 'global')),
  agent TEXT NOT NULL,
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  times_used INTEGER DEFAULT 0,
  times_succeeded INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(agent, project, scope, name)
);

-- Tiny settings store, currently just tracking which embedding model
-- produced the stored vectors (see the migration below).
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  value, key, content='memory', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, value, key) VALUES (new.id, new.value, new.key);
END;

CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, value, key) VALUES ('delete', old.id, old.value, old.key);
END;

CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, value, key) VALUES ('delete', old.id, old.value, old.key);
  INSERT INTO memory_fts(rowid, value, key) VALUES (new.id, new.value, new.key);
END;
`);

// Migration: add the embedding column to DBs created before semantic search
// existed. ALTER TABLE has no IF NOT EXISTS form, so guard with table_info.
const memoryCols = db.prepare('PRAGMA table_info(memory)').all().map(c => c.name);
if (!memoryCols.includes('embedding')) {
  db.exec('ALTER TABLE memory ADD COLUMN embedding BLOB');
}
// type='convention' marks project rules/standards rather than one-off facts
// or events - they don't decay the same way (a convention is still true
// whether or not anyone recalled it last week), so recall/recallRecent sort
// them first regardless of decay_score. CHECK can't be added via ALTER TABLE
// on existing SQLite versions, so it's enforced in JS (see remember()) only
// for rows written after this migration; that's fine, the column defaults
// every pre-existing row to 'fact' either way.
if (!memoryCols.includes('type')) {
  db.exec("ALTER TABLE memory ADD COLUMN type TEXT NOT NULL DEFAULT 'fact'");
}

// A stored embedding is only meaningful relative to the model that produced
// it - vectors from two different models have incompatible dimensions/
// geometry, and comparing them (see cosineSimilarity) would silently return
// garbage similarity scores instead of erroring. So: remember which model
// wrote the current embeddings, and if EMBEDDING_MODEL has changed since,
// wipe them all - backfillEmbeddings() lazily regenerates them under the
// new model on the next recall, same as a fresh row.
const storedModel = db.prepare("SELECT value FROM meta WHERE key = 'embedding_model'").get();
if (!storedModel || storedModel.value !== EMBEDDING_MODEL) {
  db.exec('UPDATE memory SET embedding = NULL WHERE embedding IS NOT NULL');
  db.prepare("INSERT INTO meta (key, value) VALUES ('embedding_model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(EMBEDDING_MODEL);
}

function normalize(text) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function remember({ scope, agent, project, key, value, type = 'fact' }) {
  const now = Date.now();
  const normValue = normalize(value);

  // global entries aren't tied to a project: dedup by agent + text only, so
  // the same fact remembered from different projects reinforces one row
  // instead of creating a duplicate per project. personal/shared stay
  // project-scoped exactly as before. type is part of the dedup key too -
  // the same sentence stored once as a fact and once as a convention should
  // stay two distinct rows, not merge into whichever was written first.
  let candSql = 'SELECT id, value FROM memory WHERE scope = ? AND type = ?';
  const candParams = [scope, type];
  if (scope === 'global') {
    candSql += ' AND agent = ?';
    candParams.push(agent);
  } else {
    candSql += ' AND project = ?';
    candParams.push(project);
    if (scope === 'personal') {
      candSql += ' AND agent = ?';
      candParams.push(agent);
    }
  }
  const candidates = db.prepare(candSql).all(...candParams);
  const existing = candidates.find(c => normalize(c.value) === normValue);

  if (existing) {
    db.prepare('UPDATE memory SET times_recalled = times_recalled + 1, updated_at = ? WHERE id = ?')
      .run(now, existing.id);
    return { id: existing.id, deduped: true };
  }

  const stmt = db.prepare(`
    INSERT INTO memory (scope, agent, project, key, value, type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(scope, agent, project, key || null, value, type, now, now);
  return { id: info.lastInsertRowid, deduped: false };
}

// Builds the scope/project/agent visibility filter shared by recall(),
// recallRecent() and semanticCandidates() - kept in one place so the three
// read paths can never drift out of sync on who can see what.
// admin=true drops the personal/global agent-isolation filter entirely (but
// keeps project scoping for personal/shared, and keeps global project-
// agnostic). Only meant for the human-facing cli.js search command, where
// there's no single "current agent" to filter by and the whole point is
// letting the machine owner see everything visible to any agent - the same
// data they could already read straight out of the SQLite file. Never used
// by the MCP server (agents always pass their real `agent`, admin stays
// false there).
function visibilityClause({ scope, project, agent, admin }) {
  if (scope === 'global') {
    // global entries aren't tied to a project: this agent's global entries
    // are visible no matter which project is asking.
    return admin
      ? { sql: 'm.scope = ?', params: ['global'] }
      : { sql: 'm.scope = ? AND m.agent = ?', params: ['global', agent] };
  }
  if (scope) {
    return { sql: 'm.project = ? AND m.scope = ?', params: [project, scope] };
  }
  if (admin) {
    return {
      sql: `(m.project = ? AND m.scope IN ('shared', 'personal')) OR m.scope = 'global'`,
      params: [project],
    };
  }
  return {
    sql: `(m.project = ? AND (m.scope = 'shared' OR (m.scope = 'personal' AND m.agent = ?))) OR (m.scope = 'global' AND m.agent = ?)`,
    params: [project, agent, agent],
  };
}

function touchRows(ids) {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE memory SET times_recalled = times_recalled + 1 WHERE id IN (${placeholders})`).run(...ids);
}

// FTS5's default operator between space-separated terms is AND - a query
// only matches if EVERY word is present. Fine for one word, brittle for
// several (one word not appearing verbatim kills the whole search). Try the
// strict AND match first (most precise); if that finds nothing, retry with
// OR so a partial word-overlap still surfaces something instead of zero.
// Each word is wrapped in a quoted FTS5 prefix-query ("word"*) rather than a
// bare word*. Bare words let FTS5's query-syntax parser interpret characters
// like "-" or ":" as operators (e.g. "force-push*" parses as a NOT/column
// filter, not the literal word) - quoting forces it to be treated as a
// single string literal instead. Internal double quotes are escaped by
// doubling them, the standard FTS5 quoting rule.
function buildFtsQueries(query) {
  const words = query.trim().split(/\s+/).filter(Boolean)
    .map(w => `"${w.toLowerCase().replace(/"/g, '""')}"*`);
  return { and: words.join(' '), or: words.join(' OR ') };
}

// key IN ('UserPromptSubmit', 'PostToolUse') rows are the hook adapter's raw
// process capture (see adapters/claude-code/capture.js) - what the user
// typed, or which shell command ran - neither is ever the *answer* to a
// question. Left in the candidate pool, UserPromptSubmit rows in particular
// crowd real answers out of the top-K (a re-asked question's closest match
// is almost always another stored question, not its answer) - measured via
// `node cli.js verify`: excluding them raised the real-answer hit rate from
// 3% to 13% on this installation's own history. They're still stored and
// still visible via `node cli.js search`/`list` for a human - this only
// excludes them from being a *recall result*.
// IS NULL branch matters: most rows (anything written via memory_remember/
// memory_convention/etc.) have key = NULL, and in SQL `NULL NOT IN (...)`
// evaluates to NULL (not true) - a bare `m.key NOT IN (...)` would silently
// exclude every NULL-key row too, not just the noisy ones.
const EXCLUDE_PROMPTS_CLAUSE = "(m.key IS NULL OR m.key NOT IN ('UserPromptSubmit', 'PostToolUse'))";

function runFtsQuery(matchQuery, visibility, limit) {
  const sql = `
    SELECT m.id, m.scope, m.agent, m.key, m.value, m.type, m.outcome, m.times_recalled, m.created_at
    FROM memory_fts f
    JOIN memory m ON m.id = f.rowid
    WHERE memory_fts MATCH ? AND (${visibility.sql}) AND ${EXCLUDE_PROMPTS_CLAUSE}
    ORDER BY m.type = 'convention' DESC, m.outcome = 'success' DESC, decay_score(m.times_recalled, m.updated_at) DESC, rank
    LIMIT ?
  `;
  return db.prepare(sql).all(matchQuery, ...visibility.params, limit);
}

// Keyword-match candidates only, no side effects (doesn't touch
// times_recalled) - the building block shared by recall() and recallHybrid().
function ftsCandidates({ query, project, scope, agent, limit = 10, admin = false }) {
  const visibility = visibilityClause({ scope, project, agent, admin });
  const { and, or } = buildFtsQueries(query);
  let rows = runFtsQuery(and, visibility, limit);
  if (rows.length === 0 && and !== or) {
    rows = runFtsQuery(or, visibility, limit);
  }
  return rows;
}

function recall({ query, project, scope, agent, limit = 10, admin = false }) {
  const rows = ftsCandidates({ query, project, scope, agent, limit, admin });
  touchRows(rows.map(r => r.id));
  return rows;
}

// Like recall(), but for when there's no text query yet (e.g. session start):
// plain SELECT ordered by the same outcome/decay ranking, no FTS/MATCH
// involved. Doesn't touch times_recalled - viewing the startup summary isn't
// a real "recall" of a specific fact.
function recallRecent({ project, agent, limit = 20 }) {
  const sql = `
    SELECT id, scope, agent, key, value, type, outcome, times_recalled, created_at
    FROM memory
    WHERE (project = ? AND (scope = 'shared' OR (scope = 'personal' AND agent = ?)))
       OR (scope = 'global' AND agent = ?)
    ORDER BY type = 'convention' DESC, outcome = 'success' DESC, decay_score(times_recalled, updated_at) DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(project, agent, agent, limit);
}

// --- Semantic search (local, free, offline - see EMBEDDING_MODEL above) ---

let embedderPromise = null;
function getEmbedder() {
  if (!embedderPromise) {
    const { pipeline } = require('@huggingface/transformers');
    embedderPromise = pipeline('feature-extraction', EMBEDDING_MODEL);
  }
  return embedderPromise;
}

// isQuery picks which of EmbeddingGemma's two prompt prefixes to use (see
// QUERY_PREFIX/PASSAGE_PREFIX above) - a search query and a stored fact are
// embedded with different prefixes on purpose, per the model's training.
async function embedText(text, { isQuery = false } = {}) {
  const embedder = await getEmbedder();
  const prefixed = (isQuery ? QUERY_PREFIX : PASSAGE_PREFIX) + text;
  const output = await embedder(prefixed, { pooling: 'mean', normalize: true });
  return Float32Array.from(output.data);
}

// Float32Array <-> BLOB. Copies through a fresh typed array on both ends
// instead of viewing the raw buffer/Node Buffer directly - sqlite BLOBs and
// pooled Node Buffers aren't guaranteed 4-byte aligned, which a live view
// would silently get wrong.
function vectorToBuffer(vec) {
  return Buffer.from(Float32Array.from(vec).buffer);
}

function bufferToVector(buf) {
  return new Float32Array(Uint8Array.from(buf).buffer);
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function storeEmbedding(id, vec) {
  db.prepare('UPDATE memory SET embedding = ? WHERE id = ?').run(vectorToBuffer(vec), id);
}

async function embedAndStore(id, text) {
  const vec = await embedText(text);
  storeEmbedding(id, vec);
  return vec;
}

// Fills in embeddings for rows written before semantic search existed, or
// written via the lightweight hook path (see server.js HIVE_MEMORY_LIGHTWEIGHT)
// which skips embedding to keep hook latency near zero. Idempotent and safe
// to call on every recall - a no-op once the backlog is caught up. Stops
// quietly (not a thrown error) if the model can't load, e.g. first run with
// no internet to fetch it - plain keyword search still works either way.
async function backfillEmbeddings({ batchLimit = 200 } = {}) {
  const rows = db.prepare('SELECT id, value FROM memory WHERE embedding IS NULL LIMIT ?').all(batchLimit);
  let done = 0;
  for (const row of rows) {
    try {
      const vec = await embedText(row.value);
      storeEmbedding(row.id, vec);
      done++;
    } catch (err) {
      break;
    }
  }
  return done;
}

function semanticCandidates({ queryVec, project, scope, agent, limit = 10, admin = false }) {
  const visibility = visibilityClause({ scope, project, agent, admin });
  const sql = `
    SELECT m.id, m.scope, m.agent, m.key, m.value, m.type, m.outcome, m.times_recalled, m.created_at, m.embedding
    FROM memory m
    WHERE (${visibility.sql}) AND m.embedding IS NOT NULL AND ${EXCLUDE_PROMPTS_CLAUSE}
  `;
  const rows = db.prepare(sql).all(...visibility.params);
  const scored = rows.map(r => ({ ...r, similarity: cosineSimilarity(queryVec, bufferToVector(r.embedding)) }));
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit).map(({ embedding, similarity, ...rest }) => rest);
}

// --- Reranker (local, free, offline - see RERANKER_MODEL above) ---

let rerankerPromise = null;
function getReranker() {
  if (!rerankerPromise) {
    const { AutoTokenizer, AutoModelForSequenceClassification } = require('@huggingface/transformers');
    rerankerPromise = Promise.all([
      AutoTokenizer.from_pretrained(RERANKER_MODEL),
      AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL, { dtype: 'int8' }),
    ]);
  }
  return rerankerPromise;
}

// Re-sorts `rows` by how well each one actually answers `query`, scored one
// pair at a time (query, row.value) rather than by comparing two
// pre-computed vectors - slower, but far more accurate at telling a real
// answer apart from something merely topic-adjacent (see RERANKER_MODEL
// comment for measured numbers). Returns rows unchanged, in their original
// order, if the model can't load - reranking is a quality improvement on
// top of recallHybrid's fused order, never a hard requirement for it.
async function rerank(query, rows) {
  if (rows.length === 0) return rows;
  try {
    const [tokenizer, model] = await getReranker();
    const scored = [];
    for (const row of rows) {
      const inputs = tokenizer([query], { text_pair: [row.value], padding: true, truncation: true });
      const { logits } = await model(inputs);
      scored.push({ row, score: logits.data[0] });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.row);
  } catch (err) {
    console.error('hive-memory: reranker unavailable, keeping fused search order:', err.message);
    return rows;
  }
}

// Combines keyword search (FTS5) with meaning-based search (local embedding
// cosine similarity) via reciprocal rank fusion: each ranked list contributes
// 1/(60+rank) per hit, so a fact only one method finds still surfaces, and
// one found by both ranks highest. Falls back to keyword-only if the
// embedding model can't load - never hard-fails a search over it. The fused
// pool is then reranked (see rerank() above) before being cut down to
// `limit` - fusion picks a rough top pool fast, the reranker picks the best
// few out of that pool carefully.
// skipRerank is a diagnostic escape hatch (used by cli.js verify --stage),
// not something normal callers should pass - it answers "did the fast rough
// sort even pick this up" separately from "did the careful second pass rank
// it highly", without paying the reranker's per-candidate cost.
async function recallHybrid({ query, project, scope, agent, limit = 10, admin = false, skipRerank = false }) {
  const poolSize = Math.max(limit * 4, 20);
  const ftsRows = ftsCandidates({ query, project, scope, agent, limit: poolSize, admin });

  let semRows = [];
  try {
    await backfillEmbeddings();
    const queryVec = await embedText(query, { isQuery: true });
    semRows = semanticCandidates({ queryVec, project, scope, agent, limit: poolSize, admin });
  } catch (err) {
    console.error('hive-memory: semantic recall unavailable, falling back to keyword-only:', err.message);
  }

  const RRF_K = 60;
  const fused = new Map();
  ftsRows.forEach((row, i) => fused.set(row.id, { row, score: 1 / (RRF_K + i + 1) }));
  semRows.forEach((row, i) => {
    const add = 1 / (RRF_K + i + 1);
    const existing = fused.get(row.id);
    if (existing) existing.score += add;
    else fused.set(row.id, { row, score: add });
  });

  const pool = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, poolSize).map(m => m.row);
  const reranked = skipRerank ? pool : await rerank(query, pool);
  const rows = reranked.slice(0, limit);
  touchRows(rows.map(r => r.id));
  return rows;
}

function markOutcome({ id, outcome }) {
  db.prepare('UPDATE memory SET outcome = ?, updated_at = ? WHERE id = ?').run(outcome, Date.now(), id);
  return { ok: true };
}

// Fixes a stored entry in place instead of leaving the wrong text around and
// remembering a corrected duplicate next to it. Clears the embedding so the
// next recallHybrid() call re-embeds the corrected text via its existing
// lazy-backfill path (see backfillEmbeddings) - correctMemory itself stays
// sync so it doesn't need to load the embedding model.
function correctMemory({ id, value }) {
  const info = db.prepare('UPDATE memory SET value = ?, embedding = NULL, updated_at = ? WHERE id = ?')
    .run(value, Date.now(), id);
  return { ok: info.changes > 0 };
}

// Explicit "this is still true/relevant" signal, distinct from the implicit
// touchRows() bump that recall()/recallHybrid() do on every hit. Also resets
// updated_at (recall hits don't), so decay_score treats it as freshly
// confirmed rather than just counted.
function touchMemory(id) {
  const info = db.prepare('UPDATE memory SET times_recalled = times_recalled + 1, updated_at = ? WHERE id = ?')
    .run(Date.now(), id);
  return { ok: info.changes > 0 };
}

// relation defaults to '' (not stored as NULL) so the UNIQUE(from_id, to_id,
// relation) constraint actually catches repeat links - see table comment.
function addLink({ fromId, toId, relation }) {
  const info = db.prepare(`
    INSERT OR IGNORE INTO memory_links (from_id, to_id, relation, created_at)
    VALUES (?, ?, ?, ?)
  `).run(fromId, toId, relation || '', Date.now());
  return { ok: true, created: info.changes > 0 };
}

// Links are undirected for lookup purposes - a row shows up whether it was
// stored as from_id or to_id - `direction` tells the caller which side this
// entry was on, in case a relation label reads one way ("supersedes").
function getLinks(id) {
  return db.prepare(`
    SELECT l.relation,
           CASE WHEN l.from_id = ? THEN 'to' ELSE 'from' END AS direction,
           m.id AS other_id, m.scope AS other_scope, m.agent AS other_agent, m.value AS other_value
    FROM memory_links l
    JOIN memory m ON m.id = (CASE WHEN l.from_id = ? THEN l.to_id ELSE l.from_id END)
    WHERE l.from_id = ? OR l.to_id = ?
    ORDER BY l.created_at DESC
  `).all(id, id, id, id);
}

// --- Sessions (for memory_replay - recap of the previous session) ---

// Idempotent: a session's SessionStart hook may fire more than once for the
// same session_key in edge cases (retries, multiple hook matchers) - INSERT
// OR IGNORE keeps the original started_at rather than resetting it.
function startSession({ sessionKey, agent, project }) {
  db.prepare(`
    INSERT OR IGNORE INTO sessions (session_key, agent, project, started_at)
    VALUES (?, ?, ?, ?)
  `).run(sessionKey, agent, project, Date.now());
  return { ok: true };
}

function endSession({ sessionKey, summary }) {
  const info = db.prepare('UPDATE sessions SET ended_at = ?, summary = ? WHERE session_key = ?')
    .run(Date.now(), summary || null, sessionKey);
  return { ok: info.changes > 0 };
}

// The current (in-progress) session has ended_at IS NULL, so it's
// automatically excluded here without needing to know its own session_key -
// this always returns the most recently *finished* session.
function getLastEndedSession({ agent, project }) {
  return db.prepare(`
    SELECT session_key, started_at, ended_at, summary
    FROM sessions
    WHERE agent = ? AND project = ? AND ended_at IS NOT NULL
    ORDER BY ended_at DESC
    LIMIT 1
  `).get(agent, project);
}

// --- Skills (reusable task recipes - see skills table comment) ---

// Upserts by (agent, project, scope, name): a second save under the same
// name refines the existing recipe (new body, bumped updated_at) instead of
// piling up near-duplicates.
function skillSave({ scope, agent, project, name, body }) {
  const now = Date.now();
  const existing = db.prepare('SELECT id FROM skills WHERE agent = ? AND project = ? AND scope = ? AND name = ?')
    .get(agent, project, scope, name);
  if (existing) {
    db.prepare('UPDATE skills SET body = ?, updated_at = ? WHERE id = ?').run(body, now, existing.id);
    return { id: existing.id, updated: true };
  }
  const info = db.prepare(`
    INSERT INTO skills (scope, agent, project, name, body, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(scope, agent, project, name, body, now, now);
  return { id: info.lastInsertRowid, updated: false };
}

// Same personal/shared/global visibility rule as memory (see
// visibilityClause) - plain LIKE match, not FTS: skill sets are small
// (dozens, not thousands of rows) so an index-free scan is plenty fast and
// avoids standing up a second FTS5 table just for this.
function skillMatch({ query, project, agent, limit = 5, admin = false }) {
  const visibility = visibilityClause({ scope: undefined, project, agent, admin });
  // Every word must appear somewhere (name OR body) - matching on the whole
  // query as one substring would miss "deploy staging" against a skill
  // named "deploy-staging" just because the words aren't adjacent with
  // exactly that spacing/punctuation.
  const words = query.trim().split(/\s+/).filter(Boolean).map(w => `%${w.toLowerCase()}%`);
  const wordClauses = words.map(() => '(LOWER(name) LIKE ? OR LOWER(body) LIKE ?)').join(' AND ');
  const wordParams = words.flatMap(w => [w, w]);
  const sql = `
    SELECT id, scope, agent, name, body, times_used, times_succeeded, updated_at
    FROM skills m
    WHERE (${visibility.sql}) AND (${wordClauses})
    ORDER BY (CAST(times_succeeded AS REAL) / (times_used + 1)) DESC, times_used DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(...visibility.params, ...wordParams, limit);
}

function skillScore({ id, outcome }) {
  const sql = outcome === 'success'
    ? 'UPDATE skills SET times_used = times_used + 1, times_succeeded = times_succeeded + 1, updated_at = ? WHERE id = ?'
    : 'UPDATE skills SET times_used = times_used + 1, updated_at = ? WHERE id = ?';
  const info = db.prepare(sql).run(Date.now(), id);
  return { ok: info.changes > 0 };
}

// --- Premortem ("what could go wrong before I do this") ---

// Runs the normal hybrid search, then narrows it to just the two kinds of
// rows that actually represent risk: outcome='failure' (a lesson from a past
// mistake) and type='convention' (a rule that could be violated). A relevant
// outcome='success' or outcome='unknown' fact isn't a risk signal, so it's
// filtered out here even though the search matched it.
async function premortem({ query, project, scope, agent, limit = 8, admin = false }) {
  const pool = await recallHybrid({ query, project, scope, agent, limit: Math.max(limit * 4, 30), admin });
  return pool.filter(r => r.outcome === 'failure' || r.type === 'convention').slice(0, limit);
}

// --- Verify: does recall actually find things again? (node cli.js verify) ---

// Auto-generates a ground-truth test set from real history instead of hand-
// written fixtures: every captured UserPromptSubmit row that's a real
// question (long enough to be substantive) is paired with whichever Stop
// row landed right after it (same agent/project - PostToolUse rows are
// usually interspersed between them, that's fine). This gives "if I ask
// this again, does recall find the answer I got last time" pairs for free,
// drawn from what this exact installation has actually been asked.
//
// The candidate Stop must land before the user's *next* prompt, not just
// within a fixed id window - otherwise a prompt with no clean single-turn
// reply (the topic moved on before a Stop fired) could get paired with a
// Stop that actually answers a *later* question, producing a fixture whose
// "ground truth" answer is simply wrong. MAX_WINDOW is a backstop for the
// rare case for the very last prompt in history in a large PostToolUse
// batch, not the primary boundary.
const MAX_ANSWER_WINDOW = 20;

function extractQaFixtures({ project, agent, sampleSize = 20 }) {
  const prompts = db.prepare(`
    SELECT id, value FROM memory
    WHERE project = ? AND agent = ? AND key = 'UserPromptSubmit' AND LENGTH(value) > 30
    ORDER BY id DESC
  `).all(project, agent);

  const fixtures = [];
  for (const p of prompts) {
    if (fixtures.length >= sampleSize) break;

    const nextPrompt = db.prepare(`
      SELECT id FROM memory
      WHERE project = ? AND agent = ? AND key = 'UserPromptSubmit' AND id > ?
      ORDER BY id ASC LIMIT 1
    `).get(project, agent, p.id);
    const upperBound = nextPrompt
      ? Math.min(nextPrompt.id - 1, p.id + MAX_ANSWER_WINDOW)
      : p.id + MAX_ANSWER_WINDOW;

    const answer = db.prepare(`
      SELECT id, value FROM memory
      WHERE project = ? AND agent = ? AND key = 'Stop' AND id > ? AND id <= ?
      ORDER BY id ASC LIMIT 1
    `).get(project, agent, p.id, upperBound);
    if (!answer) continue;
    fixtures.push({
      questionId: p.id,
      question: p.value.replace(/^UserPromptSubmit:\s*/, ''),
      answerId: answer.id,
      answerSnippet: answer.value.replace(/^Stop:\s*/, '').slice(0, 120),
    });
  }
  return fixtures;
}

// For each fixture, re-asks the question text as a memory_recall query and
// checks whether the matching answer row comes back in the top K - both via
// the real hybrid search (query-aware) and via plain recallRecent
// (chronological dump, no query awareness - the closest thing to "no real
// retrieval, just skim what's recent"). The gap between the two numbers is
// what query-aware recall is actually buying over a bare recent-N log.
async function verifyRetrieval({ project, agent, sampleSize = 20, k = 5 }) {
  const fixtures = extractQaFixtures({ project, agent, sampleSize });
  const results = [];
  for (const f of fixtures) {
    // Pull a wider pool than k so answersOnlyHit (below) can re-rank within
    // it - the raw top-k is dominated by other UserPromptSubmit rows that
    // are textually similar to the query (a re-asked question looks most
    // like other questions, not like its own answer), so scoring only the
    // literal top-k would hide how much of the miss is "wrong kind of row"
    // versus "answer just isn't findable at all".
    const pool = await recallHybrid({ query: f.question, project, agent, limit: Math.max(k * 6, 30), admin: false, scope: undefined });
    const hybridRows = pool.slice(0, k);
    const hybridHit = hybridRows.some(r => r.id === f.answerId);
    const hybridRank = hybridRows.findIndex(r => r.id === f.answerId);

    const answersOnly = pool.filter(r => r.key === 'Stop').slice(0, k);
    const answersOnlyHit = answersOnly.some(r => r.id === f.answerId);

    const recentRows = recallRecent({ project, agent, limit: k });
    const recentHit = recentRows.some(r => r.id === f.answerId);

    results.push({ ...f, hybridHit, hybridRank: hybridHit ? hybridRank + 1 : null, answersOnlyHit, recentHit });
  }

  const n = results.length;
  const hybridHits = results.filter(r => r.hybridHit).length;
  const answersOnlyHits = results.filter(r => r.answersOnlyHit).length;
  const recentHits = results.filter(r => r.recentHit).length;
  const mrr = n === 0 ? 0 : results.reduce((sum, r) => sum + (r.hybridHit ? 1 / r.hybridRank : 0), 0) / n;

  return {
    k,
    sampleSize: n,
    hybridRecall: { hits: hybridHits, rate: n === 0 ? 0 : hybridHits / n, mrr },
    answersOnlyRecall: { hits: answersOnlyHits, rate: n === 0 ? 0 : answersOnlyHits / n },
    recentOnlyRecall: { hits: recentHits, rate: n === 0 ? 0 : recentHits / n },
    results,
  };
}

function stats({ project }) {
  const total = db.prepare('SELECT COUNT(*) as n FROM memory WHERE project = ?').get(project);
  const byScope = db.prepare('SELECT scope, COUNT(*) as n FROM memory WHERE project = ? GROUP BY scope').all(project);
  const latest = db.prepare('SELECT value, created_at FROM memory WHERE project = ? ORDER BY created_at DESC LIMIT 1').get(project);
  const embedded = db.prepare('SELECT COUNT(*) as n FROM memory WHERE project = ? AND embedding IS NOT NULL').get(project);
  return { total: total.n, byScope, latest, embedded: embedded.n };
}

// Unfiltered admin listing for the human operator via cli.js. No agent
// isolation here on purpose - the personal/global barrier exists to keep
// agents from reading each other's entries, not to hide data from the
// person who already has direct filesystem access to the SQLite file.
// project/scope/agent are all optional; omitted ones aren't filtered.
function listAll({ project, scope, agent, limit = 50 } = {}) {
  let sql = 'SELECT id, scope, agent, project, key, value, outcome, times_recalled, created_at, updated_at FROM memory WHERE 1=1';
  const params = [];
  if (project) {
    sql += ' AND project = ?';
    params.push(project);
  }
  if (scope) {
    sql += ' AND scope = ?';
    params.push(scope);
  }
  if (agent) {
    sql += ' AND agent = ?';
    params.push(agent);
  }
  sql += ' ORDER BY updated_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

module.exports = {
  remember,
  recall,
  recallRecent,
  recallHybrid,
  backfillEmbeddings,
  embedText,
  embedAndStore,
  rerank,
  markOutcome,
  correctMemory,
  touchMemory,
  addLink,
  getLinks,
  startSession,
  endSession,
  getLastEndedSession,
  skillSave,
  skillMatch,
  skillScore,
  premortem,
  extractQaFixtures,
  verifyRetrieval,
  stats,
  listAll,
  DB_PATH,
};
