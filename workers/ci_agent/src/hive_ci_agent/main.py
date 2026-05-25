"""ci_agent worker entry — runs CiAgentWorker forever."""
from __future__ import annotations
import asyncio
from hive_base import HiveWorker
from .test_runner import github_repo_test_runner
from .image_builder import docker_image_builder
from .shell_runner import shell_command_runner


class CiAgentWorker(HiveWorker):
    pool_type = "ci_agent"
    capacity = 2  # container builds are heavy


    async def setup(self) -> None:
        self.register("GitHub Repo Test Runner", github_repo_test_runner)
        self.register("Docker Image Builder", docker_image_builder)
        self.register("Shell Command Runner", shell_command_runner)


def main() -> None:
    asyncio.run(CiAgentWorker().run())


if __name__ == "__main__":
    main()
