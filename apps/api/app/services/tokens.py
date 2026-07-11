"""Token estimation helpers (tiktoken with whitespace fallback)."""

from __future__ import annotations

from functools import lru_cache


@lru_cache
def _encoding():
    try:
        import tiktoken

        return tiktoken.get_encoding("cl100k_base")
    except Exception:
        return None


def count_tokens(text: str) -> int:
    """Return approximate token count for billing/efficiency displays."""
    if not text:
        return 0
    enc = _encoding()
    if enc is not None:
        return len(enc.encode(text))
    # Fallback: ~4 chars per token
    return max(1, len(text) // 4)


def count_messages_tokens(messages: list[dict] | list) -> int:
    total = 0
    for m in messages:
        content = m["content"] if isinstance(m, dict) else m.content
        total += count_tokens(content) + 4  # role overhead approx
    return total


# Rough USD per 1M tokens for display (mini-class defaults)
PRICE_IN_PER_M = 0.40
PRICE_OUT_PER_M = 1.60


def estimate_cost_usd(tokens_in: int, tokens_out: int = 0) -> float:
    return (tokens_in / 1_000_000) * PRICE_IN_PER_M + (tokens_out / 1_000_000) * PRICE_OUT_PER_M
