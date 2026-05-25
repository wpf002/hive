"""GitHub Repo Test Runner — clone a repo inside a container, run a test command."""
from __future__ import annotations
import asyncio
import time
from collections import deque
from typing import Any
from urllib.parse import urlparse, urlunparse

from hive_base import JobLogger
from .docker_utils import get_client, stream_container_logs, tail_lines, quote_command

DEFAULT_TIMEOUT_S = 600
DEFAULT_IMAGE = "node:20"


def _auth_url(repo_url: str, token: str | None) -> str:
    """Inject a GitHub token into the clone URL when given. We only support https."""
    if not token:
        return repo_url
    parsed = urlparse(repo_url)
    if parsed.scheme != "https":
        return repo_url
    netloc = f"x-access-token:{token}@{parsed.hostname}"
    if parsed.port:
        netloc += f":{parsed.port}"
    return urlunparse(parsed._replace(netloc=netloc))


async def github_repo_test_runner(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
    repo_url = str(config.get("repoUrl") or "").strip()
    if not repo_url:
        raise ValueError("repoUrl is required")
    ref = str(config.get("ref") or "main")
    test_command = str(config.get("testCommand") or "").strip()
    if not test_command:
        raise ValueError("testCommand is required")
    image = str(config.get("dockerImage") or DEFAULT_IMAGE)
    timeout_s = int(config.get("timeoutSeconds", DEFAULT_TIMEOUT_S))
    env_vars = config.get("envVars") or {}
    if not isinstance(env_vars, dict):
        raise ValueError("envVars must be an object")
    token = config.get("githubToken")

    clone_url = _auth_url(repo_url, str(token) if token else None)
    # Pull, clone, exec test command, capture exit code. All inside one container.
    workdir = "/workspace/repo"
    pipeline = (
        f"set -e && "
        f"apk add --no-cache git 2>/dev/null || apt-get update >/dev/null && apt-get install -y git >/dev/null || true; "
        f"git clone --depth 1 --branch {ref} {clone_url} {workdir} || git clone {clone_url} {workdir} && (cd {workdir} && git checkout {ref}) ; "
        f"cd {workdir} && {test_command}"
    )

    client = get_client()
    await joblog.info("ci.pulling_image", image=image)
    await asyncio.to_thread(lambda: client.images.pull(image))

    stdout_buf: deque[str] = deque(maxlen=2000)
    stderr_buf: deque[str] = deque(maxlen=2000)

    await joblog.info("ci.run", image=image, ref=ref, command=test_command, timeout=timeout_s)
    t0 = time.time()
    container = await asyncio.to_thread(
        lambda: client.containers.run(
            image=image,
            command=quote_command(pipeline),
            environment=env_vars,
            detach=True,
            tty=False,
            stdin_open=False,
            auto_remove=False,
            working_dir="/workspace",
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
        # Wait briefly for the log streamer to drain.
        try:
            await asyncio.wait_for(streamer, timeout=5.0)
        except asyncio.TimeoutError:
            streamer.cancel()
        try:
            await asyncio.to_thread(container.remove, force=True)
        except Exception:
            pass

    duration_s = round(time.time() - t0, 3)
    sanitized_command = test_command  # the token-injected URL is in `pipeline`, not what we return
    return {
        "exitCode": exit_code,
        "durationSeconds": duration_s,
        "command": sanitized_command,
        "image": image,
        "ref": ref,
        "stdoutTail": tail_lines(stdout_buf, 50),
        "stderrTail": tail_lines(stderr_buf, 50),
    }
