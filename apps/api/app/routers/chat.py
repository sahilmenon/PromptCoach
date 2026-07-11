"""OpenAI-compatible chat completions gateway with PromptLens flags."""

from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.config import settings
from app.db import CallLog, get_db, utc_now_iso
from app.schemas import ChatCompletionsRequest, ChatMessage
from app.services.improve import improve_prompt
from app.services.llm import LLMError, chat_completion
from app.services.scoring import score_input, score_output_heuristic
from app.services.strip import strip_messages
from app.services.tokens import count_messages_tokens, estimate_cost_usd

router = APIRouter(prefix="/v1", tags=["chat"])


@router.post("/chat/completions")
async def chat_completions(body: ChatCompletionsRequest, db: Session = Depends(get_db)):
    if body.stream:
        raise HTTPException(status_code=400, detail="Streaming not supported in MVP; set stream=false")

    flags = body.promptlens
    messages = list(body.messages)
    raw = [m.model_dump() for m in messages]
    improved = False
    stripped = False
    findings = []
    input_score = None

    last_user = next((m for m in reversed(messages) if m.role == "user"), None)
    if last_user:
        scored = score_input(last_user.content)
        input_score = scored["input_score"]
        findings = [f.model_dump() for f in scored["findings"]]

    if flags and flags.improve and last_user:
        result = await improve_prompt(last_user.content)
        for i in range(len(messages) - 1, -1, -1):
            if messages[i].role == "user":
                messages[i] = ChatMessage(role="user", content=result["improved"])
                break
        improved = True
        input_score = result["input_score_after"]

    tokens_before = count_messages_tokens([m.model_dump() for m in messages])
    if flags and flags.strip:
        strip_result = strip_messages(messages, target_ratio=flags.strip_ratio)
        messages = strip_result["messages"]
        stripped = True
        tokens_after = strip_result["tokens_after"]
    else:
        tokens_after = tokens_before

    model = body.model or settings.target_model
    api_messages = [m.model_dump() for m in messages]

    # Local echo fallback when no provider — keeps demo working offline
    try:
        content, provider = await chat_completion(
            api_messages,
            model=model,
            temperature=body.temperature or 0.2,
            purpose="target",
        )
    except LLMError:
        if not settings.allow_heuristic_fallback:
            raise HTTPException(status_code=502, detail="No LLM provider available")
        content = (
            "[PromptLens offline fallback]\n"
            "No OpenAI key / Ollama available. Prepared messages were processed locally.\n\n"
            f"Last user message:\n{messages[-1].content if messages else ''}"
        )
        provider = "fallback"

    out_score, _dims = score_output_heuristic(
        last_user.content if last_user else "",
        content,
    )
    tokens_out = max(1, len(content) // 4)
    cost = estimate_cost_usd(tokens_after, tokens_out)

    log_id = f"cl_{uuid.uuid4().hex[:12]}"
    db.add(
        CallLog(
            id=log_id,
            raw_messages_json=json.dumps(raw),
            final_messages_json=json.dumps(api_messages),
            improve=1 if improved else 0,
            strip=1 if stripped else 0,
            model=model,
            tokens_in=tokens_after,
            tokens_out=tokens_out,
            est_cost_usd=cost,
            input_score=input_score,
            output_score=out_score,
            created_at=utc_now_iso(),
        )
    )
    db.commit()

    resp = {
        "id": f"chatcmpl_{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": tokens_after,
            "completion_tokens": tokens_out,
            "total_tokens": tokens_after + tokens_out,
        },
        "promptlens": {
            "input_score": input_score,
            "output_score": out_score,
            "efficiency_score": round(100 * tokens_after / max(tokens_before, 1), 1),
            "tokens_saved": max(0, tokens_before - tokens_after) if stripped else 0,
            "est_usd_cost": cost,
            "improved": improved,
            "stripped": stripped,
            "findings": findings if (flags and flags.score) else [],
            "provider": provider,
        },
    }
    return resp
