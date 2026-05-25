"""Shared Docker SDK helpers for the ci_agent pool.

Workers assume `/var/run/docker.sock` is reachable. On Linux that may mean
adding the worker user to the `docker` group. Errors are surfaced loudly via
joblog so the user knows when the socket is the problem vs. their workload.
"""
from __future__ import annotations
import asyncio
import shlex
from collections import deque
from typing import Any, Optional

import docker  # type: ignore[import-untyped]
from docker.errors import APIError, DockerException  # type: ignore[import-untyped]

from hive_base import JobLogger


def get_client() -> "docker.DockerClient":  # type: ignore[name-defined]
    """Return a connected Docker client or raise with an actionable error."""
    try:
        client = docker.from_env(timeout=120)
        client.ping()
        return client
    except DockerException as e:
        raise RuntimeError(
            "Cannot reach the Docker daemon. Confirm Docker Desktop / dockerd is running and "
            "/var/run/docker.sock is readable by this user (on Linux: `sudo chgrp docker /var/run/docker.sock` "
            "and add user to the docker group). Original error: " + str(e)
        ) from e


def tail_lines(buf: deque[str], n: int = 50) -> list[str]:
    return list(buf)[-n:]


async def stream_container_logs(
    container: Any,
    joblog: JobLogger,
    *,
    stdout_event: str = "ci.stdout",
    stderr_event: str = "ci.stderr",
    stdout_buf: Optional[deque[str]] = None,
    stderr_buf: Optional[deque[str]] = None,
) -> None:
    """Stream container stdout/stderr to joblog. Blocks until the stream ends.

    Container must have been started with stream=False, detach=True. The
    streaming itself runs in a thread because docker-py's iterator API is sync.
    """
    def _drain() -> None:
        try:
            # demux=True yields (stdout, stderr) chunks separately.
            for stdout_chunk, stderr_chunk in container.logs(
                stream=True, follow=True, stdout=True, stderr=True, demux=True
            ):
                if stdout_chunk:
                    text = stdout_chunk.decode("utf-8", errors="replace")
                    for line in text.rstrip("\n").split("\n"):
                        if stdout_buf is not None:
                            stdout_buf.append(line)
                        # joblog calls have to happen on the event loop thread.
                        asyncio.run_coroutine_threadsafe(
                            joblog.info(stdout_event, line=line), loop
                        )
                if stderr_chunk:
                    text = stderr_chunk.decode("utf-8", errors="replace")
                    for line in text.rstrip("\n").split("\n"):
                        if stderr_buf is not None:
                            stderr_buf.append(line)
                        asyncio.run_coroutine_threadsafe(
                            joblog.warn(stderr_event, line=line), loop
                        )
        except APIError as e:
            asyncio.run_coroutine_threadsafe(
                joblog.error("ci.docker_api_error", error=str(e)), loop
            )

    loop = asyncio.get_running_loop()
    await asyncio.to_thread(_drain)


def quote_command(cmd: str) -> list[str]:
    """Wrap a shell command in `sh -c` so users can pass pipelines / && chains."""
    return ["sh", "-c", cmd]


__all__ = [
    "get_client",
    "stream_container_logs",
    "tail_lines",
    "quote_command",
    "shlex",
]
