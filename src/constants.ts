/**
 * Environmental-impact constants.
 *
 * Every constant carries a source URL and a LOW/HIGH bound. There are no
 * first-party energy figures for Claude; these are literature ranges for
 * large-model inference. Reports must always print ranges, never a single
 * unqualified number, and must label the output "rough estimate".
 * See ASSUMPTIONS.md for the full discussion.
 */

export interface BoundedConstant {
  low: number;
  high: number;
  unit: string;
  source: string;
  note: string;
}

/** Energy per million uncached tokens processed (input + output). */
export const ENERGY_KWH_PER_MTOK: BoundedConstant = {
  low: 0.3,
  high: 1.0,
  unit: 'kWh per 1M uncached tokens',
  source: 'https://epoch.ai/gradient-updates/how-much-energy-does-chatgpt-use',
  note:
    'Literature range for frontier-model inference (Epoch AI 2025; Luccioni et al. 2023, ' +
    'https://arxiv.org/abs/2311.16863). No first-party figures exist for Claude.',
};

/** On-site (scope-1) water use per kWh of datacenter energy. */
export const WATER_L_PER_KWH_ONSITE: BoundedConstant = {
  low: 1.1,
  high: 1.1,
  unit: 'L per kWh (on-site cooling)',
  source: 'https://arxiv.org/abs/2304.03271',
  note: 'Li et al., "Making AI Less Thirsty" — typical on-site WUE.',
};

/** Lifecycle water (on-site + electricity generation) per kWh. */
export const WATER_L_PER_KWH_LIFECYCLE: BoundedConstant = {
  low: 1.8,
  high: 12.0,
  unit: 'L per kWh (lifecycle)',
  source: 'https://arxiv.org/abs/2304.03271',
  note: 'Wide range dominated by the grid mix behind the datacenter.',
};

/**
 * Weight applied to cache-read tokens relative to uncached tokens.
 * Assumption, not a measurement: cached prefixes skip prefill compute,
 * so we count them at 10%. Flagged in every report.
 */
export const CACHED_READ_WEIGHT = 0.1;

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

export const ESTIMATE_LABEL =
  'rough estimate — no first-party figures exist for Claude; see ASSUMPTIONS.md';
