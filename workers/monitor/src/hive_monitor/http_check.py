"""HTTP Endpoint Monitor handler."""
from __future__ import annotations
import ipaddress
import os
import socket
from urllib.parse import urlparse
from typing import Any
import httpx
from hive_base import JobLogger

DEFAULT_TIMEOUT_MS = 10_000

# SSRF guard: by default, refuse to fetch URLs that resolve to private,
# loopback, link-local (incl. the 169.254.169.254 cloud-metadata endpoint),
# or otherwise non-public addresses. Operators who legitimately monitor
# internal services can opt in with HIVE_MONITOR_ALLOW_INTERNAL=true.
_ALLOW_INTERNAL = os.environ.get("HIVE_MONITOR_ALLOW_INTERNAL", "").lower() == "true"


def _is_public_ip(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _assert_public_url(url: str) -> None:
    """Raise ValueError if `url` points at a non-public address (SSRF guard)."""
    if _ALLOW_INTERNAL:
        return
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError(f"unsupported url scheme '{parsed.scheme}' (only http/https)")
    host = parsed.hostname
    if not host:
        raise ValueError("url has no host")
    # Resolve every address the host maps to; reject if ANY is non-public so a
    # DNS name can't smuggle in an internal IP.
    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror as e:
        raise ValueError(f"cannot resolve host '{host}': {e}") from e
    addrs = {info[4][0] for info in infos}
    for addr in addrs:
        if not _is_public_ip(addr):
            raise ValueError(
                f"refusing to fetch '{host}' — resolves to non-public address {addr}. "
                "Set HIVE_MONITOR_ALLOW_INTERNAL=true to allow internal targets."
            )


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
    # Redirects are off by default: a public host could otherwise 3xx to an
    # internal address and bypass the SSRF guard. Opt in per-job if needed.
    follow_redirects = bool(config.get("followRedirects", False))

    _assert_public_url(url)

    await joblog.info("http.request", url=url, method=method, expectedStatus=expected_status)

    t0 = _now_ms()
    try:
        async with httpx.AsyncClient(timeout=timeout_s, follow_redirects=follow_redirects) as client:
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
