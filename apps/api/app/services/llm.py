"""Cheap LLM client with OpenAI / Ollama / heuristic routing (Q3=C)."""

from __future__ import annotations

import json
import re
from typing import Any

import httpx

from app.config import settings


class LLMError(Exception):
    pass


def _openai_headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {settings.openai_api_key}",
        "Content-Type": "application/json",
    }


async def _chat_openai(messages: list[dict[str, str]], model: str, temperature: float = 0.2) -> str:
    if not settings.openai_api_key:
        raise LLMError("OPENAI_API_KEY not configured")
    url = settings.openai_base_url.rstrip("/") + "/chat/completions"
    payload = {"model": model, "messages": messages, "temperature": temperature}
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(url, headers=_openai_headers(), json=payload)
        if r.status_code >= 400:
            raise LLMError(f"OpenAI error {r.status_code}: {r.text[:300]}")
        data = r.json()
        return data["choices"][0]["message"]["content"]


async def _chat_ollama(messages: list[dict[str, str]], model: str, temperature: float = 0.2) -> str:
    url = settings.ollama_base_url.rstrip("/") + "/api/chat"
    payload = {
        "model": model or settings.ollama_model,
        "messages": messages,
        "stream": False,
        "options": {"temperature": temperature},
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        r = await client.post(url, json=payload)
        if r.status_code >= 400:
            raise LLMError(f"Ollama error {r.status_code}: {r.text[:300]}")
        data = r.json()
        return data.get("message", {}).get("content", "")


async def chat_completion(
    messages: list[dict[str, str]],
    *,
    model: str | None = None,
    temperature: float = 0.2,
    purpose: str = "process",
) -> tuple[str, str]:
    """
    Return (content, provider_used).
    purpose=process uses cheap improver/judge routing; purpose=target uses target model.
    """
    provider = settings.processing_provider.lower()
    use_model = model or (settings.target_model if purpose == "target" else settings.improver_model)

    async def try_openai() -> tuple[str, str]:
        text = await _chat_openai(messages, use_model, temperature)
        return text, "openai"

    async def try_ollama() -> tuple[str, str]:
        text = await _chat_ollama(messages, settings.ollama_model if purpose == "process" else use_model, temperature)
        return text, "ollama"

    errors: list[str] = []

    if provider == "openai":
        return await try_openai()
    if provider == "ollama":
        return await try_ollama()

    # auto: cloud mini first, then Ollama
    if settings.openai_api_key:
        try:
            return await try_openai()
        except Exception as e:  # noqa: BLE001
            errors.append(str(e))
    try:
        return await try_ollama()
    except Exception as e:  # noqa: BLE001
        errors.append(str(e))
        raise LLMError("; ".join(errors) or "No LLM provider available") from e


def extract_json_object(text: str) -> dict[str, Any]:
    """Best-effort JSON object extraction from model output."""
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        raise LLMError("Model did not return JSON")
    return json.loads(m.group(0))
