import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { dbPath } from './config';
import type { SelfSpend } from './types';

export type DB = Database.Database;

/**
 * Schema notes:
 *  - sessions/turns/tool_calls/findings/meta follow SPEC §4.2.
 *  - sessions.waste_score: local heuristic waste ranking.
 *  - nudges: audit log for the live hook (every invocation, fired or
 *    suppressed, per SPEC §5.3).
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, project TEXT, started_at INTEGER, ended_at INTEGER,
  model TEXT, turn_count INTEGER, abandoned INTEGER DEFAULT 0,
  waste_score REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY, session_id TEXT REFERENCES sessions(id),
  idx INTEGER, role TEXT, ts INTEGER, char_len INTEGER,
  is_correction INTEGER DEFAULT 0,
  input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  -- First 8KB of real user prompts only (heuristics: lexicon, shingles).
  -- Assistant turns and tool results stay NULL.
  text_head TEXT,
  -- Whether the full user prompt contained a fenced code block.
  has_fence INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS turns_session_idx ON turns(session_id, idx);
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY, turn_id INTEGER REFERENCES turns(id),
  tool TEXT, target TEXT
);
CREATE INDEX IF NOT EXISTS tool_calls_turn ON tool_calls(turn_id);
CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY, session_id TEXT, category TEXT, confidence REAL,
  evidence TEXT, suggestion TEXT, created_at INTEGER, source TEXT,
  -- For missing_convention / resupplied_context: a single CLAUDE.md-ready
  -- line, aggregated into the per-project proposed diff.
  claude_md_line TEXT
);
CREATE INDEX IF NOT EXISTS findings_session ON findings(session_id);
CREATE INDEX IF NOT EXISTS findings_category ON findings(category);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS nudges (
  id INTEGER PRIMARY KEY, session_id TEXT, project TEXT, ts INTEGER,
  fired INTEGER DEFAULT 0, pattern TEXT, message TEXT
);
CREATE INDEX IF NOT EXISTS nudges_session ON nudges(session_id);
CREATE INDEX IF NOT EXISTS nudges_ts ON nudges(ts);
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY, ts INTEGER, model TEXT,
  input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  request_path TEXT, streaming INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_events_ts ON usage_events(ts);
CREATE TABLE IF NOT EXISTS llm_batches (
  id TEXT PRIMARY KEY, submitted_at INTEGER, status TEXT,
  session_ids TEXT, model TEXT
);
`;

/**
 * Open (creating if needed) the LLMGuide database.
 * WAL + short busy timeout: the hook and the analyzer may run concurrently,
 * and the hook must never wait long or crash on lock contention.
 */
export function openDb(filePath?: string): DB {
  const p = filePath || dbPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 200');
  db.exec(SCHEMA_SQL);
  return db;
}

export function metaGet(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function metaSet(db: DB, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export function metaDel(db: DB, key: string): void {
  db.prepare('DELETE FROM meta WHERE key = ?').run(key);
}

export function metaGetJson<T>(db: DB, key: string): T | null {
  const raw = metaGet(db, key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function metaSetJson(db: DB, key: string, value: unknown): void {
  metaSet(db, key, JSON.stringify(value));
}

const SELF_SPEND_KEY = 'self_spend';

/** Accumulate LLMGuide's own analysis spend (SPEC §4.4 self-accounting). */
export function addSelfSpend(db: DB, delta: SelfSpend): SelfSpend {
  const cur = getSelfSpend(db);
  const next: SelfSpend = {
    inputTokens: cur.inputTokens + delta.inputTokens,
    outputTokens: cur.outputTokens + delta.outputTokens,
    usd: cur.usd + delta.usd,
  };
  metaSetJson(db, SELF_SPEND_KEY, next);
  return next;
}

export function getSelfSpend(db: DB): SelfSpend {
  return (
    metaGetJson<SelfSpend>(db, SELF_SPEND_KEY) || {
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
    }
  );
}
