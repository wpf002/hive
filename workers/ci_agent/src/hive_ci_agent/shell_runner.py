"""Shell Command Runner — minimal `run this in a container` template."""
from __future__ import annotations
import asyncio
import time
from collections import deque
from typing import Any

from hive_base import JobLogger
from .docker_utils import get_client, stream_container_logs, tail_lines, quote_command

DEFAULT_IMAGE = "ubuntu:24.04"
DEFAULT_TIMEOUT_S = 300


async def shell_command_runner(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
    command = str(config.get("command") or "").strip()
    if not command:
        raise ValueError("command is required")
    image = str(config.get("dockerImage") or DEFAULT_IMAGE)
    timeout_s = int(config.get("timeoutSeconds", DEFAULT_TIMEOUT_S))
    env_vars = config.get("envVars") or {}
    if not isinstance(env_vars, dict):
        raise ValueError("envVars must be an object")
    working_dir = str(config.get("workingDir") or "/workspace")

    client = get_client()
    await joblog.info("ci.pulling_image", image=image)
    await asyncio.to_thread(lambda: client.images.pull(image))

    stdout_buf: deque[str] = deque(maxlen=2000)
    stderr_buf: deque[str] = deque(maxlen=2000)
    await joblog.info("ci.run", image=image, command=command, timeout=timeout_s, workdir=working_dir)

    t0 = time.time()
    container = await asyncio.to_thread(
        lambda: client.containers.run(
            image=image,
            command=quote_command(command),
            environment=env_vars,
            working_dir=working_dir,
            detach=True,
            tty=False,
            stdin_open=False,
            auto_remove=False,
        )
    )
    streamer = asyncio.create_task(
        stream_container_logs(container, joblog, stdout_buf=stdout_buf, stderr_buf=stderr_buf)
    )

    try:
        result = await asyncio.wait_for(
            asyncio.to_thread(lambda: container.wait(timeout=timeout_s)),
            timeout=timeout_s + 10,
        )
        exit_code = int(result.get("StatusCode", -1))
    except asyncio.TimeoutError:
        await joblog.error("ci.timeout", timeout=timeout_s)
        try:
            await asyncio.to_thread(container.kill)
        except Exception:
            pass
        exit_code = -1
    finally:
        try:
            await asyncio.wait_for(streamer, timeout=5.0)
        except asyncio.TimeoutError:
            streamer.cancel()
        try:
            await asyncio.to_thread(container.remove, force=True)
        except Exception:
            pass

    return {
        "exitCode": exit_code,
        "durationSeconds": round(time.time() - t0, 3),
        "stdoutTail": tail_lines(stdout_buf, 50),
        "stderrTail": tail_lines(stderr_buf, 50),
    }
