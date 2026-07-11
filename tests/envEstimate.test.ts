import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { metaSetJson, openDb, type DB } from '../src/db';
import {
  equivalentsFor,
  estimateEnvironment,
  estimateWasteLedger,
  formatRange,
  formatEnvNumber,
} from '../src/report/envEstimate';
import { ESTIMATE_LABEL } from '../src/constants';

const NOW = Date.now();
const DAY = 86_400_000;

let tmpDir: string;
let db: DB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcoach-env-'));
  db = openDb(path.join(tmpDir, 'db.sqlite'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedSession(id: string, startedAt: number): void {
  db.prepare(
    `INSERT INTO sessions (id, project, started_at, ended_at, model, turn_count, abandoned, waste_score)
     VALUES (?, '/tmp/proj', ?, ?, 'claude-sonnet-4-6', 0, 0, 0)`
  ).run(id, startedAt, startedAt + 1_000);
}

function seedTurn(
  sessionId: string,
  idx: number,
  o: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
): void {
  db.prepare(
    `INSERT INTO turns (session_id, idx, role, ts, char_len, is_correction,
                        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                        text_head, has_fence)
     VALUES (?, ?, 'assistant', ?, 0, 0, ?, ?, ?, ?, NULL, 0)`
  ).run(sessionId, idx, NOW, o.input ?? null, o.output ?? null, o.cacheRead ?? null, o.cacheWrite ?? null);
}

function seedBaseline(effTokensPerSession: number): void {
  metaSetJson(db, 'baseline', {
    recordedAt: NOW - 10 * DAY,
    windowStartMs: NOW - 17 * DAY,
    windowEndMs: NOW - 10 * DAY,
    sessions: 4,
    userTurns: 40,
    correctionTurns: 4,
    correctionRate: 0.1,
    tokensPerSession: effTokensPerSession,
    effTokensPerSession,
  });
}

describe('estimateEnvironment without a baseline', () => {
  it('reports the window footprint but null savings, with the friendly note', () => {
    seedSession('s1', NOW - DAY);
    // eff = 600k + 300k + 100k = exactly 1,000,000 (no cache-read float noise)
    seedTurn('s1', 0, { input: 600_000, output: 300_000, cacheWrite: 100_000 });

    const env = estimateEnvironment(db);
    expect(env.label).toBe(ESTIMATE_LABEL);
    expect(env.effectiveTokensSaved).toBeNull();
    expect(env.energyKwh).toBeNull();
    expect(env.waterOnsiteL).toBeNull();
    expect(env.waterLifecycleL).toBeNull();
    // 1 MTok x [0.3, 2.0] kWh/MTok
    expect(env.windowFootprintKwh.low).toBe(0.3);
    expect(env.windowFootprintKwh.high).toBe(2.0);
    expect(env.notes).toContain(ESTIMATE_LABEL);
    expect(env.notes).toContain('baseline not recorded yet — savings appear after week 1');
    expect(env.notes.some((n) => n.includes('10%'))).toBe(true);
  });

  it('weights cache reads at 10 percent in the footprint', () => {
    seedSession('s1', NOW - DAY);
    seedTurn('s1', 0, { cacheRead: 1_000_000 }); // eff ~= 100k
    const env = estimateEnvironment(db);
    expect(env.windowFootprintKwh.low).toBeCloseTo(0.1 * 0.3, 10); // 0.03
    expect(env.windowFootprintKwh.high).toBeCloseTo(0.1 * 2.0, 10); // 0.2
  });
});

describe('estimateEnvironment with a baseline', () => {
  it('computes hand-checked saved-energy and water ranges', () => {
    // Baseline: 1 MTok effective per session.
    seedBaseline(1_000_000);
    // Window: 2 sessions at exactly 500k effective tokens each.
    seedSession('a', NOW - 1 * DAY);
    seedTurn('a', 0, { input: 300_000, output: 100_000, cacheWrite: 100_000 });
    seedSession('b', NOW - 2 * DAY);
    seedTurn('b', 0, { input: 200_000, output: 200_000, cacheWrite: 100_000 });

    const env = estimateEnvironment(db);
    // savedEff = max(0, 1,000,000 - 500,000) x 2 sessions = 1,000,000
    expect(env.effectiveTokensSaved).toBe(1_000_000);
    // energy: 1 MTok x [0.3, 2.0]
    expect(env.energyKwh!.low).toBe(0.3);
    expect(env.energyKwh!.high).toBe(2.0);
    // on-site water: energy x [0.4, 4.3]
    expect(env.waterOnsiteL!.low).toBeCloseTo(0.12, 10);
    expect(env.waterOnsiteL!.high).toBeCloseTo(8.6, 10);
    // lifecycle water: low x 1.8, high x 12
    expect(env.waterLifecycleL!.low).toBeCloseTo(0.54, 10);
    expect(env.waterLifecycleL!.high).toBeCloseTo(24.0, 10);
    // footprint of the window itself: 1 MTok total
    expect(env.windowFootprintKwh.low).toBe(0.3);
    expect(env.windowFootprintKwh.high).toBe(2.0);
  });

  it('clamps savings at zero when current usage exceeds the baseline', () => {
    seedBaseline(100);
    seedSession('a', NOW - DAY);
    seedTurn('a', 0, { input: 900_000, output: 100_000 });

    const env = estimateEnvironment(db);
    expect(env.effectiveTokensSaved).toBe(0);
    expect(env.energyKwh).toEqual({ low: 0, high: 0 });
    expect(env.waterOnsiteL).toEqual({ low: 0, high: 0 });
    // footprint is still reported for the window usage
    expect(env.windowFootprintKwh.high).toBe(2.0);
  });

  it('applies the sinceDays window to both footprint and savings', () => {
    seedBaseline(1_000_000);
    seedSession('recent', NOW - 1 * DAY);
    seedTurn('recent', 0, { input: 400_000, output: 100_000 }); // eff 500k
    seedSession('ancient', NOW - 30 * DAY);
    seedTurn('ancient', 0, { input: 9_000_000, output: 1_000_000 }); // excluded

    const env = estimateEnvironment(db, { sinceDays: 7 });
    // window: 1 session, eff 500k -> footprint 0.5 MTok x [0.3, 2.0]
    expect(env.windowFootprintKwh.low).toBeCloseTo(0.15, 10);
    expect(env.windowFootprintKwh.high).toBeCloseTo(1.0, 10);
    // savedEff = (1,000,000 - 500,000) x 1
    expect(env.effectiveTokensSaved).toBe(500_000);
    expect(env.energyKwh!.low).toBeCloseTo(0.15, 10);
    expect(env.energyKwh!.high).toBeCloseTo(1.0, 10);
  });

  it('returns zero savings (not null) for an empty window', () => {
    seedBaseline(1_000_000);
    // no sessions at all
    const env = estimateEnvironment(db);
    expect(env.effectiveTokensSaved).toBe(0);
    expect(env.energyKwh).toEqual({ low: 0, high: 0 });
    expect(env.windowFootprintKwh).toEqual({ low: 0, high: 0 });
  });
});

describe('equivalentsFor', () => {
  it('converts an energy range into sourced tangible equivalences', () => {
    // 0.019 kWh = exactly one EPA smartphone charge; 0.038 = two.
    const eq = equivalentsFor({ low: 0.019, high: 0.038 });
    expect(eq.smartphoneCharges.low).toBeCloseTo(1, 10);
    expect(eq.smartphoneCharges.high).toBeCloseTo(2, 10);
    // 10 W LED bulb: 0.01 kWh/hour.
    expect(eq.ledBulbHours.low).toBeCloseTo(1.9, 10);
    expect(eq.ledBulbHours.high).toBeCloseTo(3.8, 10);
    // EV at 0.22 kWh/km.
    expect(eq.evKm.low).toBeCloseTo(0.019 / 0.22, 10);
    expect(eq.evKm.high).toBeCloseTo(0.038 / 0.22, 10);
  });

  it('maps a zero range to zero equivalences', () => {
    const eq = equivalentsFor({ low: 0, high: 0 });
    expect(eq.smartphoneCharges).toEqual({ low: 0, high: 0 });
    expect(eq.evKm).toEqual({ low: 0, high: 0 });
  });
});

describe('estimateWasteLedger', () => {
  function seedSessionTC(id: string, startedAt: number, turnCount: number): void {
    db.prepare(
      `INSERT INTO sessions (id, project, started_at, ended_at, model, turn_count, abandoned, waste_score)
       VALUES (?, '/tmp/proj', ?, ?, 'claude-sonnet-4-6', ?, 0, 0)`
    ).run(id, startedAt, startedAt + 1_000, turnCount);
  }
  function seedFinding(sessionId: string, category: string): void {
    db.prepare(
      `INSERT INTO findings (session_id, category, confidence, evidence, suggestion, created_at, source)
       VALUES (?, ?, 0.5, 'e', 's', ?, 'heuristic')`
    ).run(sessionId, category, NOW);
  }

  it('applies the recurring persistence multiplier (1 + 0.1 x min(turns-1, 30))', () => {
    // turnCount 11 -> persisted min(10, 30) -> multiplier 2.0
    seedSessionTC('s', NOW - DAY, 11);
    seedFinding('s', 'repeated_file_read'); // base {1000, 4000} x 1 x 2.0
    const ledger = estimateWasteLedger(db, null);
    expect(ledger.totalEffTokens).toEqual({ low: 2_000, high: 8_000 });
    expect(ledger.energyKwh.low).toBeCloseTo((2_000 / 1e6) * 0.3, 12);
    expect(ledger.energyKwh.high).toBeCloseTo((8_000 / 1e6) * 2.0, 12);
  });

  it('scales cost with session length and caps persistence at 30 turns', () => {
    seedSessionTC('short', NOW - DAY, 1); // multiplier 1.0
    seedFinding('short', 'oversized_paste'); // {2000, 6000}
    seedSessionTC('long', NOW - 2 * DAY, 500); // capped -> multiplier 1 + 0.1*30 = 4.0
    seedFinding('long', 'oversized_paste'); // {8000, 24000}
    const ledger = estimateWasteLedger(db, null);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].category).toBe('oversized_paste');
    expect(ledger.rows[0].count).toBe(2);
    expect(ledger.rows[0].effTokens).toEqual({ low: 10_000, high: 30_000 });
  });

  it('uses the default bound for unknown categories and sorts by worst case', () => {
    seedSessionTC('s', NOW - DAY, 1); // multiplier 1.0
    seedFinding('s', 'mystery_pattern'); // default {500, 2000}
    seedFinding('s', 'oversized_paste'); // {2000, 6000}
    const ledger = estimateWasteLedger(db, null);
    expect(ledger.rows[0].category).toBe('oversized_paste'); // highest high first
    const mystery = ledger.rows.find((r) => r.category === 'mystery_pattern')!;
    expect(mystery.effTokens).toEqual({ low: 500, high: 2_000 });
    expect(ledger.totalEffTokens).toEqual({ low: 2_500, high: 8_000 });
  });

  it('honors the sinceDays cutoff via session start time', () => {
    seedSessionTC('recent', NOW - DAY, 1);
    seedFinding('recent', 'oversized_paste');
    seedSessionTC('ancient', NOW - 30 * DAY, 1);
    seedFinding('ancient', 'oversized_paste');
    const ledger = estimateWasteLedger(db, NOW - 7 * DAY);
    expect(ledger.rows[0].count).toBe(1); // only the recent session
    expect(ledger.totalEffTokens).toEqual({ low: 2_000, high: 6_000 });
  });

  it('returns an empty, zeroed ledger when there are no findings', () => {
    const ledger = estimateWasteLedger(db, null);
    expect(ledger.rows).toEqual([]);
    expect(ledger.totalEffTokens).toEqual({ low: 0, high: 0 });
    expect(ledger.energyKwh).toEqual({ low: 0, high: 0 });
  });
});

describe('range formatting', () => {
  it('always renders a low-high range, never a bare number', () => {
    expect(formatRange({ low: 0.4, high: 1.3 }, 'kWh')).toBe('0.4–1.3 kWh');
    expect(formatRange({ low: 0, high: 0 }, 'kWh')).toBe('0–0 kWh');
    expect(formatRange({ low: 0.033, high: 0.11 }, 'L')).toBe('0.033–0.1 L');
    expect(formatRange({ low: 120.4, high: 512.9 }, 'L')).toBe('120–513 L');
  });

  it('formats magnitudes sensibly', () => {
    expect(formatEnvNumber(0)).toBe('0');
    expect(formatEnvNumber(1)).toBe('1.0');
    expect(formatEnvNumber(12.34)).toBe('12.3');
    expect(formatEnvNumber(0.0042)).toBe('0.0042');
  });
});
