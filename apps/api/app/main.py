"""PromptLens API — FastAPI application entrypoint."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.db import init_db
from app.routers import analytics, chat, config, health, history, improve, prepare, score, strip


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Ensure SQLite tables exist on startup.
    init_db()
    yield


app = FastAPI(
    title="PromptLens API",
    version="0.1.0",
    description="Prompting coach — history audit, 0–100 scores, cheap Improve",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(config.router)
app.include_router(history.router)
app.include_router(analytics.router)
app.include_router(score.router)
app.include_router(improve.router)
app.include_router(strip.router)
app.include_router(prepare.router)
app.include_router(chat.router)
