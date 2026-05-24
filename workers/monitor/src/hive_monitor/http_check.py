"""HTTP Endpoint Monitor handler."""
from __future__ import annotations
import socket
from typing import Any
import httpx
from hive_base import JobLogger

DEFAULT_TIMEOUT_MS = 10_000


async def http_endpoint_monitor(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
    url = config.get("url")
    if not isinstance(url, str) or not url:
        raise ValueError("url is required")
    method = str(config.get("method", "GET")).upper()
    if method not in {"GET", "HEAD", "POST"}:
        raise ValueError(f"unsupported method '{method}'")
    expected_status = int(config.get("expectedStatus", 200))
    timeout_s = float(config.get("timeoutMs", DEFAULT_TIMEOUT_MS)) / 1000.0
    headers = config.get("headers") or {}
    if not isinstance(headers, dict):
        raise ValueError("headers must be an object")
    body = config.get("body")
    check_body_contains = config.get("checkBodyContains")
    if check_body_contains is not None and not isinstance(check_body_contains, str):
        raise ValueError("checkBodyContains must be a string")

    await joblog.info("http.request", url=url, method=method, expectedStatus=expected_status)

    t0 = _now_ms()
    try:
        async with httpx.AsyncClient(timeout=timeout_s, follow_redirects=True) as client:
            r = await client.request(method, url, headers=headers, content=body)
    except httpx.HTTPError as e:
        # Infrastructure error — re-raise so the worker retries/DLQs.
        await joblog.error("http.transport_error", error=str(e))
        raise
    except socket.gaierror as e:
        await joblog.error("http.dns_error", error=str(e))
        raise

    latency_ms = _now_ms() - t0
    status_code = r.status_code
    body_matched: bool | None = None
    if check_body_contains is not None:
        body_matched = check_body_contains in r.text

    ok = (status_code == expected_status) and (body_matched is None or body_matched)
    result = {
        "ok": ok,
        "statusCode": status_code,
        "latencyMs": latency_ms,
        "bodyMatched": body_matched,
        "error": None,
    }
    if ok:
        await joblog.info("http.ok", **result)
    else:
        await joblog.warn(
            "http.down",
            statusCode=status_code,
            expectedStatus=expected_status,
            bodyMatched=body_matched,
            latencyMs=latency_ms,
        )
    return result


def _now_ms() -> int:
    import time
    return int(time.monotonic() * 1000)
