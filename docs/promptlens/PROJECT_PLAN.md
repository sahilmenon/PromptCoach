# Phased Project Plan

Aligned with [`REQUIREMENTS.md`](./REQUIREMENTS.md) Immediate Instructions §2.  
**No final app code until clarifying questions + architecture approval.**

---

## Goals (from requirements)

1. Help users generate more efficient prompts **before** sending to AI.  
2. Collect previous contexts and **analyze** prompting style.  
3. Score prompts **0–100** (good ↔ bad).  
4. Optional: small LLM **improves** the prompt.  
5. Optional: toggle small LLM / compressor to **strip** low-information tokens from context.  
6. Processing path uses **cheap, efficient** models.  
7. When coding starts: clean, commented code.

---

## Team collaboration (marking criterion)

| Role | Focus | Owns milestones |
|------|--------|-----------------|
| **Backend / ML** | Detectors, scoring, improve, strip, API | M1–M3, M5 |
| **Frontend / UX** | Dashboard, scores, diffs, playground | M4, M6 |
| **Product / Pitch** | Sample data, demo script, slides | M0, M7 |
| **Shared** | Integration, README, rehearsal | M6–M7 |

Daily sync: 15 min standup (blockers only). One shared `sample_history.json` and demo script.

---

## Phase overview

```
M0 Setup & fixtures
M1 History ingest + store
M2 Detectors + InputScore 0–100
M3 Improve (cheap small LLM)
M4 Style report UI
M5 Strip toggle + pre-call pipeline
M6 Playground + proxy + OutputScore
M7 Polish, pitch, rehearsal
```

---

## Milestone details

### M0 — Setup & fixtures (2–3h)

**Steps**

1. Confirm answers to clarifying questions.  
2. Scaffold monorepo (`apps/api`, `apps/web`) per approved stack.  
3. `.env.example` with cheap judge/improver model IDs.  
4. Author `fixtures/sample_history.json` (messy student prompts).  
5. Author `fixtures/bloated_context.txt` for Strip demo.

**Done when:** Empty API health check + empty web shell run locally; fixtures committed.

---

### M1 — Collect previous contexts (4–6h)

**Requirement:** collect users’ previous contexts.

**Steps**

1. Define `Conversation` / `Turn` schema (SQLite).  
2. Implement generic JSON import.  
3. Optional: one ChatGPT export parser.  
4. Persist turns; list conversations endpoint.

**Done when:** Import fixture → ≥50 turns queryable.

---

### M2 — Analysis + score 0–100 (6–8h)

**Requirement:** find inefficiencies; score prompt good/bad 0–100.

**Steps**

1. Rule pack for anti-patterns (vague filler, politeness, missing format, context dump, etc.).  
2. Heuristic InputScore dimensions → aggregate 0–100.  
3. Return findings with spans + suggestions.  
4. Unit tests on fixture prompts (expected score bands).

**Done when:** Same fixture prompt scores stably; findings explain the score.

---

### M3 — Small LLM Improve (4–6h)

**Requirement:** small LLM improves prompt; cheap model only.

**Steps**

1. Improver prompt + JSON schema (`improved`, `changes[]`).  
2. Call mini/Flash/Haiku/Ollama — never frontier.  
3. Re-score after improve; show delta.  
4. Guard: preserve intent (simple embedding check or length/risk flags).

**Done when:** Demo prompt rises ≥10 points or clearly tighter wording.

---

### M4 — Style report UX (4–6h)

**Requirement:** analysis based on history; UX/design criterion.

**Steps**

1. Aggregate top patterns, avg score, est. tokens wasted.  
2. Dashboard: fingerprint chart + top 3 coaching tips.  
3. Click tip → example rewrite from user’s own history.

**Done when:** Judges understand “your bad habit” in &lt;30s on screen.

---

### M5 — Strip toggle (4–6h)

**Requirement:** toggle strip low-information tokens before the call.

**Steps**

1. Heuristic stripper (dedupe, drop filler, compress old turns).  
2. Optional stretch: LLMLingua-2 or small-LLM delete-only.  
3. Preview diff (removed spans highlighted).  
4. Config: `target_ratio`, protect last K turns, never strip code blocks.

**Done when:** ≥30% token cut on bloated fixture; preview is readable.

---

### M6 — Pre-send efficiency path + completeness (6–8h)

**Requirement:** more efficient prompts before sending to AI; technical completeness.

**Steps**

1. Playground: compose → score → Improve? → Strip? → call target model.  
2. OutputScore 0–100 (cheap judge or heuristics).  
3. OpenAI-compatible `/v1/chat/completions` proxy with flags.  
4. Cost estimate (tokens × price table).  
5. Comment public functions; basic README quickstart.

**Done when:** End-to-end path works offline-capable (Ollama fallback optional).

---

### M7 — Presentation & pitch (3–4h)

**Steps**

1. Freeze 3 demo prompts with big deltas.  
2. Rehearse 3-minute script ([`HACKATHON.md`](HACKATHON.md)).  
3. 5–7 slides: problem → solution → architecture → live demo → impact.  
4. Backup screenshots/video if network fails.  
5. Assign speaking roles (collaboration criterion).

**Done when:** Full dry run under 3:30 with no crashes.

---

## Dependency graph

```
M0 → M1 → M2 → M3
         ↘ M4
M2 → M5 → M6 → M7
M3 → M6
M4 → M7
```

Parallelism: after M2, Frontend can do M4 while Backend does M3+M5.

---

## Stretch (only if M0–M6 green)

- LLMLingua-2 strip mode  
- Browser extension capture  
- Intent-drift hard block on Improve  
- Multi-provider router  

---

## Explicit non-goals (hackathon)

- Multi-tenant SaaS / billing  
- Fine-tuning custom models  
- Mobile apps  
- Replacing full observability platforms (LangSmith, etc.)

---

## Approval gate

| Gate | Owner | Status |
|------|-------|--------|
| Clarifying questions answered | Team | ✅ **Q1=D, Q2=D, Q3=C** |
| Architecture & stack approved | Team | ✅ **Stack R** + proxy in MVP + hybrid models |
| Start writing application code | Team | 🟢 Unblocked — start at **M0** when ready |

### Locked scope reminders

- **M1** upload ingest + **M6** OpenAI-compatible proxy are both required.  
- **M4** web UX is the judging surface; no extension work before M6 green.  
- **M3/M5/M6** processing path: try cloud mini → fall back to Ollama.
