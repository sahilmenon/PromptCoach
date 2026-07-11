from fastapi import APIRouter

from app.schemas import StripRequest, StripResponse
from app.services.strip import strip_messages

router = APIRouter(prefix="/v1", tags=["strip"])


@router.post("/strip", response_model=StripResponse)
def strip_route(body: StripRequest):
    result = strip_messages(
        body.messages,
        target_ratio=body.target_ratio,
        protect_last_k_turns=body.protect_last_k_turns,
        mode=body.mode,
    )
    return StripResponse(**result)
