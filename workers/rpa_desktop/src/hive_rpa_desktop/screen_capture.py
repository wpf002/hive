"""Screen Region Capture — optional crop, optional OCR."""
from __future__ import annotations
import asyncio
import io
from typing import Any, Optional

import pyautogui  # type: ignore[import-untyped]
from hive_base import JobLogger
from .artifacts import upload_artifact


def _crop_region(config: dict[str, Any]) -> Optional[tuple[int, int, int, int]]:
    region = config.get("region")
    if not region:
        return None
    if not isinstance(region, dict):
        raise ValueError("region must be {x, y, width, height}")
    return (int(region["x"]), int(region["y"]), int(region["width"]), int(region["height"]))


def _capture(region: Optional[tuple[int, int, int, int]]) -> bytes:
    img = pyautogui.screenshot(region=region) if region else pyautogui.screenshot()
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _ocr(png_bytes: bytes) -> str:
    import pytesseract  # type: ignore[import-untyped]
    from PIL import Image  # type: ignore[import-untyped]
    img = Image.open(io.BytesIO(png_bytes))
    return pytesseract.image_to_string(img)


async def screen_region_capture(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
    region = _crop_region(config)
    filename = str(config.get("filename") or "capture.png")
    ocr = bool(config.get("ocr", False))

    await joblog.info("rpa.capture", region=list(region) if region else "full", ocr=ocr)
    png = await asyncio.to_thread(_capture, region)

    art_id = await upload_artifact(
        job_id=joblog.job_id, filename=filename, body=png, content_type="image/png"
    )
    ocr_text: Optional[str] = None
    if ocr:
        ocr_text = await asyncio.to_thread(_ocr, png)
        await joblog.info("rpa.ocr.done", chars=len(ocr_text))

    # Dimensions for diagnostics.
    from PIL import Image  # type: ignore[import-untyped]
    img = Image.open(io.BytesIO(png))
    return {
        "artifactId": art_id,
        "region": {"x": region[0], "y": region[1], "width": region[2], "height": region[3]} if region else None,
        "ocrText": ocr_text,
        "dimensions": {"width": img.size[0], "height": img.size[1]},
    }
