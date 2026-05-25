"""Shell Command Runner (Native) — subprocess on the host, no container.

Faster than ci_agent's Docker version; less isolated. Per /docs/POOLS.md:
this runs as the worker user with full access to anything that user can read.
Treat user-supplied commands as RCE; only enable this template for trusted
operators.
"""
from __future__ import annotations
import asyncio
import os
import time
from collections import deque
from typing import Any

from hive_base import JobLogger

DEFAULT_TIMEOUT_S = 60


async def _stream(stream: asyncio.StreamReader, buf: deque[str], joblog: JobLogger, event: str) -> None:
    while True:
        line = await stream.readline()
        if not line:
            return
        text = line.decode("utf-8", errors="replace").rstrip("\n")
        buf.append(text)
        if event.endswith("stderr"):
            await joblog.warn(event, line=text)
        else:
            await joblog.info(event, line=text)


async def shell_command_native(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
    command = config.get("command")
    if not isinstance(command, str) or not command.strip():
        raise ValueError("command is required")
    timeout_s = int(config.get("timeoutSeconds", DEFAULT_TIMEOUT_S))
    env_vars = config.get("envVars") or {}
    if not isinstance(env_vars, dict):
        raise ValueError("envVars must be an object")
    working_dir = config.get("workingDir") or os.path.expanduser("~")

    await joblog.info("sh.start", command=command, workdir=working_dir, timeout=timeout_s)
    env = {**os.environ, **{str(k): str(v) for k, v in env_vars.items()}}

    proc = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
        cwd=working_dir,
    )

    stdout_buf: deque[str] = deque(maxlen=2000)
    stderr_buf: deque[str] = deque(maxlen=2000)
    readers = [
        asyncio.create_task(_stream(proc.stdout, stdout_buf, joblog, "sh.stdout")),  # type: ignore[arg-type]
        asyncio.create_task(_stream(proc.stderr, stderr_buf, joblog, "sh.stderr")),  # type: ignore[arg-type]
    ]

    t0 = time.time()
    try:
        exit_code = await asyncio.wait_for(proc.wait(), timeout=timeout_s)
    except asyncio.TimeoutError:
        await joblog.error("sh.timeout", timeout=timeout_s)
        proc.kill()
        await proc.wait()
        exit_code = -1
    finally:
        for r in readers:
            try:
                await asyncio.wait_for(r, timeout=2.0)
            except asyncio.TimeoutError:
                r.cancel()

    return {
        "exitCode": exit_code,
        "durationSeconds": round(time.time() - t0, 3),
        "stdoutTail": list(stdout_buf)[-200:],
        "stderrTail": list(stderr_buf)[-200:],
    }
