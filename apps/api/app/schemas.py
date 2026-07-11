"""Pydantic request/response schemas."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class Finding(BaseModel):
    id: str
    severity: str
    span: list[int] = Field(description="[start, end) character offsets")
    message: str
    suggestion: str


class ScoreDimensions(BaseModel):
    clarity: float
    specificity: float
    structure: float
    concision: float
    context_fit: float


class InputScoreResponse(BaseModel):
    input_score: float
    dimensions: ScoreDimensions
    findings: list[Finding]
    est_tokens: int
    band: str


class OutputDimensions(BaseModel):
    task_fit: float | None
    specificity: float
    waste: float
    format_compliance: float
    calibration: float


class ExchangeScoreResponse(BaseModel):
    input: InputScoreResponse
    output_score: float | None
    output_dimensions: OutputDimensions
    judge_mode: str


class ImproveRequest(BaseModel):
    prompt: str
    context: str | None = None


class ImproveResponse(BaseModel):
    improved: str
    changes: list[str]
    risk_flags: list[str] = []
    input_score_before: float
    input_score_after: float
    est_token_delta: int
    mode: str  # llm | heuristic


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class StripRequest(BaseModel):
    messages: list[ChatMessage]
    target_ratio: float = 0.5
    protect_last_k_turns: int = 2
    mode: Literal["heuristic", "abstractive"] = "heuristic"


class RemovedSpan(BaseModel):
    message_index: int
    start: int
    end: int
    reason: str


class StripResponse(BaseModel):
    messages: list[ChatMessage]
    tokens_before: int
    tokens_after: int
    removed_spans: list[RemovedSpan]
    mode: str


class PrepareRequest(BaseModel):
    messages: list[ChatMessage]
    improve: bool = False
    strip: bool = False
    strip_ratio: float = 0.5


class PrepareResponse(BaseModel):
    messages: list[ChatMessage]
    input_score: float
    findings: list[Finding]
    improved: bool
    stripped: bool
    tokens_before: int
    tokens_after: int
    changes: list[str] = []
    removed_spans: list[RemovedSpan] = []
    improve_mode: str | None = None


class HistoryImportRequest(BaseModel):
    source: Literal["generic", "chatgpt_export"] = "generic"
    payload: dict[str, Any]


class HistoryImportResponse(BaseModel):
    conversation_ids: list[str]
    turns_ingested: int


class PatternStat(BaseModel):
    id: str
    name: str
    count: int
    share: float


class StyleReport(BaseModel):
    turns_analyzed: int
    avg_input_score: float
    est_tokens_wasted: int
    est_usd_wasted: float
    top_patterns: list[PatternStat]
    coaching_headline: str
    sample_findings: list[Finding]


class PromptLensFlags(BaseModel):
    improve: bool = False
    strip: bool = False
    strip_ratio: float = 0.5
    score: bool = True


class ChatCompletionsRequest(BaseModel):
    model: str | None = None
    messages: list[ChatMessage]
    temperature: float | None = 0.2
    stream: bool = False
    promptlens: PromptLensFlags | None = None


class ConfigResponse(BaseModel):
    processing_provider: str
    improver_model: str
    judge_model: str
    target_model: str
    allow_heuristic_fallback: bool
    openai_configured: bool
    ollama_base_url: str
