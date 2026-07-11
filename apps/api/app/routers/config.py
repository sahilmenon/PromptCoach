from fastapi import APIRouter

from app.config import settings
from app.schemas import ConfigResponse

router = APIRouter(prefix="/v1", tags=["config"])


@router.get("/config", response_model=ConfigResponse)
def get_config():
    return ConfigResponse(
        processing_provider=settings.processing_provider,
        improver_model=settings.improver_model,
        judge_model=settings.judge_model,
        target_model=settings.target_model,
        allow_heuristic_fallback=settings.allow_heuristic_fallback,
        openai_configured=bool(settings.openai_api_key),
        ollama_base_url=settings.ollama_base_url,
    )
