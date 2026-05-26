# Minimal scraper worker image used by docker-compose's worker-fleet-test
# profile and (later) cloud deploys. The build context is the repo root so the
# image can include workers/base as an editable install.
#
#   docker build -f workers/scraper/Dockerfile -t hive-worker-scraper .
#
FROM python:3.11-slim AS runtime

WORKDIR /app

# System deps kept small. lxml / brotli are useful for the HTML parsers
# beautifulsoup4 pulls in but we hold them back unless a worker actually
# needs them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY workers/base/ /app/workers/base/
COPY workers/scraper/ /app/workers/scraper/

RUN pip install --no-cache-dir -e /app/workers/base -e /app/workers/scraper

# Defaults — overridden via the compose service env or docker run -e.
ENV PYTHONUNBUFFERED=1 \
    HIVE_WORKER_REGION=local \
    HIVE_WORKER_ZONE=default

CMD ["python", "-m", "hive_scraper.main"]
