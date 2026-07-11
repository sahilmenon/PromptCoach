# Clarifying Questions — LOCKED

Per [`Requirement.md`](../Requirement.md) Immediate Instructions §1.

**Answered:** 2026-07-10  
**Team choices:** `Q1=D`, `Q2=D`, `Q3=C`

---

## Decisions

| # | Question | Choice | Meaning for MVP |
|---|----------|--------|-----------------|
| **Q1** | History source | **D** | **Upload** ChatGPT/Claude/generic JSON for Audit / style report **+** live **OpenAI-compatible proxy** for Score / Improve / Strip |
| **Q2** | Product surface | **D** | **Web dashboard + playground first**; browser extension is **stretch only** (after M0–M6 green) |
| **Q3** | Processing models | **C** | **Cloud mini by default** (GPT-4.1-mini / Haiku / Flash); **Ollama 7–8B fallback** if offline / demo Wi‑Fi fails |

---

## Locked implications

1. **M1** must ship JSON import; **M6** must ship proxy (not stretch).  
2. **UX judging** focuses on React web app — polish dashboard, score, diffs.  
3. **Config** needs `PROCESSING_PROVIDER=cloud|ollama` (or auto-fallback).  
4. Extension (Plasmo/WXT) stays in stretch list — do not start until core demo is solid.  
5. Architecture **Stack R** (FastAPI + React + SQLite) matches these answers → see [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Original options (reference)

### Q1 — Where does past prompting history come from?

| Option | Meaning |
|--------|---------|
| A | Upload exports only |
| B | Paste / fixtures only |
| C | Live proxy only |
| **D ✓** | Upload for Audit + proxy for live path |

### Q2 — Primary product surface?

| Option | Meaning |
|--------|---------|
| A | Web only |
| B | Extension primary |
| C | CLI only |
| **D ✓** | Web first, extension stretch |

### Q3 — Processing models?

| Option | Meaning |
|--------|---------|
| A | Cloud mini only |
| B | Fully local |
| **C ✓** | Hybrid cloud mini + Ollama fallback |
