"""History ingest + style report aggregation."""

from __future__ import annotations

import re
import uuid
from collections import Counter
from typing import Any

from sqlalchemy.orm import Session

from app.db import Conversation, FindingRow, Turn, utc_now_iso
from app.schemas import Finding, PatternStat, StyleReport
from app.services.scoring import detect_findings, pattern_name, score_input
from app.services.tokens import PRICE_IN_PER_M, count_tokens


def _redact(text: str) -> str:
    text = re.sub(r"sk-[A-Za-z0-9]{10,}", "sk-REDACTED", text)
    text = re.sub(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", "[email]", text, flags=re.I)
    return text


def _iter_generic(payload: dict[str, Any]) -> list[tuple[str, str | None, list[dict[str, str]]]]:
    """Normalize generic fixture / export-like payload into conversations."""
    out: list[tuple[str, str | None, list[dict[str, str]]]] = []
    if "conversations" in payload:
        for c in payload["conversations"]:
            cid = c.get("id") or f"c_{uuid.uuid4().hex[:10]}"
            title = c.get("title")
            turns = c.get("turns") or c.get("messages") or []
            out.append((cid, title, turns))
    elif "turns" in payload or "messages" in payload:
        cid = payload.get("id") or f"c_{uuid.uuid4().hex[:10]}"
        turns = payload.get("turns") or payload.get("messages") or []
        out.append((cid, payload.get("title"), turns))
    return out


def _iter_chatgpt_export(payload: dict[str, Any]) -> list[tuple[str, str | None, list[dict[str, str]]]]:
    """Best-effort ChatGPT export mapping (mapping or conversations list)."""
    out: list[tuple[str, str | None, list[dict[str, str]]]] = []
    # Some exports are a list
    items = payload if isinstance(payload, list) else payload.get("conversations") or [payload]
    if isinstance(payload, dict) and "mapping" in payload:
        items = [payload]
    for item in items:
        if not isinstance(item, dict):
            continue
        cid = item.get("id") or f"c_{uuid.uuid4().hex[:10]}"
        title = item.get("title") or "ChatGPT chat"
        turns: list[dict[str, str]] = []
        mapping = item.get("mapping") or {}
        # Walk mapping nodes
        for node in mapping.values():
            msg = (node or {}).get("message") or {}
            author = ((msg.get("author") or {}).get("role")) or ""
            content = msg.get("content") or {}
            parts = content.get("parts") or []
            text = "\n".join(p for p in parts if isinstance(p, str))
            if author in {"user", "assistant", "system"} and text.strip():
                turns.append({"role": author, "content": text})
        if turns:
            out.append((cid, title, turns))
    if not out:
        # Fallback to generic
        return _iter_generic(payload if isinstance(payload, dict) else {"conversations": payload})
    return out


def import_history(db: Session, source: str, payload: dict[str, Any]) -> tuple[list[str], int]:
    """Persist conversations/turns and attach findings for user turns."""
    if source == "chatgpt_export":
        convos = _iter_chatgpt_export(payload)
    else:
        convos = _iter_generic(payload)

    conversation_ids: list[str] = []
    turns_ingested = 0

    for cid, title, turns in convos:
        # Replace if re-imported
        existing = db.get(Conversation, cid)
        if existing:
            db.query(FindingRow).filter(
                FindingRow.turn_id.in_(db.query(Turn.id).filter(Turn.conversation_id == cid))
            ).delete(synchronize_session=False)
            db.query(Turn).filter(Turn.conversation_id == cid).delete()
            db.delete(existing)
            db.flush()

        db.add(
            Conversation(
                id=cid,
                source=source,
                title=title,
                imported_at=utc_now_iso(),
            )
        )
        conversation_ids.append(cid)

        for t in turns:
            role = t.get("role", "user")
            content = _redact(t.get("content") or "")
            tid = f"t_{uuid.uuid4().hex[:12]}"
            input_score = None
            if role == "user":
                scored = score_input(content)
                input_score = scored["input_score"]
                for f in scored["findings"]:
                    db.add(
                        FindingRow(
                            id=f"f_{uuid.uuid4().hex[:12]}",
                            turn_id=tid,
                            pattern_id=f.id,
                            severity=f.severity,
                            span_start=f.span[0],
                            span_end=f.span[1],
                            message=f.message,
                            suggestion=f.suggestion,
                        )
                    )
            db.add(
                Turn(
                    id=tid,
                    conversation_id=cid,
                    role=role,
                    content=content,
                    token_count=count_tokens(content),
                    input_score=input_score,
                    output_score=None,
                )
            )
            turns_ingested += 1

    db.commit()
    return conversation_ids, turns_ingested


def build_style_report(db: Session, limit: int = 200) -> StyleReport:
    """Aggregate inefficiencies across recent user turns."""
    turns = (
        db.query(Turn)
        .filter(Turn.role == "user")
        .order_by(Turn.id.desc())
        .limit(limit)
        .all()
    )
    if not turns:
        return StyleReport(
            turns_analyzed=0,
            avg_input_score=0,
            est_tokens_wasted=0,
            est_usd_wasted=0,
            top_patterns=[],
            coaching_headline="Import history to see your prompting fingerprint.",
            sample_findings=[],
        )

    scores = [t.input_score for t in turns if t.input_score is not None]
    avg = sum(scores) / len(scores) if scores else 0.0

    turn_ids = [t.id for t in turns]
    findings = db.query(FindingRow).filter(FindingRow.turn_id.in_(turn_ids)).all()
    counter: Counter[str] = Counter(f.pattern_id for f in findings)
    total_f = sum(counter.values()) or 1
    top = [
        PatternStat(id=pid, name=pattern_name(pid), count=cnt, share=round(cnt / total_f, 3))
        for pid, cnt in counter.most_common(5)
    ]

    # Estimate wasted tokens from finding spans
    wasted = 0
    for f in findings:
        wasted += max(1, (f.span_end - f.span_start) // 4)
    # Also add politeness-ish fraction of low scores
    for t in turns:
        if t.input_score is not None and t.input_score < 55 and t.token_count:
            wasted += int(t.token_count * 0.15)

    usd = (wasted / 1_000_000) * PRICE_IN_PER_M

    if top:
        headline = f"Your signature inefficiency: {top[0].name.lower()} ({top[0].share:.0%} of findings)."
    else:
        headline = "No major anti-patterns detected — keep prompts specific and structured."

    samples = [
        Finding(
            id=f.pattern_id,
            severity=f.severity,
            span=[f.span_start, f.span_end],
            message=f.message,
            suggestion=f.suggestion,
        )
        for f in findings[:8]
    ]

    return StyleReport(
        turns_analyzed=len(turns),
        avg_input_score=round(avg, 1),
        est_tokens_wasted=wasted,
        est_usd_wasted=round(usd, 4),
        top_patterns=top,
        coaching_headline=headline,
        sample_findings=samples,
    )


def list_conversations(db: Session) -> list[dict[str, Any]]:
    rows = db.query(Conversation).order_by(Conversation.imported_at.desc()).all()
    result = []
    for c in rows:
        n = db.query(Turn).filter(Turn.conversation_id == c.id).count()
        result.append(
            {
                "id": c.id,
                "source": c.source,
                "title": c.title,
                "imported_at": c.imported_at,
                "turn_count": n,
            }
        )
    return result
