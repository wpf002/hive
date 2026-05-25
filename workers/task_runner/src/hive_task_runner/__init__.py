"""hive_task_runner — generic ad-hoc Python / shell / webhook tasks.

The pool name dates back to the arq-based spike; this implementation does not
use arq. Tasks run as subprocesses with timeouts on the host.
"""
__version__ = "0.1.0"
