"""ZIP-Entpacken, PDF-Textextraktion und OCR-Fallback für gescannte Seiten."""
from __future__ import annotations

import io
import os
import shutil
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

import re

import pdfplumber

from .identifiers import repair_isins_in_text

MAX_FILES = 2000
MAX_PDF_BYTES = 200 * 1024 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
MIN_CHARS_PER_PAGE = 40  # darunter gilt eine Seite als Scan -> OCR


@dataclass
class PdfFile:
    name: str
    data: bytes


@dataclass
class PageText:
    number: int
    text: str
    ocr: bool


@dataclass
class ExtractedPdf:
    pages: list[PageText] = field(default_factory=list)
    ocr_fixes: list[tuple[str, str]] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "\n\n".join(f"[[Seite {p.number}]]\n{p.text}" for p in self.pages)

    @property
    def ocr_pages(self) -> int:
        return sum(1 for p in self.pages if p.ocr)


def read_upload(filename: str, data: bytes) -> list[PdfFile]:
    """Nimmt ein ZIP (auch verschachtelt) oder ein einzelnes PDF und liefert alle PDFs."""
    if data[:4] == b"%PDF" or filename.lower().endswith(".pdf"):
        return [PdfFile(Path(filename).name, data)]
    if not zipfile.is_zipfile(io.BytesIO(data)):
        raise ValueError(f"{filename}: neither ZIP nor PDF")
    return list(_walk_zip(data, prefix=""))


def _walk_zip(data: bytes, prefix: str, depth: int = 0):
    if depth > 3:
        return
    total = 0
    count = 0
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            path = PurePosixPath(info.filename.replace("\\", "/"))
            if path.name.startswith(".") or "__MACOSX" in path.parts:
                continue
            count += 1
            total += info.file_size
            if count > MAX_FILES or total > MAX_TOTAL_BYTES:
                raise ValueError("ZIP too large (file count or size limit exceeded)")
            if info.file_size > MAX_PDF_BYTES:
                continue
            name = prefix + "/".join(p for p in path.parts if p not in ("..", "/"))
            lower = path.name.lower()
            if lower.endswith(".pdf"):
                yield PdfFile(name, zf.read(info))
            elif lower.endswith(".zip"):
                yield from _walk_zip(zf.read(info), prefix=name + "/", depth=depth + 1)


def tesseract_cmd() -> str | None:
    env = os.environ.get("TESSERACT_CMD")
    if env and Path(env).exists():
        return env
    found = shutil.which("tesseract")
    if found:
        return found
    for cand in (
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        str(Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Tesseract-OCR" / "tesseract.exe"),
    ):
        if Path(cand).exists():
            return cand
    return None


def ocr_available() -> bool:
    return tesseract_cmd() is not None


def _ocr_page(page, lang: str) -> str:
    import pytesseract

    pytesseract.pytesseract.tesseract_cmd = tesseract_cmd()
    img = page.to_image(resolution=300).original
    return pytesseract.image_to_string(img, lang=lang)


CCY = "EUR|USD|CHF|GBP|JPY|SEK|NOK|DKK|AUD|CAD|SGD|HKD"


def ocr_cleanup(text: str) -> tuple[str, list[tuple[str, str]]]:
    """Korrigiert typische OCR-Verwechslungen in Klassen-Bezeichnungen und ISINs."""
    text = re.sub(r"\bClass[!|l1](?=\s|$)", "Class I", text)
    text = re.sub(r"\bClass\s+[!|l1](?=\s)", "Class I", text)
    text = re.sub(rf"\b(Class|Klasse)\s+([A-Z])({CCY})\b", r"\1 \2 \3", text)
    return repair_isins_in_text(text)


def extract_pdf(data: bytes, ocr: str = "auto", lang: str = "deu+eng") -> ExtractedPdf:
    """ocr: 'auto' (nur Seiten ohne Textlayer), 'always' oder 'never'."""
    out = ExtractedPdf()
    can_ocr = ocr != "never" and ocr_available()
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for i, page in enumerate(pdf.pages, start=1):
            text = page.extract_text(layout=False) or ""
            used_ocr = False
            if can_ocr and (ocr == "always" or len(text.strip()) < MIN_CHARS_PER_PAGE):
                try:
                    text, fixes = ocr_cleanup(_ocr_page(page, lang))
                    out.ocr_fixes.extend(fixes)
                    used_ocr = True
                except Exception as exc:  # OCR-Fehler sollen den Import nicht abbrechen
                    text = text + f"\n[OCR failed: {exc}]"
            out.pages.append(PageText(i, text, used_ocr))
    return out
