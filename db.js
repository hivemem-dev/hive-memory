const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.HIVE_MEMORY_DB || path.join(process.cwd(), 'hive-memory.db');

// Half-life (days) for recall ranking decay: a record with no new recalls
// loses half its effective weight after this many days. Doesn't delete or
// touch stored data, only how recall() orders results.
const HALF_LIFE_DAYS = 30;

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

// admin=true drops the personal/global agent-isolation filter entirely (but
// keeps project scoping for personal/shared, and keeps global project-
// agnostic). Only meant for the human-facing cli.js search command, where
// there's no single "current agent" to filter by and the whole point is
// letting the machine owner see everything visible to any agent - the same
// data they could already read straight out of the SQLite file. Never used
// by the MCP server (agents always pass their real `agent`, admin stays
// false there).
function recall({ query, project, scope, agent, limit = 10, admin = false }) {
  let sql = `
    SELECT m.id, m.scope, m.agent, m.key, m.value, m.outcome, m.times_recalled, m.created_at
    FROM memory_fts f
    JOIN memory m ON m.id = f.rowid
    WHERE memory_fts MATCH ?
  `;
  const ftsQuery = query.trim().split(/\s+/).map(w => `${w}*`).join(' ');
  const params = [ftsQuery];

  if (scope === 'global') {
    // global entries aren't tied to a project: this agent's global entries
    // are visible no matter which project is asking.
    sql += admin ? ' AND m.scope = ?' : ' AND m.scope = ? AND m.agent = ?';
    params.push('global');
    if (!admin) params.push(agent);
  } else if (scope) {
    sql += ' AND m.project = ? AND m.scope = ?';
    params.push(project, scope);
  } else if (admin) {
    sql += ` AND ((m.project = ? AND m.scope IN ('shared', 'personal')) OR m.scope = 'global')`;
    params.push(project);
  } else {
    sql += ` AND (
      (m.project = ? AND (m.scope = 'shared' OR (m.scope = 'personal' AND m.agent = ?)))
      OR (m.scope = 'global' AND m.agent = ?)
    )`;
    params.push(project, agent, agent);
  }

  sql += " ORDER BY m.outcome = 'success' DESC, decay_score(m.times_recalled, m.updated_at) DESC, rank LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params);

  if (rows.length > 0) {
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE memory SET times_recalled = times_recalled + 1 WHERE id IN (${placeholders})`).run(...ids);
  }

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

function markOutcome({ id, outcome }) {
  db.prepare('UPDATE memory SET outcome = ?, updated_at = ? WHERE id = ?').run(outcome, Date.now(), id);
  return { ok: true };
}

function stats({ project }) {
  const total = db.prepare('SELECT COUNT(*) as n FROM memory WHERE project = ?').get(project);
  const byScope = db.prepare('SELECT scope, COUNT(*) as n FROM memory WHERE project = ? GROUP BY scope').all(project);
  const latest = db.prepare('SELECT value, created_at FROM memory WHERE project = ? ORDER BY created_at DESC LIMIT 1').get(project);
  return { total: total.n, byScope, latest };
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

module.exports = { remember, recall, recallRecent, markOutcome, stats, listAll, DB_PATH };
