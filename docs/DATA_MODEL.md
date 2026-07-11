# Data Model & Privacy

---

## Entities

**Conversation** — imported or live session  
**Turn** — role + content + optional scores  
**Finding** — pattern_id, severity, span, suggestion  
**CallLog** — prepare/send metrics (improve/strip flags, tokens, cost)

---

## SQLite sketch

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT,
  imported_at TEXT NOT NULL
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER,
  input_score REAL,
  output_score REAL
);

CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  pattern_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  span_start INTEGER,
  span_end INTEGER,
  message TEXT,
  suggestion TEXT
);

CREATE TABLE call_logs (
  id TEXT PRIMARY KEY,
  raw_messages_json TEXT NOT NULL,
  final_messages_json TEXT NOT NULL,
  improve INTEGER NOT NULL,
  strip INTEGER NOT NULL,
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  est_cost_usd REAL,
  input_score REAL,
  output_score REAL,
  created_at TEXT NOT NULL
);
```

---

## Privacy

- Local SQLite by default (practical + trustworthy).  
- Disclose when cheap cloud models see prompt text.  
- Redact API-key-like strings on import.  
- User can wipe history (endpoint planned).

---

## Fixtures (for collaboration)

- `fixtures/sample_history.json` — shared messy prompts  
- `fixtures/bloated_context.txt` — strip demo  
Keep fixtures identical across team machines for the pitch.
