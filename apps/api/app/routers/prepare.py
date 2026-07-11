from fastapi import APIRouter

from app.schemas import PrepareRequest, PrepareResponse
from app.services.improve import improve_prompt
from app.services.scoring import score_input
from app.services.strip import strip_messages
from app.services.tokens import count_messages_tokens

router = APIRouter(prefix="/v1", tags=["prepare"])


@router.post("/prepare", response_model=PrepareResponse)
async def prepare_route(body: PrepareRequest):
    messages = list(body.messages)
    tokens_before = count_messages_tokens([m.model_dump() for m in messages])
    changes: list[str] = []
    removed = []
    improved = False
    stripped = False
    improve_mode = None

    # Score last user message
    last_user = next((m for m in reversed(messages) if m.role == "user"), None)
    prompt = last_user.content if last_user else ""
    scored = score_input(prompt)

    if body.improve and last_user:
        result = await improve_prompt(last_user.content)
        # Replace last user message
        for i in range(len(messages) - 1, -1, -1):
            if messages[i].role == "user":
                messages[i] = messages[i].model_copy(update={"content": result["improved"]})
                break
        changes = result["changes"]
        improved = True
        improve_mode = result["mode"]
        scored = score_input(result["improved"])

    if body.strip:
        strip_result = strip_messages(messages, target_ratio=body.strip_ratio)
        messages = strip_result["messages"]
        removed = strip_result["removed_spans"]
        stripped = True
        tokens_after = strip_result["tokens_after"]
    else:
        tokens_after = count_messages_tokens([m.model_dump() for m in messages])

    return PrepareResponse(
        messages=messages,
        input_score=scored["input_score"],
        findings=scored["findings"],
        improved=improved,
        stripped=stripped,
        tokens_before=tokens_before,
        tokens_after=tokens_after,
        changes=changes,
        removed_spans=removed,
        improve_mode=improve_mode,
    )
