"""SQLite models and session helpers."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Generator

from sqlalchemy import Float, Integer, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    source: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str | None] = mapped_column(String, nullable=True)
    imported_at: Mapped[str] = mapped_column(String, nullable=False)


class Turn(Base):
    __tablename__ = "turns"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    conversation_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    role: Mapped[str] = mapped_column(String, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    token_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    input_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    output_score: Mapped[float | None] = mapped_column(Float, nullable=True)


class FindingRow(Base):
    __tablename__ = "findings"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    turn_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    pattern_id: Mapped[str] = mapped_column(String, nullable=False)
    severity: Mapped[str] = mapped_column(String, nullable=False)
    span_start: Mapped[int] = mapped_column(Integer, nullable=False)
    span_end: Mapped[int] = mapped_column(Integer, nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    suggestion: Mapped[str] = mapped_column(Text, nullable=False)


class CallLog(Base):
    __tablename__ = "call_logs"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    raw_messages_json: Mapped[str] = mapped_column(Text, nullable=False)
    final_messages_json: Mapped[str] = mapped_column(Text, nullable=False)
    improve: Mapped[int] = mapped_column(Integer, nullable=False)
    strip: Mapped[int] = mapped_column(Integer, nullable=False)
    model: Mapped[str | None] = mapped_column(String, nullable=True)
    tokens_in: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tokens_out: Mapped[int | None] = mapped_column(Integer, nullable=True)
    est_cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    input_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    output_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[str] = mapped_column(String, nullable=False)


def _sqlite_url(url: str) -> str:
    # SQLAlchemy needs four slashes for absolute paths; keep relative as-is.
    return url


engine = create_engine(
    _sqlite_url(settings.database_url),
    connect_args={"check_same_thread": False},
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def init_db() -> None:
    Base.metadata.create_all(bind=engine)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
