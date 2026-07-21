const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.HIVE_MEMORY_DB || path.join(process.cwd(), 'hive-memory.db');

// Half-life (days) for recall ranking decay: a record with no new recalls
// loses half its effective weight after this many days. Doesn't delete or
// touch stored data, only how recall() orders results.
const HALF_LIFE_DAYS = 30;

// Local semantic search: this model runs fully offline/on-CPU via
// @huggingface/transformers, no API key and no per-call cost (only a
// one-time ~90MB model download, cached under ~/.cache). Keeps hive-memory
// free to run as often as the hooks fire.
const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

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

function normalize(text) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function remember({ scope, agent, project, key, value }) {
  const now = Date.now();
  const normValue = normalize(value);

  // global entries aren't tied to a project: dedup by agent + text only, so
  // the same fact remembered from different projects reinforces one row
  // instead of creating a duplicate per project. personal/shared stay
  // project-scoped exactly as before.
  let candSql = 'SELECT id, value FROM memory WHERE scope = ?';
  const candParams = [scope];
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
    INSERT INTO memory (scope, agent, project, key, value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(scope, agent, project, key || null, value, now, now);
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
function buildFtsQueries(query) {
  const words = query.trim().split(/\s+/).filter(Boolean).map(w => `${w.toLowerCase()}*`);
  return { and: words.join(' '), or: words.join(' OR ') };
}

function runFtsQuery(matchQuery, visibility, limit) {
  const sql = `
    SELECT m.id, m.scope, m.agent, m.key, m.value, m.outcome, m.times_recalled, m.created_at
    FROM memory_fts f
    JOIN memory m ON m.id = f.rowid
    WHERE memory_fts MATCH ? AND (${visibility.sql})
    ORDER BY m.outcome = 'success' DESC, decay_score(m.times_recalled, m.updated_at) DESC, rank
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
    SELECT id, scope, agent, key, value, outcome, times_recalled, created_at
    FROM memory
    WHERE (project = ? AND (scope = 'shared' OR (scope = 'personal' AND agent = ?)))
       OR (scope = 'global' AND agent = ?)
    ORDER BY outcome = 'success' DESC, decay_score(times_recalled, updated_at) DESC
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

async function embedText(text) {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
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
    SELECT m.id, m.scope, m.agent, m.key, m.value, m.outcome, m.times_recalled, m.created_at, m.embedding
    FROM memory m
    WHERE (${visibility.sql}) AND m.embedding IS NOT NULL
  `;
  const rows = db.prepare(sql).all(...visibility.params);
  const scored = rows.map(r => ({ ...r, similarity: cosineSimilarity(queryVec, bufferToVector(r.embedding)) }));
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit).map(({ embedding, similarity, ...rest }) => rest);
}

// Combines keyword search (FTS5) with meaning-based search (local embedding
// cosine similarity) via reciprocal rank fusion: each ranked list contributes
// 1/(60+rank) per hit, so a fact only one method finds still surfaces, and
// one found by both ranks highest. Falls back to keyword-only if the
// embedding model can't load - never hard-fails a search over it.
async function recallHybrid({ query, project, scope, agent, limit = 10, admin = false }) {
  const poolSize = Math.max(limit * 4, 20);
  const ftsRows = ftsCandidates({ query, project, scope, agent, limit: poolSize, admin });

  let semRows = [];
  try {
    await backfillEmbeddings();
    const queryVec = await embedText(query);
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

  const merged = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  const rows = merged.map(m => m.row);
  touchRows(rows.map(r => r.id));
  return rows;
}

function markOutcome({ id, outcome }) {
  db.prepare('UPDATE memory SET outcome = ?, updated_at = ? WHERE id = ?').run(outcome, Date.now(), id);
  return { ok: true };
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
  markOutcome,
  stats,
  listAll,
  DB_PATH,
};
