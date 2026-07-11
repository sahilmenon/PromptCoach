"""Prompt Improve: cheap LLM rewrite with heuristic fallback."""

from __future__ import annotations

import re

from app.config import settings
from app.services.llm import LLMError, chat_completion, extract_json_object
from app.services.scoring import score_input
from app.services.tokens import count_tokens

IMPROVER_SYSTEM = """You are PromptLens Improver. Rewrite the user's prompt to maximize
Clarity, Specificity, Structure, Concision, and ContextFit.
Rules:
- Preserve intent; do not add new requirements the user did not ask for.
- Remove politeness and duplicate constraints.
- Add a minimal output format if missing and clearly needed.
- Return ONLY JSON: {"improved": str, "changes": [str], "risk_flags": [str]}
"""


def heuristic_improve(prompt: str, context: str | None = None) -> dict:
    """Deterministic local rewrite when no LLM is available."""
    original = prompt or ""
    text = original
    changes: list[str] = []

    # Strip greetings / politeness
    new = re.sub(r"(?i)^(hi|hello|hey)[!,.]*\s*", "", text)
    new = re.sub(r"(?i)\b(please|kindly|thanks(?: so much)?|thank you)\b[!,.]*\s*", "", new)
    if new != text:
        changes.append("Removed greetings / politeness padding")
        text = new

    # Soften detail bait
    new = re.sub(
        r"(?i)\b(carefully|thoroughly|comprehensively|in extreme detail|in as much detail as possible|deep dive)\b\s*",
        "",
        text,
    )
    if new != text:
        changes.append("Removed vague detail-bait wording")
        text = new

    # Collapse repeated whitespace
    new = re.sub(r"[ \t]{2,}", " ", text)
    new = re.sub(r"\n{3,}", "\n\n", new).strip()
    if new != text.strip():
        changes.append("Collapsed extra whitespace")
        text = new

    # Multi-task hint
    if re.search(r"(?i)\band also\b", text):
        changes.append("Detected multiple tasks — leading with primary ask; split recommended")
        # Keep text but prefix guidance
        text = "Primary task (split others into follow-ups):\n" + text

    # Add format if missing and looks like a generation ask
    if re.search(r"(?i)\b(list|compare|summarize|generate|write|return)\b", text) and not re.search(
        r"(?i)\b(json|bullet|markdown|schema|format)\b", text
    ):
        text = text.rstrip() + "\n\nOutput format: concise bullet list."
        changes.append("Added minimal output format")

    if context and count_tokens(context) > 200:
        changes.append("Context is large — excerpt only what the model needs")

    if not changes:
        changes.append("Prompt already relatively clean; minor tidy only")
        text = text.strip()

    before = score_input(original, context)
    after = score_input(text, context)
    return {
        "improved": text.strip(),
        "changes": changes,
        "risk_flags": [],
        "input_score_before": before["input_score"],
        "input_score_after": after["input_score"],
        "est_token_delta": count_tokens(text) - count_tokens(original),
        "mode": "heuristic",
    }


async def improve_prompt(prompt: str, context: str | None = None) -> dict:
    """Improve via cheap LLM; fall back to heuristics if configured."""
    before = score_input(prompt, context)
    user_block = prompt if not context else f"Context:\n{context}\n\nPrompt:\n{prompt}"
    messages = [
        {"role": "system", "content": IMPROVER_SYSTEM},
        {"role": "user", "content": user_block},
    ]

    try:
        content, _provider = await chat_completion(messages, model=settings.improver_model, purpose="process")
        data = extract_json_object(content)
        improved = str(data.get("improved", "")).strip() or prompt
        changes = [str(c) for c in data.get("changes", [])]
        risk_flags = [str(c) for c in data.get("risk_flags", [])]
        after = score_input(improved, context)
        return {
            "improved": improved,
            "changes": changes,
            "risk_flags": risk_flags,
            "input_score_before": before["input_score"],
            "input_score_after": after["input_score"],
            "est_token_delta": count_tokens(improved) - count_tokens(prompt or ""),
            "mode": "llm",
        }
    except (LLMError, Exception):
        if settings.allow_heuristic_fallback:
            return heuristic_improve(prompt, context)
        raise
