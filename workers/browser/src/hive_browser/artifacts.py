"""Upload bytes as a Hive artifact via POST /api/jobs/:id/artifacts.

Workers authenticate with WORKER_AUTH_TOKEN. Returns the artifact id from the
API so handlers can include it in their result payload.
"""
from __future__ import annotations
import os
import urllib.parse
import httpx
from hive_base.settings import load_settings


async def upload_artifact(
    *,
    job_id: str,
    filename: str,
    body: bytes,
    content_type: str = "application/octet-stream",
) -> str:
    s = load_settings()
    base = s.API_BASE_URL.rstrip("/")
    q = urllib.parse.urlencode({"filename": filename, "contentType": content_type})
    url = f"{base}/api/jobs/{job_id}/artifacts?{q}"
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(
            url,
            content=body,
            headers={
                "Authorization": f"Bearer {s.WORKER_AUTH_TOKEN}",
                "Content-Type": content_type,
            },
        )
    if r.status_code >= 400:
        raise RuntimeError(
            f"artifact upload failed ({r.status_code}): {r.text[:300]} (url={url})"
        )
    data = r.json()
    art_id = data.get("id")
    if not isinstance(art_id, str):
        raise RuntimeError(f"artifact upload returned no id: {data}")
    return art_id


def env_artifact_dir() -> str:
    """Returns HIVE_ARTIFACT_DIR for diagnostics only — the worker does not
    write to disk directly; it always uploads via the API."""
    return os.environ.get("HIVE_ARTIFACT_DIR", "./data/artifacts")
