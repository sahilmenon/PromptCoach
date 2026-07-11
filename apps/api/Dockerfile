# PromptLens API — FastAPI
FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY apps/api/requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

# App code + shared rule pack (needed by detectors)
COPY apps/api/app /app/app
COPY packages/rules /app/packages/rules

RUN mkdir -p /data

ENV DATABASE_URL=sqlite:////data/promptlens.db \
    CORS_ORIGINS=http://127.0.0.1:8080,http://localhost:8080,http://127.0.0.1:5173,http://localhost:5173 \
    ALLOW_HEURISTIC_FALLBACK=true \
    PROCESSING_PROVIDER=auto

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
