# Assumptions

Every environmental figure tokenlean prints is derived from the constants in [`src/constants.ts`](src/constants.ts). This file documents each constant, where it comes from, and why the output is always a labeled range rather than a number.

## Constants

| Constant | Value | Unit | Source | Why this value |
|---|---|---|---|---|
| `ENERGY_KWH_PER_MTOK` | 0.3 – 1.0 | kWh per 1M uncached tokens | [Epoch AI (2025)](https://epoch.ai/gradient-updates/how-much-energy-does-chatgpt-use); [Luccioni et al. (2023)](https://arxiv.org/abs/2311.16863) | Literature range for frontier-model inference. The low end reflects efficient batched serving on modern accelerators; the high end is a conservative bound covering older hardware, low utilization, and long-context prefill. No first-party figures exist for Claude, so we borrow the published range for comparable models. |
| `WATER_L_PER_KWH_ONSITE` | 1.1 | L per kWh (on-site cooling) | [Li et al., "Making AI Less Thirsty" (2023)](https://arxiv.org/abs/2304.03271) | Typical on-site water usage effectiveness (WUE) for evaporative-cooled datacenters. A point value because the paper reports a representative figure; actual WUE varies by site and season. |
| `WATER_L_PER_KWH_LIFECYCLE` | 1.8 – 12.0 | L per kWh (lifecycle) | [Li et al. (2023)](https://arxiv.org/abs/2304.03271) | On-site cooling plus the water embedded in electricity generation. The range is wide because it is dominated by the grid mix behind the datacenter — hydro-heavy grids sit near the top, wind/solar-heavy grids near the bottom. |
| `CACHED_READ_WEIGHT` | 0.1 | dimensionless (fraction of uncached cost) | assumption — see below | Cached-prefix reads skip prefill compute; serving them is not free, but far cheaper than recomputation. |
| `ESTIMATE_LABEL` | — | — | — | The string appended to every environmental figure: "rough estimate — no first-party figures exist for Claude; see ASSUMPTIONS.md". Printing it is mandatory, not optional. |

## The cached-read weighting (10%)

Agentic Claude Code sessions are dominated by cache reads — the system prompt, tool definitions, and conversation prefix are re-read on every turn, and cache-read tokens routinely make up the large majority of input tokens. How they are weighted therefore moves the estimate more than any other single choice.

We count a cache-read token at **10% of an uncached token**. Rationale: a cached prefix skips prefill compute entirely; what remains is storage, retrieval, and attention over the cached KV entries. There is no published measurement of this ratio, so we adopt 10% as an order-of-magnitude proxy — it is consistent with cache reads being priced at roughly a tenth of base input tokens, which at least bounds what the provider believes the marginal cost to be. It is an assumption, not a measurement, and reports flag it as such.

**Sensitivity:** because cache reads dominate token counts, the estimate scales almost linearly with this weight in cache-heavy usage. If the true ratio were 5%, our figures overstate cached-token impact by about 2x; if it were 20%, they understate it by the same factor. Read the totals as order-of-magnitude, and comparisons over time (same assumption on both sides) as more trustworthy than absolute values.

## Why ranges, and why the "rough estimate" label is mandatory

There are no first-party energy or water figures for Claude inference. Everything else that determines the real number is also unknown to us: model size and architecture, hardware generation, batch sizes and utilization, context-length distribution, datacenter PUE and WUE, the grid mix at the sites serving a given request, and how these change over time. Each of these plausibly moves the result by a factor of 2 or more.

A single number would therefore convey false precision, which is worse than no number: it invites downstream citation as fact. So tokenlean always prints a LOW–HIGH range derived from sourced bounds, always attaches the "rough estimate" label, and never emits an unqualified figure — this is a hard output rule, not a formatting preference. The direction, however, is not uncertain: fewer wasted tokens is strictly less compute, less energy, and less water. The ranges exist to keep the magnitude honest while the direction does the motivating.
