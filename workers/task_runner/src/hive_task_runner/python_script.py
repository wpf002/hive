"""Python Script Runner — write code to a temp file, optionally make a venv,
run with a timeout. Stream stdout/stderr to joblog and return tail.

Memory caps via resource.setrlimit are Linux-only — on macOS they're a no-op.
We document the limitation in /docs/POOLS.md.
"""
from __future__ import annotations
import asyncio
import os
import platform
import resource
import shutil
import sys
import tempfile
from collections import deque
from typing import Any

from hive_base import JobLogger


DEFAULT_TIMEOUT_S = 60
MAX_TIMEOUT_S = 600
MAX_MEMORY_BYTES = 1024 * 1024 * 1024  # 1 GiB


def _set_limits() -> None:
    if platform.system() == "Linux":
        try:
            resource.setrlimit(resource.RLIMIT_AS, (MAX_MEMORY_BYTES, MAX_MEMORY_BYTES))
        except (ValueError, OSError):
            pass


async def _stream(stream: asyncio.StreamReader, buf: deque[str], joblog: JobLogger, event: str) -> None:
    while True:
        line = await stream.readline()
        if not line:
            return
        try:
            text = line.decode("utf-8", errors="replace").rstrip("\n")
        except Exception:
            text = repr(line)
        buf.append(text)
        if event.endswith("stderr"):
            await joblog.warn(event, line=text)
        else:
            await joblog.info(event, line=text)


def _resolve_python(version: str) -> str:
    """Find a python interpreter for the requested version.
    Falls back to sys.executable if the explicit version isn't on PATH."""
    candidates = [f"python{version}", "python3", "python"]
    for cand in candidates:
        path = shutil.which(cand)
        if path:
            return path
    return sys.executable


async def python_script_runner(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
    code = config.get("code")
    if not isinstance(code, str) or not code.strip():
        raise ValueError("code is required (Python source as a string)")
    timeout_s = min(MAX_TIMEOUT_S, int(config.get("timeoutSeconds", DEFAULT_TIMEOUT_S)))
    python_version = str(config.get("pythonVersion") or "3.11")
    pip_packages = config.get("pipPackages") or []
    if not isinstance(pip_packages, list):
        raise ValueError("pipPackages must be an array of strings")
    stdin = config.get("stdin")
    env_vars = config.get("envVars") or {}
    if not isinstance(env_vars, dict):
        raise ValueError("envVars must be an object")

    workdir = tempfile.mkdtemp(prefix="hive-pyrun-")
    try:
        script_path = os.path.join(workdir, "script.py")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(code)

        python_bin = _resolve_python(python_version)

        if pip_packages:
            venv_path = os.path.join(workdir, ".venv")
            await joblog.info("py.venv.create", path=venv_path, python=python_bin)
            create = await asyncio.create_subprocess_exec(
                python_bin, "-m", "venv", venv_path,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, err = await create.communicate()
            if create.returncode != 0:
                raise RuntimeError(f"venv creation failed: {err.decode(errors='replace')[:500]}")
            python_bin = os.path.join(venv_path, "bin", "python")
            await joblog.info("py.pip.install", packages=pip_packages)
            pip = await asyncio.create_subprocess_exec(
                python_bin, "-m", "pip", "install", "--quiet", *[str(p) for p in pip_packages],
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            out, err = await pip.communicate()
            if pip.returncode != 0:
                raise RuntimeError(
                    f"pip install failed ({pip.returncode}): {err.decode(errors='replace')[:500]}"
                )

        await joblog.info("py.script.start", timeout=timeout_s)
        env = {**os.environ, **{str(k): str(v) for k, v in env_vars.items()}}

        proc = await asyncio.create_subprocess_exec(
            python_bin, script_path,
            stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=workdir,
            preexec_fn=_set_limits if platform.system() != "Windows" else None,
        )

        stdout_buf: deque[str] = deque(maxlen=2000)
        stderr_buf: deque[str] = deque(maxlen=2000)

        readers = [
            asyncio.create_task(_stream(proc.stdout, stdout_buf, joblog, "py.stdout")),  # type: ignore[arg-type]
            asyncio.create_task(_stream(proc.stderr, stderr_buf, joblog, "py.stderr")),  # type: ignore[arg-type]
        ]

        if stdin is not None and proc.stdin:
            try:
                proc.stdin.write(str(stdin).encode("utf-8"))
                await proc.stdin.drain()
                proc.stdin.close()
            except Exception:
                pass

        import time
        t0 = time.time()
        try:
            exit_code = await asyncio.wait_for(proc.wait(), timeout=timeout_s)
        except asyncio.TimeoutError:
            await joblog.error("py.timeout", timeout=timeout_s)
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
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
