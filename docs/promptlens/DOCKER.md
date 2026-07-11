# Docker (Mac / Windows / Linux)

One shared Compose stack — **no OS-specific Dockerfiles**. Docker Desktop on Mac and Windows both run Linux containers.

## Commands

```bash
cp .env.example .env    # optional OPENAI_API_KEY
docker compose up --build
```

- UI: http://localhost:8080  
- API: http://localhost:8000  

## How networking works

```
Browser → :8080 (web/nginx) → proxies /v1,/health → api:8000
Browser → :8000 (api) directly for OpenAPI / external clients
```

`VITE_API_BASE` is built as empty string so the SPA uses same-origin paths.

## Ollama on the host

Compose sets `OLLAMA_BASE_URL=http://host.docker.internal:11434` so the API container can reach Ollama installed on your Mac/Windows host. Linux uses the same hostname via `extra_hosts: host.docker.internal:host-gateway`.

## Data

SQLite lives in the `promptlens-data` volume at `/data/promptlens.db` inside the API container.
