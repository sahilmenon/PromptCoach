import * as fs from 'fs';
import * as path from 'path';
import type { DB } from '../db';
import { metaGet, metaSet } from '../db';
import { resolveProjectsDir } from '../config';
import type { IngestResult } from '../types';

/**
 * Incrementally ingest Claude Code JSONL transcripts under
 * <claudeDir>/projects into the sessions/turns/tool_calls tables.
 *
 * Contract (SPEC §4.1):
 *  - Treat the format as unstable: skip unknown record types, count
 *    malformed lines, never throw on bad input.
 *  - Track mtime + byte offset per file (meta table) so repeat runs only
 *    read new content.
 *
 * Decisions not obvious from the spec:
 *  - Sidechain (subagent) user records carry no usage block in this format,
 *    so they are skipped entirely: they are not prompts the human typed and
 *    contribute no token counts. Sidechain assistant records ARE ingested —
 *    their usage is real spend.
 *  - An assistant message split across ingest runs (file grew mid-message)
 *    is stitched back together: the per-file state remembers the last
 *    assistant message.id, and continuation lines update the existing turn
 *    (char_len, tool_calls) without re-counting usage.
 */

/** Per-file incremental state stored under meta key `ingest:<abs path>`. */
interface FileState {
  mtime: number;
  size: number;
  /** Byte offset just past the last complete line consumed. */
  offset: number;
  /** message.id of the last assistant turn written, for cross-run stitching. */
  lastMsgId?: string | null;
}

interface ToolUse {
  tool: string;
  target: string | null;
}

interface Usage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

/** Accumulator for one assistant message (possibly many JSONL lines). */
interface PendingAssistant {
  msgId: string;
  ts: number | null;
  charLen: number;
  usage: Usage | null;
  toolUses: ToolUse[];
  /** True when this message continues a turn already written in a prior run. */
  continuation: boolean;
}

const CHUNK_SIZE = 1 << 20; // 1 MiB reads: files can be tens of MB
const TEXT_HEAD_LIMIT = 8192;

function metaKeyFor(filePath: string): string {
  return `ingest:${filePath}`;
}

function asFiniteInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
}

function parseTs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function parseUsage(raw: unknown): Usage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  return {
    input: asFiniteInt(u.input_tokens),
    output: asFiniteInt(u.output_tokens),
    cacheRead: asFiniteInt(u.cache_read_input_tokens),
    cacheWrite: asFiniteInt(u.cache_creation_input_tokens),
  };
}

/**
 * Read complete lines from `startOffset` to EOF without loading the whole
 * file. Returns the byte offset just past the last complete newline; a
 * trailing partial line is left for the next run.
 */
function readCompleteLines(filePath: string, startOffset: number): { lines: string[]; endOffset: number } {
  const lines: string[] = [];
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(CHUNK_SIZE);
    let pos = startOffset;
    let carry = Buffer.alloc(0);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK_SIZE, pos);
      if (n <= 0) break;
      pos += n;
      // carry holds the unterminated tail from previous chunks (may span
      // multi-byte UTF-8 sequences, hence byte-level splitting).
      let chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      let lineStart = 0;
      let nl: number;
      while ((nl = chunk.indexOf(0x0a, lineStart)) !== -1) {
        let end = nl;
        if (end > lineStart && chunk[end - 1] === 0x0d) end -= 1; // strip \r
        lines.push(chunk.subarray(lineStart, end).toString('utf8'));
        lineStart = nl + 1;
      }
      carry = Buffer.from(chunk.subarray(lineStart));
    }
    // pos = startOffset + total bytes read; carry = bytes read but not consumed.
    return { lines, endOffset: pos - carry.length };
  } finally {
    fs.closeSync(fd);
  }
}

/** Extract prompt text from a user record; null when it is not a real prompt. */
function userPromptText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
      const t = (block as Record<string, unknown>).text;
      if (typeof t === 'string') texts.push(t);
    }
  }
  // Records whose content is only tool_result blocks are tool results, not prompts.
  if (texts.length === 0) return null;
  return texts.join('\n\n');
}

function extractToolUses(content: unknown): { textLen: number; toolUses: ToolUse[] } {
  let textLen = 0;
  const toolUses: ToolUse[] = [];
  if (!Array.isArray(content)) return { textLen, toolUses };
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      textLen += b.text.length;
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>;
      const target = [input.file_path, input.path, input.pattern, input.url].find(
        (v) => typeof v === 'string'
      ) as string | undefined;
      toolUses.push({ tool: b.name, target: target ?? null });
    }
  }
  return { textLen, toolUses };
}

interface Counters {
  turnsAdded: number;
  toolCallsAdded: number;
  malformedLines: number;
  unknownRecordTypes: number;
}

export function ingestTranscripts(
  db: DB,
  claudeDir: string,
  opts?: { log?: (msg: string) => void }
): IngestResult {
  const log = opts?.log ?? (() => {});
  const result: IngestResult = {
    filesScanned: 0,
    filesParsed: 0,
    filesSkippedUnchanged: 0,
    sessionsUpserted: 0,
    turnsAdded: 0,
    toolCallsAdded: 0,
    malformedLines: 0,
    unknownRecordTypes: 0,
  };

  const projectsDir = resolveProjectsDir(claudeDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    log(`projects dir not readable: ${projectsDir}`);
    return result;
  }

  // One level of project dirs, plus .jsonl files directly in projectsDir.
  const files: { path: string; projectDirName: string }[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(projectsDir, e.name);
    if (e.isDirectory()) {
      let inner: string[];
      try {
        inner = fs.readdirSync(full);
      } catch {
        continue;
      }
      for (const f of inner.sort()) {
        if (f.endsWith('.jsonl')) files.push({ path: path.join(full, f), projectDirName: e.name });
      }
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      files.push({ path: full, projectDirName: path.basename(projectsDir) });
    }
  }

  const stmts = {
    ensureSession: db.prepare(
      'INSERT OR IGNORE INTO sessions (id, project, turn_count) VALUES (?, ?, 0)'
    ),
    maxIdx: db.prepare('SELECT MAX(idx) AS m FROM turns WHERE session_id = ?'),
    insTurn: db.prepare(
      `INSERT OR IGNORE INTO turns
         (session_id, idx, role, ts, char_len, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, text_head, has_fence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    insTool: db.prepare('INSERT INTO tool_calls (turn_id, tool, target) VALUES (?, ?, ?)'),
    lastAssistantTurn: db.prepare(
      "SELECT id FROM turns WHERE session_id = ? AND role = 'assistant' ORDER BY idx DESC LIMIT 1"
    ),
    growTurn: db.prepare('UPDATE turns SET char_len = char_len + ? WHERE id = ?'),
    getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    upsertSession: db.prepare(
      `INSERT INTO sessions (id, project, started_at, ended_at, model, turn_count)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET project = excluded.project,
         started_at = excluded.started_at, ended_at = excluded.ended_at,
         model = excluded.model, turn_count = excluded.turn_count`
    ),
    turnCount: db.prepare('SELECT COUNT(*) AS c FROM turns WHERE session_id = ?'),
    delTools: db.prepare(
      'DELETE FROM tool_calls WHERE turn_id IN (SELECT id FROM turns WHERE session_id = ?)'
    ),
    delTurns: db.prepare('DELETE FROM turns WHERE session_id = ?'),
    delSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
  };

  const ingestFile = db.transaction((file: { path: string; projectDirName: string }): void => {
    const sessionId = path.basename(file.path, '.jsonl');
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file.path);
    } catch {
      return; // vanished between scan and read
    }
    stmts.ensureSession.run(sessionId, file.projectDirName);

    let state: FileState | null = null;
    const rawState = metaGet(db, metaKeyFor(file.path));
    if (rawState) {
      try {
        const parsed = JSON.parse(rawState) as FileState;
        if (typeof parsed.offset === 'number') state = parsed;
      } catch {
        /* corrupt state: reparse from scratch */
      }
    }

    if (state && state.mtime === stat.mtimeMs && state.size === stat.size) {
      result.filesSkippedUnchanged++;
      return;
    }

    let startOffset = state ? state.offset : 0;
    let lastMsgId = state?.lastMsgId ?? null;
    if (state && stat.size < state.offset) {
      // Shrunk/replaced: drop this session's rows and reparse from zero.
      log(`file shrunk, reparsing: ${file.path}`);
      stmts.delTools.run(sessionId);
      stmts.delTurns.run(sessionId);
      stmts.delSession.run(sessionId);
      startOffset = 0;
      lastMsgId = null;
    }

    const { lines, endOffset } = readCompleteLines(file.path, startOffset);
    result.filesParsed++;

    const counters: Counters = {
      turnsAdded: 0,
      toolCallsAdded: 0,
      malformedLines: 0,
      unknownRecordTypes: 0,
    };
    let nextIdx = ((stmts.maxIdx.get(sessionId) as { m: number | null }).m ?? -1) + 1;
    let minTs: number | null = null;
    let maxTs: number | null = null;
    let cwd: string | null = null;
    let model: string | null = null;
    let pending: PendingAssistant | null = null;
    // Whether the very next assistant record may continue the turn written at
    // the end of the previous run (append after a mid-message cut).
    let mayContinue = startOffset > 0 && lastMsgId !== null;

    const flushPending = (): void => {
      if (!pending) return;
      if (pending.continuation) {
        const row = stmts.lastAssistantTurn.get(sessionId) as { id: number } | undefined;
        if (row) {
          if (pending.charLen > 0) stmts.growTurn.run(pending.charLen, row.id);
          for (const t of pending.toolUses) {
            stmts.insTool.run(row.id, t.tool, t.target);
            counters.toolCallsAdded++;
          }
        }
      } else {
        const u = pending.usage;
        const info = stmts.insTurn.run(
          sessionId,
          nextIdx,
          'assistant',
          pending.ts,
          pending.charLen,
          u ? u.input : null,
          u ? u.output : null,
          u ? u.cacheRead : null,
          u ? u.cacheWrite : null,
          null,
          0
        );
        if (info.changes > 0) {
          nextIdx++;
          counters.turnsAdded++;
          for (const t of pending.toolUses) {
            stmts.insTool.run(info.lastInsertRowid as number, t.tool, t.target);
            counters.toolCallsAdded++;
          }
        }
      }
      lastMsgId = pending.msgId;
      pending = null;
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let rec: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        rec = parsed as Record<string, unknown>;
      } catch {
        counters.malformedLines++;
        continue;
      }

      const ts = parseTs(rec.timestamp);
      if (ts !== null) {
        if (minTs === null || ts < minTs) minTs = ts;
        if (maxTs === null || ts > maxTs) maxTs = ts;
      }
      if (cwd === null && typeof rec.cwd === 'string' && rec.cwd !== '') cwd = rec.cwd;

      const type = rec.type;
      if (type === 'assistant') {
        const msg = rec.message;
        if (!msg || typeof msg !== 'object') {
          counters.malformedLines++;
          continue;
        }
        const m = msg as Record<string, unknown>;
        const msgId =
          (typeof m.id === 'string' && m.id) ||
          (typeof rec.uuid === 'string' && rec.uuid) ||
          `anon-${nextIdx}-${counters.turnsAdded}`;
        if (typeof m.model === 'string') model = m.model;
        const { textLen, toolUses } = extractToolUses(m.content);
        const usage = parseUsage(m.usage);

        if (pending && pending.msgId === msgId) {
          // Another line of the same assistant message: usage counted once.
          pending.charLen += textLen;
          pending.toolUses.push(...toolUses);
          if (!pending.usage) pending.usage = usage;
        } else {
          flushPending();
          const continuation: boolean = mayContinue && msgId === lastMsgId;
          pending = { msgId, ts, charLen: textLen, usage, toolUses, continuation };
        }
        mayContinue = false;
        continue;
      }

      mayContinue = false;
      flushPending();

      if (type === 'user') {
        if (rec.isMeta === true) continue;
        // Sidechain user records: subagent-side prompts, never human prompts,
        // and they carry no usage in this format — skipped (see module doc).
        if (rec.isSidechain === true) continue;
        const msg = rec.message;
        if (!msg || typeof msg !== 'object') {
          counters.malformedLines++;
          continue;
        }
        const text = userPromptText((msg as Record<string, unknown>).content);
        if (text === null) continue; // tool_result-only record
        const info = stmts.insTurn.run(
          sessionId,
          nextIdx,
          'user',
          ts,
          text.length,
          null,
          null,
          null,
          null,
          text.slice(0, TEXT_HEAD_LIMIT),
          text.includes('```') ? 1 : 0
        );
        if (info.changes > 0) {
          nextIdx++;
          counters.turnsAdded++;
        }
      } else {
        counters.unknownRecordTypes++;
        if (typeof type === 'string') log(`skipping record type "${type}" in ${file.path}`);
      }
    }
    flushPending();

    // Upsert the session row, merging with whatever a previous run stored.
    const existing = stmts.getSession.get(sessionId) as
      | { project: string | null; started_at: number | null; ended_at: number | null; model: string | null }
      | undefined;
    const mergeMin = (a: number | null, b: number | null): number | null =>
      a === null ? b : b === null ? a : Math.min(a, b);
    const mergeMax = (a: number | null, b: number | null): number | null =>
      a === null ? b : b === null ? a : Math.max(a, b);
    const turnCount = (stmts.turnCount.get(sessionId) as { c: number }).c;
    stmts.upsertSession.run(
      sessionId,
      existing?.project ?? cwd ?? file.projectDirName,
      mergeMin(existing?.started_at ?? null, minTs),
      mergeMax(existing?.ended_at ?? null, maxTs),
      model ?? existing?.model ?? null,
      turnCount
    );

    const newState: FileState = { mtime: stat.mtimeMs, size: stat.size, offset: endOffset, lastMsgId };
    metaSet(db, metaKeyFor(file.path), JSON.stringify(newState));

    result.sessionsUpserted++;
    result.turnsAdded += counters.turnsAdded;
    result.toolCallsAdded += counters.toolCallsAdded;
    result.malformedLines += counters.malformedLines;
    result.unknownRecordTypes += counters.unknownRecordTypes;
  });

  for (const file of files) {
    result.filesScanned++;
    try {
      ingestFile(file);
    } catch (err) {
      // Never let one broken file abort the run.
      log(`failed to ingest ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
