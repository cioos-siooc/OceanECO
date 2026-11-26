FROM python:3.13-slim

WORKDIR /app

RUN pip install --no-cache-dir uv

# Writable uv cache for whatever host UID the container runs as
ENV UV_CACHE_DIR=/app/.cache/uv \
    UV_NO_SYNC=1

# Create a user matching the host UID/GID passed via docker-compose
# user: "${UID:-1000}:${GID:-1000}" — without a passwd entry uv fails
RUN groupadd -g 1000 appuser \
    && useradd -u 1000 -g 1000 -m -s /bin/bash appuser

COPY sensors/pyproject.toml ./
RUN uv sync --no-dev

COPY sensors/*.py ./
COPY sensors/catalog_*.yml ./

# Only the uv cache must be writable by the host UID; a chmod -R over /app
# would copy the whole .venv into a new layer (very slow).
RUN mkdir -p /app/.cache/uv && chmod -R a+rwX /app/.cache
