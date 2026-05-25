"""OCR Field Reader — screenshot a region, optionally preprocess, run OCR, optionally regex-match."""
from __future__ import annotations
import asyncio
import io
import re
import time
from typing import Any

import pyautogui  # type: ignore[import-untyped]
from hive_base import JobLogger


def _capture_region(x: int, y: int, w: int, h: int) -> bytes:
    img = pyautogui.screenshot(region=(x, y, w, h))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _preprocess(png: bytes, mode: str) -> bytes:
    from PIL import Image, ImageOps  # type: ignore[import-untyped]
    img = Image.open(io.BytesIO(png))
    if mode == "grayscale":
        img = ImageOps.grayscale(img)
    elif mode == "threshold":
        img = ImageOps.grayscale(img).point(lambda p: 255 if p > 160 else 0)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _ocr(png: bytes) -> str:
    import pytesseract  # type: ignore[import-untyped]
    from PIL import Image  # type: ignore[import-untyped]
    return pytesseract.image_to_string(Image.open(io.BytesIO(png)))


async def ocr_field_reader(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
    region = config.get("region")
    if not isinstance(region, dict):
        raise ValueError("region {x,y,width,height} is required")
    x, y, w, h = int(region["x"]), int(region["y"]), int(region["width"]), int(region["height"])
    preprocess = str(config.get("preProcess", "none")).lower()
    if preprocess not in {"none", "grayscale", "threshold"}:
        raise ValueError("preProcess must be one of: none, grayscale, threshold")
    expected_pattern = config.get("expectedPattern")

    t0 = time.time()
    png = await asyncio.to_thread(_capture_region, x, y, w, h)
    if preprocess != "none":
        png = await asyncio.to_thread(_preprocess, png, preprocess)
    text = await asyncio.to_thread(_ocr, png)
    duration_ms = int((time.time() - t0) * 1000)

    matched: bool | None = None
    if isinstance(expected_pattern, str) and expected_pattern:
        try:
            matched = bool(re.search(expected_pattern, text))
        except re.error as e:
            await joblog.warn("ocr.bad_regex", pattern=expected_pattern, error=str(e))
            matched = False

    await joblog.info("ocr.read", chars=len(text), matched=matched, durationMs=duration_ms)
    return {
        "ocrText": text,
        "region": {"x": x, "y": y, "width": w, "height": h},
        **({"matched": matched} if matched is not None else {}),
        "durationMs": duration_ms,
    }
