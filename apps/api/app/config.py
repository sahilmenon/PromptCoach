"""Application settings loaded from environment / .env."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration for PromptLens API."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    processing_provider: str = "auto"  # auto | openai | ollama
    improver_model: str = "gpt-4.1-mini"
    judge_model: str = "gpt-4.1-mini"
    target_model: str = "gpt-4.1-mini"

    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"

    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "qwen2.5:7b"

    database_url: str = "sqlite:///./promptlens.db"
    cors_origins: str = "http://127.0.0.1:5173,http://localhost:5173"
    allow_heuristic_fallback: bool = True

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
