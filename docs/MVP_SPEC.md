# MVP Specification

Traceability to [`Requirement.md`](../Requirement.md) Key Features.  
**Locked decisions:** Q1=D · Q2=D · Q3=C · Stack R.  
**Scope change:** low-information **token strip middleware is out of MVP**.

---

## Scope locks

| Area | In MVP | Out / stretch |
|------|--------|----------------|
| History upload (JSON / export) | ✅ | — |
| OpenAI-compatible proxy | ✅ | — |
| React web dashboard + playground | ✅ | — |
| Cloud mini Improve/Judge | ✅ default | — |
| Ollama fallback | ✅ | — |
| Browser extension | — | stretch |
| Context token strip / LLMLingua | — | **out of MVP** |

---

## Feature requirements

### F1 — Efficient prompts before send

- Live suggestions from detectors  
- **Improve** toggle: cheap LLM rewrites prompt  
- User reviews before send (default)

**Accept:** Improved prompt gets higher InputScore (≥ +10) or clearly fewer waste tokens on demo set.

### F2 — Collect & analyze previous contexts

- Import history (generic JSON; optional ChatGPT export)  
- Per-turn analysis + aggregate **style report**

**Accept:** Fixture import → top inefficiencies listed with examples from user data.

### F3 — Score 0–100

- **InputScore** for current prompt  
- **OutputScore** after model response (MVP: cheap judge or heuristic subset)  
- Breakdown by dimension + findings

**Accept:** Score always in 0–100; deductions cite pattern + span.

### F4 — Cheap processing

- Config lists improver/judge models  
- Docs + UI state “Processing model: …”

**Accept:** No frontier model used on Improve/Judge paths in default config.

---

## User flows

### Flow A — Audit habits

Upload history → style report → read top tips → open example rewrite.

### Flow B — Fix before send

Type prompt → see score → Improve ON → edit if needed → send → see output score + cost.

### Flow C — Proxy (completeness)

Point client `base_url` at local gateway with `improve` flags.

---

## UX requirements (marking: User Experience and Design)

- Score is the hero number (large 0–100)  
- Color: low / mid / high bands  
- Improve: side-by-side original vs rewritten  
- Empty states with sample data button  
- Desktop-first OK for hackathon  

---

## Non-functional

| NFR | Target |
|-----|--------|
| Local-first | SQLite; localhost API |
| Latency | Heuristic score &lt; 100ms; Improve &lt; 2s typical on mini |
| Code quality | Clean, commented public functions |
| Privacy | Cloud mini calls disclosed |

---

## Demo acceptance checklist

- [ ] History → style report  
- [ ] Prompt → score 0–100  
- [ ] Improve → better score  
- [ ] Full send path works  
- [ ] Pitch ties features to marking criteria  
