from fastapi import APIRouter

from app.schemas import ImproveRequest, ImproveResponse
from app.services.improve import improve_prompt

router = APIRouter(prefix="/v1", tags=["improve"])


@router.post("/improve", response_model=ImproveResponse)
async def improve_route(body: ImproveRequest):
    result = await improve_prompt(body.prompt, body.context)
    return ImproveResponse(**result)
