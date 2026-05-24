"""Async Postgres helpers for job lifecycle + log batching."""
from __future__ import annotations
import json
from datetime import datetime, timezone
from typing import Any, Optional
import psycopg
from psycopg.types.json import Json


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def mark_running(dsn: str, job_id: str) -> None:
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                'UPDATE "Job" SET status=%s, "startedAt"=%s WHERE id=%s',
                ("running", _now(), job_id),
            )
        await conn.commit()


async def mark_succeeded(dsn: str, job_id: str, result: Any) -> None:
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                'UPDATE "Job" SET status=%s, "finishedAt"=%s, result=%s WHERE id=%s',
                ("succeeded", _now(), Json(result), job_id),
            )
        await conn.commit()


async def mark_failed(dsn: str, job_id: str, error: str) -> None:
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                'UPDATE "Job" SET status=%s, "finishedAt"=%s, error=%s WHERE id=%s',
                ("failed", _now(), error, job_id),
            )
        await conn.commit()


async def insert_logs(dsn: str, rows: list[dict[str, Any]]) -> None:
    """Batch-insert JobLog rows.

    Each row: {id, jobId, level, message, meta, timestamp}.
    """
    if not rows:
        return
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            await cur.executemany(
                'INSERT INTO "JobLog" (id, "jobId", level, message, meta, timestamp) '
                'VALUES (%s, %s, %s, %s, %s, %s)',
                [
                    (
                        r["id"],
                        r["jobId"],
                        r["level"],
                        r["message"],
                        Json(r.get("meta")) if r.get("meta") is not None else None,
                        r["timestamp"],
                    )
                    for r in rows
                ],
            )
        await conn.commit()


def cuid_like() -> str:
    """Lightweight collision-resistant id. Not real cuid but good enough for log PKs."""
    import secrets
    return "c" + secrets.token_hex(12)
