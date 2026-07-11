# API Sketch

Base: `http://127.0.0.1:8000`  
Docs-only; implement after architecture approval.

---

## Health

`GET /health` → `{ "status": "ok" }`

---

## History (collect previous contexts)

`POST /v1/history/import`  
Body: `{ "source": "generic"|"chatgpt_export", "payload": ... }`  
→ `{ "turns_ingested": n, "conversation_ids": [] }`

`GET /v1/analytics/style-report?limit=200`  
→ fingerprint + top inefficiencies + avg scores

---

## Score (0–100)

`POST /v1/score/input`  
`{ "prompt": "...", "context": null }`  
→ `{ "input_score": 0-100, "dimensions": {}, "findings": [], "est_tokens": n }`

`POST /v1/score/exchange`  
`{ "prompt": "...", "output": "...", "use_llm_judge": true }`  
→ input + output scores (judge = cheap model)

---

## Improve (cheap small LLM)

`POST /v1/improve`  
`{ "prompt": "...", "context": null }`  
→ `{ "improved": "...", "changes": [], "input_score_before": n, "input_score_after": n }`

---

## Strip (toggle path)

`POST /v1/strip`  
```json
{
  "messages": [{ "role": "user", "content": "..." }],
  "target_ratio": 0.5,
  "protect_last_k_turns": 2,
  "mode": "heuristic"
}
```
→ stripped messages, token before/after, `removed_spans[]`

---

## Pre-send combined helper

`POST /v1/prepare`  
```json
{
  "messages": [],
  "improve": true,
  "strip": true,
  "strip_ratio": 0.5
}
```
→ prepared messages + scores + diffs (then client or gateway sends to AI)

---

## Gateway (optional completeness)

`POST /v1/chat/completions` — OpenAI-compatible  
Extension field:

```json
"promptlens": { "improve": true, "strip": true, "score": true }
```

Response includes `promptlens` metrics object.

---

## Config

`GET /v1/config` — exposes processing model IDs (must be cheap/efficient).
