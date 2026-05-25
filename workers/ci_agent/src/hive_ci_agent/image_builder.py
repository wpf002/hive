"""Docker Image Builder — clone a repo, build (and optionally push) a Docker image."""
from __future__ import annotations
import asyncio
import os
import tempfile
import time
from typing import Any
from urllib.parse import urlparse, urlunparse

from hive_base import JobLogger
from .docker_utils import get_client


def _auth_url(repo_url: str, token: str | None) -> str:
    if not token:
        return repo_url
    parsed = urlparse(repo_url)
    if parsed.scheme != "https":
        return repo_url
    netloc = f"x-access-token:{token}@{parsed.hostname}"
    if parsed.port:
        netloc += f":{parsed.port}"
    return urlunparse(parsed._replace(netloc=netloc))


async def docker_image_builder(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
    repo_url = str(config.get("repoUrl") or "").strip()
    if not repo_url:
        raise ValueError("repoUrl is required")
    ref = str(config.get("ref") or "main")
    dockerfile = str(config.get("dockerfilePath") or "Dockerfile")
    build_context = str(config.get("buildContext") or ".")
    image_tag = str(config.get("imageTag") or "").strip()
    if not image_tag:
        raise ValueError("imageTag is required (e.g. 'myapp:phase4')")
    build_args = config.get("buildArgs") or {}
    if not isinstance(build_args, dict):
        raise ValueError("buildArgs must be an object")
    push_to = config.get("pushTo")
    registry_username = config.get("registryUsername")
    registry_password = config.get("registryPassword")
    token = config.get("githubToken")

    clone_url = _auth_url(repo_url, str(token) if token else None)

    client = get_client()
    workdir = tempfile.mkdtemp(prefix="hive-build-")
    try:
        await joblog.info("ci.clone", url=repo_url, ref=ref)
        proc = await asyncio.create_subprocess_exec(
            "git", "clone", "--depth", "1", "--branch", ref, clone_url, workdir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            # Retry without --branch ref so commit-SHA refs still work.
            for entry in os.listdir(workdir):
                full = os.path.join(workdir, entry)
                if os.path.isdir(full):
                    import shutil
                    shutil.rmtree(full, ignore_errors=True)
                else:
                    os.unlink(full)
            proc = await asyncio.create_subprocess_exec(
                "git", "clone", clone_url, workdir,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            _, err = await proc.communicate()
            if proc.returncode != 0:
                raise RuntimeError(f"git clone failed: {err.decode(errors='replace')[:500]}")
            proc = await asyncio.create_subprocess_exec(
                "git", "-C", workdir, "checkout", ref,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            _, err = await proc.communicate()
            if proc.returncode != 0:
                raise RuntimeError(f"git checkout {ref} failed: {err.decode(errors='replace')[:500]}")

        context_dir = os.path.join(workdir, build_context)
        if not os.path.isdir(context_dir):
            raise RuntimeError(f"buildContext '{build_context}' does not exist in repo")

        await joblog.info("ci.build", image=image_tag, dockerfile=dockerfile, context=build_context)
        t0 = time.time()

        def _build() -> tuple[Any, list[str]]:
            stream = client.api.build(
                path=context_dir,
                dockerfile=dockerfile,
                tag=image_tag,
                buildargs={str(k): str(v) for k, v in build_args.items()},
                rm=True,
                decode=True,
            )
            lines: list[str] = []
            image_id: str | None = None
            for chunk in stream:
                if "stream" in chunk:
                    line = str(chunk["stream"]).rstrip("\n")
                    if line:
                        lines.append(line)
                if "aux" in chunk and isinstance(chunk["aux"], dict):
                    image_id = chunk["aux"].get("ID") or image_id
                if "error" in chunk:
                    raise RuntimeError(str(chunk["error"]))
            if image_id is None:
                # Fallback — `images.get` after the fact.
                image_id = client.images.get(image_tag).id
            return image_id, lines

        image_id, build_lines = await asyncio.to_thread(_build)
        # Stream build output in chunks of 20 lines so the joblog isn't 5,000 rows.
        for i in range(0, len(build_lines), 20):
            await joblog.info("ci.build.lines", chunk=build_lines[i:i + 20])

        size_bytes = int((await asyncio.to_thread(lambda: client.images.get(image_tag).attrs)).get("Size", 0))
        duration_s = round(time.time() - t0, 3)

        pushed = False
        if push_to:
            registry = str(push_to)
            await joblog.info("ci.push", registry=registry, image=image_tag)
            auth_config = None
            if registry_username and registry_password:
                auth_config = {"username": str(registry_username), "password": str(registry_password)}
            # tag for the target registry
            full_tag = f"{registry.rstrip('/')}/{image_tag}" if "/" not in image_tag else image_tag
            img = await asyncio.to_thread(lambda: client.images.get(image_tag))
            await asyncio.to_thread(lambda: img.tag(full_tag.split(":")[0], tag=full_tag.split(":")[1] if ":" in full_tag else "latest"))
            push_stream = await asyncio.to_thread(
                lambda: client.images.push(full_tag, stream=True, decode=True, auth_config=auth_config)
            )
            for chunk in push_stream:
                if "error" in chunk:
                    raise RuntimeError(f"push failed: {chunk['error']}")
            pushed = True

        return {
            "imageId": image_id,
            "imageTag": image_tag,
            "sizeBytes": size_bytes,
            "buildDurationSeconds": duration_s,
            "pushed": pushed,
            **({"registry": str(push_to)} if push_to else {}),
        }
    finally:
        import shutil
        shutil.rmtree(workdir, ignore_errors=True)
