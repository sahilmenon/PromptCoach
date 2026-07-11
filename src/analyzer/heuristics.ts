import type { DB } from '../db';
import { metaGet, metaSetJson } from '../db';
import { CACHED_READ_WEIGHT } from '../constants';
import type { HeuristicsResult } from '../types';

const CORRECTION = /^(?:no\b|actually\b|that's wrong\b|that is wrong\b|undo\b|i meant\b|not what i meant\b|please revert\b)/i;
const DAY = 86_400_000;
const snippet = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 200);

function shingles(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9_./-]+/g, ' ').trim().split(/\s+/);
  const out = new Set<string>();
  for (let i = 0; i <= words.length - 5; i++) out.add(words.slice(i, i + 5).join(' '));
  return out;
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const item of a) if (b.has(item)) overlap++;
  return overlap / (a.size + b.size - overlap);
}

export function runHeuristics(db: DB, opts?: { log?: (msg: string) => void }): HeuristicsResult {
  const sessions = db.prepare('SELECT id, project FROM sessions ORDER BY id').all() as {
    id: string; project: string | null;
  }[];
  const turns = db.prepare(
    'SELECT id, session_id, idx, role, char_len, text_head, has_fence FROM turns ORDER BY session_id, idx'
  ).all() as { id: number; session_id: string; idx: number; role: string; char_len: number; text_head: string | null; has_fence: number }[];
  const insert = db.prepare(
    "INSERT INTO findings (session_id, category, confidence, evidence, suggestion, created_at, source) VALUES (?, ?, ?, ?, ?, ?, 'heuristic')"
  );
  const bySession = new Map<string, typeof turns>();
  for (const turn of turns) {
    const group = bySession.get(turn.session_id) ?? [];
    group.push(turn);
    bySession.set(turn.session_id, group);
  }
  let added = 0;
  db.transaction(() => {
    db.prepare("DELETE FROM findings WHERE source = 'heuristic'").run();
    db.prepare('UPDATE turns SET is_correction = 0').run();
    for (const session of sessions) {
      const own = bySession.get(session.id) ?? [];
      let score = 0;
      const correctionIndexes: number[] = [];
      for (const turn of own) {
        if (turn.role === 'user' && turn.text_head && CORRECTION.test(turn.text_head.trim())) {
          db.prepare('UPDATE turns SET is_correction = 1 WHERE id = ?').run(turn.id);
          correctionIndexes.push(turn.idx);
          insert.run(session.id, 'correction_turn', 0.9, snippet(turn.text_head),
            'State the correction as a reusable constraint when it applies to future sessions.', Date.now());
          score += 2; added++;
        }
        if (turn.role === 'user' && turn.char_len > 8000 && turn.has_fence === 1) {
          insert.run(session.id, 'oversized_paste', 0.95,
            'User prompt contained ' + turn.char_len + ' characters and a fenced code block.',
            'Reference the file path when Claude can read the source locally.', Date.now());
          score += 2; added++;
        }
      }
      const repeated = db.prepare(
        "SELECT target, COUNT(*) AS n FROM tool_calls tc JOIN turns t ON t.id=tc.turn_id WHERE t.session_id=? AND lower(tc.tool)='read' AND target IS NOT NULL GROUP BY target HAVING COUNT(*)>=3"
      ).all(session.id) as { target: string; n: number }[];
      for (const row of repeated) {
        insert.run(session.id, 'repeated_file_read', 0.85,
          row.target + ' was read ' + row.n + ' times in one session.',
          'Add stable file-location or architecture guidance to CLAUDE.md.', Date.now());
        score += row.n - 1; added++;
      }
      const lastCorrection = correctionIndexes.at(-1);
      const abandoned = own.length < 3 || (lastCorrection !== undefined && own.length - 1 - lastCorrection <= 2);
      if (abandoned) {
        insert.run(session.id, 'abandonment', 0.7,
          own.length < 3 ? 'Session ended after ' + own.length + ' turns.' : 'Session ended within two turns of a correction.',
          'Use a narrower opening task with one explicit acceptance check.', Date.now());
        score += 1; added++;
      }
      db.prepare('UPDATE sessions SET abandoned=?, waste_score=? WHERE id=?').run(abandoned ? 1 : 0, score, session.id);
    }
    const projectBySession = new Map(sessions.map(s => [s.id, s.project ?? '']));
    const prompts = turns.filter(t => t.role === 'user' && (t.text_head?.length ?? 0) >= 200)
      .map(t => ({ ...t, project: projectBySession.get(t.session_id) ?? '', set: shingles(t.text_head!) }));
    const used = new Set<number>();
    for (let i = 0; i < prompts.length; i++) {
      if (used.has(i)) continue;
      const cluster = [i];
      for (let j = i + 1; j < prompts.length; j++) {
        if (prompts[i].project === prompts[j].project && similarity(prompts[i].set, prompts[j].set) >= 0.75) cluster.push(j);
      }
      const ids = [...new Set(cluster.map(k => prompts[k].session_id))];
      if (ids.length < 3) continue;
      cluster.forEach(k => used.add(k));
      for (const id of ids) {
        insert.run(id, 'resupplied_context', 0.88, snippet(prompts[i].text_head!),
          'Move this repeated context into CLAUDE.md or another project file and reference it.', Date.now());
        db.prepare('UPDATE sessions SET waste_score=waste_score+3 WHERE id=?').run(id);
        added++;
      }
    }
  })();
  opts?.log?.('heuristics scored ' + sessions.length + ' sessions and wrote ' + added + ' findings');
  return { sessionsScored: sessions.length, findingsAdded: added };
}

export function recordBaselineIfReady(db: DB): boolean {
  if (metaGet(db, 'baseline') !== null) return false;
  const range = db.prepare('SELECT MIN(started_at) AS first, MAX(started_at) AS last FROM sessions').get() as {
    first: number | null; last: number | null;
  };
  if (range.first === null || range.last === null || range.last - range.first < 6 * DAY) return false;
  const end = range.first + 7 * DAY;
  const row = db.prepare(
    "SELECT COUNT(DISTINCT s.id) AS sessions, SUM(CASE WHEN t.role='user' THEN 1 ELSE 0 END) AS userTurns, SUM(CASE WHEN t.role='user' AND t.is_correction=1 THEN 1 ELSE 0 END) AS correctionTurns, SUM(COALESCE(t.input_tokens,0)+COALESCE(t.output_tokens,0)+COALESCE(t.cache_write_tokens,0)+?*COALESCE(t.cache_read_tokens,0)) AS eff, SUM(COALESCE(t.input_tokens,0)+COALESCE(t.output_tokens,0)+COALESCE(t.cache_read_tokens,0)+COALESCE(t.cache_write_tokens,0)) AS tokens FROM sessions s LEFT JOIN turns t ON t.session_id=s.id WHERE s.started_at>=? AND s.started_at<?"
  ).get(CACHED_READ_WEIGHT, range.first, end) as {
    sessions: number; userTurns: number | null; correctionTurns: number | null; eff: number | null; tokens: number | null;
  };
  if (!row.sessions) return false;
  const userTurns = row.userTurns ?? 0, correctionTurns = row.correctionTurns ?? 0;
  metaSetJson(db, 'baseline', {
    recordedAt: Date.now(), windowStartMs: range.first, windowEndMs: end, sessions: row.sessions,
    userTurns, correctionTurns, correctionRate: userTurns ? correctionTurns / userTurns : 0,
    tokensPerSession: (row.tokens ?? 0) / row.sessions,
    effTokensPerSession: (row.eff ?? 0) / row.sessions,
  });
  return true;
}
