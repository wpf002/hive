"""SSRF-guard regression tests for the HTTP-endpoint monitor.

Locks in the guard added in the security pass: the monitor must refuse to
fetch URLs that resolve to private / loopback / link-local addresses (incl.
the 169.254.169.254 cloud-metadata endpoint) unless HIVE_MONITOR_ALLOW_INTERNAL
is explicitly set.

Stdlib `unittest` only — no pip install required. Run with the monitor venv
(which has httpx + hive_base), or any interpreter with those importable:

    workers/monitor/.venv/bin/python -m unittest discover -s workers/monitor/tests -v
"""
import os
import sys
import types
import unittest
from pathlib import Path

# Make the worker package importable when run from the repo root.
SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

# http_check does `from hive_base import JobLogger` at module top, which pulls
# in the whole hive_base package (and its native nacl dep). The SSRF guard
# functions don't use JobLogger at all, so stub the module to keep this test
# dependency-free — it only needs `httpx`, which the monitor venv has.
if "hive_base" not in sys.modules:
    stub = types.ModuleType("hive_base")
    stub.JobLogger = object  # type: ignore[attr-defined]
    sys.modules["hive_base"] = stub

# The guard reads HIVE_MONITOR_ALLOW_INTERNAL at import time — force it off
# before importing so the default (secure) path is under test.
os.environ["HIVE_MONITOR_ALLOW_INTERNAL"] = "false"

try:
    from hive_monitor.http_check import _assert_public_url, _is_public_ip
    IMPORT_OK = True
except Exception as e:  # httpx not installed in this interpreter
    IMPORT_OK = False
    IMPORT_ERR = e


@unittest.skipUnless(IMPORT_OK, "hive_monitor.http_check not importable (run with the monitor venv)")
class TestSsrfGuard(unittest.TestCase):
    def test_blocks_cloud_metadata_endpoint(self):
        with self.assertRaises(ValueError):
            _assert_public_url("http://169.254.169.254/latest/meta-data/")

    def test_blocks_loopback_and_private_and_localhost(self):
        for url in (
            "http://127.0.0.1:6379",
            "http://10.0.0.5/",
            "http://192.168.1.1/admin",
            "http://localhost/",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                _assert_public_url(url)

    def test_blocks_non_http_schemes(self):
        for url in ("file:///etc/passwd", "gopher://x/", "ftp://host/"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                _assert_public_url(url)

    def test_allows_public_host(self):
        # Should not raise for a normal public hostname.
        _assert_public_url("https://example.com/")

    def test_ip_classifier(self):
        self.assertFalse(_is_public_ip("169.254.169.254"))
        self.assertFalse(_is_public_ip("127.0.0.1"))
        self.assertFalse(_is_public_ip("10.1.2.3"))
        self.assertFalse(_is_public_ip("::1"))
        self.assertTrue(_is_public_ip("93.184.216.34"))  # example.com


if __name__ == "__main__":
    unittest.main()
