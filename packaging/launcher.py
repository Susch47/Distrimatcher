"""Einstiegspunkt für die gepackte .exe (setzt den Pfad zum mitgelieferten Tesseract)."""
import os
import sys
from pathlib import Path

base = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
bundled = base / "tesseract" / "tesseract.exe"
if bundled.exists():
    os.environ.setdefault("TESSERACT_CMD", str(bundled))
    os.environ.setdefault("TESSDATA_PREFIX", str(base / "tesseract" / "tessdata"))

from distrimatcher.__main__ import main  # noqa: E402

main()
