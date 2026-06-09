"""Startup checks for the rpa_desktop pool.

The worker should fail LOUDLY at startup if its OS prerequisites aren't met
rather than during the first job, because the singleton constraint means
nothing else is sharing the pool to surface the problem first.
"""
from __future__ import annotations
import platform
import shutil


def check_tesseract() -> None:
    """`tesseract` is only needed by the OCR Field Reader template — it is NOT
    required for Screen Region Capture or Window Macro Player. So we warn rather
    than refuse to boot; the OCR template still fails clearly at job time if the
    binary is missing. (Install: `brew install tesseract` / `apt-get install -y
    tesseract-ocr`.)"""
    if not shutil.which("tesseract"):
        print(
            "[rpa_desktop] WARNING: tesseract not on PATH — OCR Field Reader jobs "
            "will fail, but Screen Capture and Macro Player work fine.",
            flush=True,
        )


def check_accessibility() -> None:
    """On macOS, pyautogui needs Accessibility permission for the terminal /
    process that's running the worker. Without it, mouse/keyboard calls
    silently no-op or raise opaquely later."""
    if platform.system() != "Darwin":
        return
    # We can't probe permission directly without third-party deps; instead we
    # try to import pyautogui and read the screen size, which raises if the
    # required AX permissions are missing.
    try:
        import pyautogui  # type: ignore[import-untyped]
        _ = pyautogui.size()
    except Exception as e:
        raise RuntimeError(
            "macOS Accessibility permission required for the rpa_desktop worker.\n"
            "  System Settings → Privacy & Security → Accessibility\n"
            "  → enable the terminal app you launch mprocs from (Terminal.app / iTerm).\n"
            f"Underlying error: {e}"
        ) from e
