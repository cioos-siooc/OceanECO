FROM python:3.13-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends rsync openssh-client curl \
    && rm -rf /var/lib/apt/lists/*

# Prefect and its dependencies at sensors/uv.lock's versions (a bare `pip install prefect==`
# pulls whatever FastAPI etc. is newest, which can break it). Must be <= the shared server's version.
COPY sensors/pyproject.toml sensors/uv.lock /tmp/sensors/
RUN pip install --no-cache-dir uv \
    && uv export --frozen --no-dev --no-hashes --no-emit-project --project /tmp/sensors -o /tmp/lock.txt \
    && pip install --no-cache-dir prefect -c /tmp/lock.txt \
    && rm -rf /tmp/sensors /tmp/lock.txt

WORKDIR /app
COPY scripts/backup.sh scripts/
COPY backup/flows.py ./

CMD ["python", "flows.py"]
