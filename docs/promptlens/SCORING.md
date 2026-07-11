# Scoring Spec (0–100)

Requirement: *has score to indicate the current prompt is good or bad based on 0–100.*

---

## InputScore (primary UX number)

Aggregate **0–100** from weighted dimensions:

| Dimension | Weight | High score means |
|-----------|--------|------------------|
| Clarity | 25% | One clear goal |
| Specificity | 25% | Constraints, audience, success criteria |
| Structure | 20% | Readable sections / ordered instructions |
| Concision | 15% | Little filler / duplication |
| ContextFit | 15% | Only necessary context |

```
InputScore = clamp(0, 100,
  Σ dimension_score_i * weight_i
)
```

Each dimension starts at full points; detectors subtract penalties.

### Bands (UI)

| Score | Label | Color hint |
|-------|-------|------------|
| 0–39 | Weak | Red |
| 40–69 | OK | Amber |
| 70–100 | Strong | Green |

---

## OutputScore (after the call)

| Dimension | Weight |
|-----------|--------|
| TaskFit | 30% |
| Specificity | 20% |
| Waste (low preamble/repetition) | 20% |
| FormatCompliance | 20% |
| Calibration | 10% |

Use **cheap** LLM judge when enabled; else heuristic Waste + Format only and mark TaskFit `n/a`.

---

## Efficiency (secondary)

```
EfficiencyScore ≈ 100 * (tokens_after_strip_or_signal / tokens_before)
```

Also show `tokens_in`, `tokens_out`, `est_cost_usd`.

---

## Inefficiency detectors (history + live)

| ID | Inefficiency | Suggestion direction |
|----|--------------|----------------------|
| P01 | Vague filler | Concrete verb + measurable constraint |
| P02 | Politeness tax | Remove please/thanks padding |
| P03 | Redundant constraints | Keep one specific phrasing |
| P04 | Missing output format | Add schema / bullets / length |
| P05 | Mega-prompt / buried ask | Split tasks; lead with the ask |
| P06 | Context dump | Keep only relevant excerpts |
| P07 | Hedge pile | One uncertainty rule |
| P08 | Role without task | Role + clear task |
| P09 | Re-pasting same background | Use system/memory |
| P10 | “Explain in detail” bait | Set length/section budget |

Findings feed both the **0–100 score** and the **style report**.

---

## Improve (cheap LLM) contract

Return JSON:

```json
{
  "improved": "...",
  "changes": ["..."],
  "risk_flags": []
}
```

Rules: preserve intent; remove waste; add minimal format if missing; do not invent new requirements.

---

## Style report aggregates

- `avg_input_score`  
- `top_patterns[]`  
- `est_tokens_wasted`  
- `coaching_headline`  
