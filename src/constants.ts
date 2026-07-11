/**
 * Environmental-impact constants.
 *
 * The base energy/water conversion constants live in src/shared/core.ts —
 * the single source of truth shared with the browser extension (via the
 * generated extension/lib/promptcoach-core.js) — and are re-exported here so
 * existing CLI imports keep working. Constants below the re-exports are
 * CLI-report-specific (equivalences and the avoidable-waste ledger).
 *
 * Every constant carries a source URL and a LOW/HIGH bound. There are no
 * first-party energy figures for Claude; these are literature ranges for
 * large-model inference. Reports must always print ranges, never a single
 * unqualified number, and must label the output "rough estimate".
 * See docs/cli/ASSUMPTIONS.md for the full discussion.
 */

export type { BoundedConstant } from './shared/core';
export {
  ENERGY_KWH_PER_MTOK,
  WATER_L_PER_KWH_ONSITE,
  WATER_L_PER_KWH_LIFECYCLE,
  CACHED_READ_WEIGHT,
  ESTIMATE_LABEL,
} from './shared/core';
import type { BoundedConstant } from './shared/core';

/**
 * Tangible equivalences for a kWh figure. Their purpose is to make abstract,
 * weightless compute consumption feel concrete — the antidote to invisible
 * overconsumption. Each is a single sourced conversion factor; applied to an
 * energy LOW/HIGH range it still yields a range, so the "always a range"
 * invariant (SPEC §7) is preserved.
 */

/** Energy the US EPA attributes to one full smartphone charge. */
export const KWH_PER_SMARTPHONE_CHARGE: BoundedConstant = {
  low: 0.019,
  high: 0.019,
  unit: 'kWh per full smartphone charge',
  source: 'https://www.epa.gov/energy/greenhouse-gas-equivalencies-calculator-calculations-and-references',
  note: 'US EPA Greenhouse Gas Equivalencies Calculator (0.019 kWh/charge, iPhone-16 basis).',
};

/** A single 10 W LED bulb running for one hour (P x t = 10 W x 1 h). */
export const KWH_PER_LED_BULB_HOUR: BoundedConstant = {
  low: 0.01,
  high: 0.01,
  unit: 'kWh per LED-bulb-hour',
  source: 'https://www.energy.gov/energysaver/led-lighting',
  note: 'A typical ~10 W LED bulb draws 0.01 kWh in one hour (basic power x time).',
};

/** Battery-EV energy per kilometre (US average ~0.35 kWh/mi ≈ 0.22 kWh/km). */
export const KWH_PER_EV_KM: BoundedConstant = {
  low: 0.22,
  high: 0.22,
  unit: 'kWh per EV kilometre',
  source: 'https://www.epa.gov/greenvehicles/fuel-economy-and-ev-range-testing',
  note: 'US average battery-EV consumption ≈ 0.35 kWh/mile ≈ 0.22 kWh/km.',
};

/**
 * Rough effective-token cost of ONE occurrence of each waste pattern, used
 * ONLY by the "avoidable waste" ledger to turn findings into a tangible
 * consumption figure. These are illustrative order-of-magnitude bounds, NOT
 * measurements — the ledger always prints the estimate label. Rationale:
 *  - repeated_file_read: a redundant read re-injects a file into context
 *  - oversized_paste:    a pasted block duplicates code Claude could have read
 *  - resupplied_context: the same preamble is re-sent every session
 *  - correction_turn:    a correction burns a wasted request/response round-trip
 *  - abandonment:        an abandoned session is mostly wasted setup
 */
export const AVOIDABLE_EFF_TOKENS_PER_FINDING: Record<string, { low: number; high: number }> = {
  repeated_file_read: { low: 1_000, high: 4_000 },
  oversized_paste: { low: 2_000, high: 6_000 },
  resupplied_context: { low: 1_000, high: 4_000 },
  correction_turn: { low: 800, high: 3_000 },
  abandonment: { low: 500, high: 2_000 },
};

/** Fallback bound for any finding category not listed above. */
export const AVOIDABLE_EFF_TOKENS_DEFAULT: { low: number; high: number } = {
  low: 500,
  high: 2_000,
};

/**
 * Recurring-cost model: a wasteful artifact (a re-read file, a pasted block)
 * does not cost its tokens once — it lingers in the session's context and is
 * re-sent on every later turn, charged at CACHED_READ_WEIGHT after the first.
 * So its effective cost is base x (1 + CACHED_READ_WEIGHT x persistedTurns).
 *
 * persistedTurns is capped here because Claude Code compaction eventually
 * clears old context; ~30 turns reflects common "/compact every ~30 turns"
 * guidance. Conservative on purpose (a lower cap yields a smaller number).
 * Assumption, not a measurement — the ledger says so.
 */
export const WASTE_PERSIST_TURNS_CAP = 30;
