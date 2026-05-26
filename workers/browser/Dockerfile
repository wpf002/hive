# Browser worker — Chromium + Playwright. Big base image but unavoidable for
# headless scraping/screenshot work.
FROM python:3.11-slim AS runtime
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY workers/base/ /app/workers/base/
COPY workers/browser/ /app/workers/browser/

RUN pip install --no-cache-dir -e /app/workers/base -e /app/workers/browser \
 && python -m playwright install chromium --with-deps

ENV PYTHONUNBUFFERED=1 \
    HIVE_WORKER_REGION=fly \
    HIVE_WORKER_ZONE=default

CMD ["python", "-m", "hive_browser.main"]
