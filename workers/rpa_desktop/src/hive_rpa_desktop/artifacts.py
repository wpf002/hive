"""Upload bytes as a Hive artifact (same pattern as the browser pool)."""
from __future__ import annotations
import urllib.parse
import httpx
from hive_base.settings import load_settings


async def upload_artifact(*, job_id: str, filename: str, body: bytes, content_type: str = "application/octet-stream") -> str:
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
        raise RuntimeError(f"artifact upload failed ({r.status_code}): {r.text[:300]}")
    data = r.json()
    art_id = data.get("id")
    if not isinstance(art_id, str):
        raise RuntimeError(f"artifact upload returned no id: {data}")
    return art_id
