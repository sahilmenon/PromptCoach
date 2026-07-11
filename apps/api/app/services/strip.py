"""Context Strip: remove low-information tokens/spans before the model call."""

from __future__ import annotations

import re
from typing import Any

from app.schemas import ChatMessage, RemovedSpan
from app.services.tokens import count_messages_tokens, count_tokens

FILLER_LINE = re.compile(
    r"(?i)^(best regards|thanks|thank you|sent from my iphone|confidentiality notice|"
    r"padding token|lorem ipsum|the weather was|lunch was|someone's dog).*"
)
POLITE = re.compile(r"(?i)\b(please|kindly|thanks(?: so much)?)\b[!,.]*\s*")


def _protect_code_regions(text: str) -> tuple[str, list[str]]:
    """Replace fenced code with placeholders so we never strip inside them."""
    blocks: list[str] = []

    def repl(m: re.Match[str]) -> str:
        blocks.append(m.group(0))
        return f"__CODE_BLOCK_{len(blocks) - 1}__"

    return re.sub(r"```[\s\S]*?```", repl, text), blocks


def _restore_code(text: str, blocks: list[str]) -> str:
    for i, b in enumerate(blocks):
        text = text.replace(f"__CODE_BLOCK_{i}__", b)
    return text


def _strip_text(text: str, aggressive: bool = False) -> tuple[str, list[tuple[int, int, str]]]:
    """Return cleaned text and list of (start, end, reason) in the ORIGINAL text."""
    removed: list[tuple[int, int, str]] = []
    protected, blocks = _protect_code_regions(text)

    # Work line-by-line for filler deletion
    lines = protected.split("\n")
    kept: list[str] = []
    # Approximate offsets in protected string
    offset = 0
    seen_norm: set[str] = set()
    for line in lines:
        line_end = offset + len(line)
        norm = re.sub(r"\s+", " ", line.strip().lower())
        drop = False
        reason = ""
        if FILLER_LINE.match(line.strip()):
            drop = True
            reason = "filler_line"
        elif norm and norm in seen_norm:
            drop = True
            reason = "duplicate_line"
        elif aggressive and len(line.strip()) > 0 and re.match(r"(?i)^(random:|unrelated)", line.strip()):
            drop = True
            reason = "low_information"

        if drop:
            # Map roughly — store span in original protected coords
            removed.append((offset, min(line_end + 1, len(protected)), reason))
        else:
            if norm:
                seen_norm.add(norm)
            kept.append(line)
        offset = line_end + 1  # newline

    joined = "\n".join(kept)
    # Remove politeness tokens
    def polite_sub(m: re.Match[str]) -> str:
        removed.append((m.start(), m.end(), "politeness"))
        return ""

    # Note: spans after join are approximate for UI highlighting
    cleaned = POLITE.sub("", joined)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    cleaned = _restore_code(cleaned, blocks)
    return cleaned, removed


def strip_messages(
    messages: list[ChatMessage],
    *,
    target_ratio: float = 0.5,
    protect_last_k_turns: int = 2,
    mode: str = "heuristic",
) -> dict[str, Any]:
    """
    Strip low-information content from older messages.
    Last K turns are protected (only light politeness cleanup).
    """
    target_ratio = min(0.95, max(0.15, target_ratio))
    msgs = list(messages)
    before = count_messages_tokens([m.model_dump() for m in msgs])
    removed_spans: list[RemovedSpan] = []

    protect_from = max(0, len(msgs) - protect_last_k_turns)

    new_msgs: list[ChatMessage] = []
    for i, m in enumerate(msgs):
        aggressive = i < protect_from
        if m.role == "system" and i >= protect_from:
            # Light touch on active system prompt
            cleaned, rem = _strip_text(m.content, aggressive=False)
        elif i >= protect_from:
            cleaned, rem = _strip_text(m.content, aggressive=False)
        else:
            cleaned, rem = _strip_text(m.content, aggressive=True)
            # If still too long vs ratio budget, truncate middle of old turns
            budget = int(count_tokens(m.content) * target_ratio)
            if count_tokens(cleaned) > max(40, budget):
                # Keep head and tail
                words = cleaned.split()
                keep = max(20, budget // 2)
                if len(words) > keep * 2:
                    cleaned = " ".join(words[:keep] + ["[...]"] + words[-keep:])
                    rem.append((keep, len(m.content) - keep, "truncated_middle"))

        for start, end, reason in rem:
            removed_spans.append(
                RemovedSpan(message_index=i, start=start, end=end, reason=reason)
            )
        new_msgs.append(ChatMessage(role=m.role, content=cleaned))

    after = count_messages_tokens([m.model_dump() for m in new_msgs])

    # If still above target, compress oldest user/assistant further
    target_tokens = int(before * target_ratio)
    guard = 0
    while after > target_tokens and guard < len(new_msgs):
        idx = guard
        guard += 1
        if idx >= protect_from:
            break
        content = new_msgs[idx].content
        words = content.split()
        if len(words) < 30:
            continue
        shortened = " ".join(words[:15] + ["[...]"] + words[-10:])
        removed_spans.append(
            RemovedSpan(message_index=idx, start=0, end=len(content), reason="ratio_budget")
        )
        new_msgs[idx] = ChatMessage(role=new_msgs[idx].role, content=shortened)
        after = count_messages_tokens([m.model_dump() for m in new_msgs])

    return {
        "messages": new_msgs,
        "tokens_before": before,
        "tokens_after": after,
        "removed_spans": removed_spans,
        "mode": mode,
    }
