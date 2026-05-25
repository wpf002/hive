"""task_runner worker entry — runs TaskRunnerWorker forever."""
from __future__ import annotations
import asyncio
from hive_base import HiveWorker
from .python_script import python_script_runner
from .native_shell import shell_command_native
from .webhook_echo import webhook_receiver_echo


class TaskRunnerWorker(HiveWorker):
    pool_type = "task_runner"
    capacity = 16


    async def setup(self) -> None:
        self.register("Python Script Runner", python_script_runner)
        self.register("Shell Command Runner (Native)", shell_command_native)
        self.register("Generic Webhook Receiver Echo", webhook_receiver_echo)


def main() -> None:
    asyncio.run(TaskRunnerWorker().run())


if __name__ == "__main__":
    main()
