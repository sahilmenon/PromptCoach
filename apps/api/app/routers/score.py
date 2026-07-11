from fastapi import APIRouter
from pydantic import BaseModel

from app.config import settings
from app.schemas import ExchangeScoreResponse, InputScoreResponse, OutputDimensions
from app.services.llm import LLMError, chat_completion, extract_json_object
from app.services.scoring import score_input, score_output_heuristic

router = APIRouter(prefix="/v1/score", tags=["score"])


class ScoreInputBody(BaseModel):
    prompt: str
    context: str | None = None


class ScoreExchangeBody(BaseModel):
    prompt: str
    output: str
    use_llm_judge: bool = False


@router.post("/input", response_model=InputScoreResponse)
def score_input_route(body: ScoreInputBody):
    result = score_input(body.prompt, body.context)
    return InputScoreResponse(**result)


@router.post("/exchange", response_model=ExchangeScoreResponse)
async def score_exchange_route(body: ScoreExchangeBody):
    inp = score_input(body.prompt)
    input_resp = InputScoreResponse(**inp)

    if body.use_llm_judge:
        try:
            messages = [
                {
                    "role": "system",
                    "content": (
                        "Score the ASSISTANT output against the USER prompt. "
                        "Return ONLY JSON with keys task_fit,specificity,waste,format_compliance,"
                        "calibration as numbers 0-10, and rationales object."
                    ),
                },
                {
                    "role": "user",
                    "content": f"USER:\n{body.prompt}\n\nASSISTANT:\n{body.output}",
                },
            ]
            content, _ = await chat_completion(messages, model=settings.judge_model, purpose="process")
            data = extract_json_object(content)

            def ten(x: float) -> float:
                return float(max(0, min(100, float(x) * 10)))

            dims = OutputDimensions(
                task_fit=ten(data.get("task_fit", 5)),
                specificity=ten(data.get("specificity", 5)),
                waste=ten(data.get("waste", 5)),
                format_compliance=ten(data.get("format_compliance", 5)),
                calibration=ten(data.get("calibration", 5)),
            )
            out_score = round(
                (dims.task_fit or 0) * 0.30
                + dims.specificity * 0.20
                + dims.waste * 0.20
                + dims.format_compliance * 0.20
                + dims.calibration * 0.10,
                1,
            )
            return ExchangeScoreResponse(
                input=input_resp,
                output_score=out_score,
                output_dimensions=dims,
                judge_mode="llm",
            )
        except (LLMError, Exception):
            if not settings.allow_heuristic_fallback:
                raise

    out_score, dims = score_output_heuristic(body.prompt, body.output)
    return ExchangeScoreResponse(
        input=input_resp,
        output_score=out_score,
        output_dimensions=dims,
        judge_mode="heuristic",
    )
