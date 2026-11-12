"""Einstiegspunkt für die gepackte .exe (setzt den Pfad zum mitgelieferten Tesseract)."""
import os
import sys
from pathlib import Path

base = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
bundled = base / "tesseract" / "tesseract.exe"
if bundled.exists():
    os.environ.setdefault("TESSERACT_CMD", str(bundled))
    os.environ.setdefault("TESSDATA_PREFIX", str(base / "tesseract" / "tessdata"))

# Fensteranwendung ohne Konsole: Ausgaben und Fehler in eine Logdatei schreiben
from distrimatcher.db import data_dir  # noqa: E402

log = open(data_dir() / "distrimatcher.log", "a", encoding="utf-8", buffering=1)
if sys.stdout is None or not sys.stdout.isatty():
    sys.stdout = sys.stderr = log

from distrimatcher.__main__ import main  # noqa: E402

try:
    main()
except Exception:
    import traceback

    traceback.print_exc(file=log)
    raise
