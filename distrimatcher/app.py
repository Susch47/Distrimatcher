"""FastAPI-Backend. Läuft ausschließlich auf 127.0.0.1 – die Oberfläche ist eine lokale Webseite."""
from __future__ import annotations

import csv
import hashlib
import io
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__
from .db import DB, data_dir
from .delta import build_overview, coverage_only_overview
from .extract import extract_document
from .ingest import extract_pdf, ocr_available, read_upload, tesseract_cmd
from .universe import (
    gleif_load_funds, import_table, online_enabled, openfigi_enrich, sec_dataset_path, sec_load_entity,
    sec_search_entities,
)

STATIC = Path(__file__).parent / "static"
MAX_UPLOAD = 2 * 1024 * 1024 * 1024

app = FastAPI(title="Distrimatcher", version=__version__)
db = DB()
pool = ThreadPoolExecutor(max_workers=2)
cache_dir = data_dir() / "cache"
pdf_dir = data_dir() / "documents"
pdf_dir.mkdir(parents=True, exist_ok=True)


def _pdf_path(sha: str) -> Path:
    return pdf_dir / f"{sha}.pdf"


def process(doc_id: int, data: bytes, ocr_mode: str) -> None:
    try:
        db.update_document(doc_id, status="processing")
        px = extract_pdf(data, ocr=ocr_mode)
        ex = extract_document(px.text, data, {p.number for p in px.pages if p.ocr})
        if px.ocr_fixes:
            ex.warnings.append(f"OCR-Korrektur (Prüfziffer bestätigt): {', '.join(f'{a}→{b}' for a, b in px.ocr_fixes)}")
        if px.ocr_pages and not ocr_available():
            ex.warnings.append("Gescannte Seiten erkannt, aber Tesseract-OCR ist nicht installiert.")
        if not px.text.strip() or all(len(p.text.strip()) < 40 for p in px.pages):
            ex.warnings.append("Kaum Text gefunden – evtl. Scan ohne OCR.")
        db.update_document(doc_id, status="done", pages=len(px.pages), ocr_pages=px.ocr_pages,
                           ocr_fixes=px.ocr_fixes, text=px.text, extraction=ex.to_dict(), error=None)
    except Exception as exc:
        db.update_document(doc_id, status="error", error=f"{type(exc).__name__}: {exc}")


# ------------------------------------------------------------------ Status
@app.get("/api/status")
def status():
    return {
        "version": __version__,
        "ocr": ocr_available(),
        "tesseract": tesseract_cmd(),
        "online": online_enabled(),
        "data_dir": str(data_dir()),
    }


# ------------------------------------------------------------------ Teil 1: Upload & Extraktion
@app.post("/api/upload")
async def upload(files: list[UploadFile] = File(...), ocr: str = "auto"):
    if ocr not in ("auto", "always", "never"):
        raise HTTPException(400, "ocr muss auto|always|never sein")
    result = []
    for f in files:
        data = await f.read()
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, f"{f.filename}: Datei zu groß")
        try:
            pdfs = read_upload(f.filename or "upload", data)
        except Exception as exc:
            result.append({"filename": f.filename, "error": str(exc)})
            continue
        for pdf in pdfs:
            sha = hashlib.sha256(pdf.data).hexdigest()
            doc_id, new = db.add_document(pdf.name, sha)
            if new:
                _pdf_path(sha).write_bytes(pdf.data)
                pool.submit(process, doc_id, pdf.data, ocr)
            result.append({"id": doc_id, "filename": pdf.name, "duplicate": not new})
    return {"documents": result}


@app.get("/api/documents")
def documents():
    out = []
    for d in db.documents():
        ex = d.get("extraction") or {}
        out.append({
            "id": d["id"], "filename": d["filename"], "status": d["status"], "error": d["error"],
            "pages": d["pages"], "ocr_pages": d["ocr_pages"], "uploaded_at": d["uploaded_at"], "edited": d["edited"],
            "document_type": ex.get("document_type"), "agreement_date": ex.get("agreement_date"),
            "fund_entity": ex.get("fund_entity"), "distributor": ex.get("distributor"),
            "funds": len(ex.get("funds", [])),
            "classes": sum(len(f.get("share_classes", [])) for f in ex.get("funds", [])),
            "isins": len(ex.get("isins", [])), "warnings": len(ex.get("warnings", [])),
        })
    return out


@app.get("/api/documents/{doc_id}")
def document(doc_id: int):
    d = db.document(doc_id)
    if not d:
        raise HTTPException(404)
    return d


@app.put("/api/documents/{doc_id}/extraction")
def save_extraction(doc_id: int, extraction: dict = Body(...)):
    if not db.document(doc_id):
        raise HTTPException(404)
    db.update_document(doc_id, extraction=extraction, edited=1)
    return {"ok": True}


@app.post("/api/documents/{doc_id}/reprocess")
def reprocess(doc_id: int, ocr: str = "auto"):
    d = db.document(doc_id)
    if not d or not _pdf_path(d["sha256"]).exists():
        raise HTTPException(404, "Original-PDF nicht gefunden")
    db.update_document(doc_id, status="queued", edited=0)
    pool.submit(process, doc_id, _pdf_path(d["sha256"]).read_bytes(), ocr)
    return {"ok": True}


@app.get("/api/documents/{doc_id}/pdf")
def document_pdf(doc_id: int):
    d = db.document(doc_id)
    if not d or not _pdf_path(d["sha256"]).exists():
        raise HTTPException(404)
    return FileResponse(_pdf_path(d["sha256"]), media_type="application/pdf",
                        headers={"Content-Disposition": f'inline; filename="{Path(d["filename"]).name}"'})


@app.delete("/api/documents/{doc_id}")
def delete_document(doc_id: int):
    d = db.document(doc_id)
    if d:
        _pdf_path(d["sha256"]).unlink(missing_ok=True)
    db.delete_document(doc_id)
    return {"ok": True}


@app.get("/api/coverage")
def coverage():
    return coverage_only_overview([d for d in db.documents(with_text=False) if d["status"] == "done"])


# ------------------------------------------------------------------ Teil 2: Universum
@app.get("/api/universe")
def universe_summary():
    return db.universe_summary()


@app.delete("/api/universe")
def universe_delete(source: str | None = None, umbrella: str | None = None):
    db.delete_universe(source, umbrella)
    return {"ok": True}


@app.get("/api/universe/sec/search")
def sec_search(q: str):
    try:
        path = sec_dataset_path(cache_dir)
    except Exception as exc:
        raise HTTPException(502, f"SEC-Daten nicht verfügbar: {exc}")
    return {"dataset": path.name, "results": sec_search_entities(path, q)}


@app.post("/api/universe/sec")
def sec_load(payload: dict = Body(...)):
    ciks = payload.get("ciks") or ([payload["cik"]] if payload.get("cik") else [])
    if not ciks:
        raise HTTPException(400, "cik(s) fehlt")
    path = sec_dataset_path(cache_dir)
    added = 0
    for cik in ciks:
        added += db.add_universe([r.to_dict() for r in sec_load_entity(path, str(cik))])
    return {"added": added, "dataset": path.name}


@app.get("/api/universe/sec/suggest")
def sec_suggest():
    """Schlägt anhand der Vertragsparteien passende SEC-Registranten vor."""
    path = sec_dataset_path(cache_dir)
    names: list[tuple[str, float]] = []
    for d in db.documents():
        ex = d.get("extraction") or {}
        cands = [(n, 0.8) for n in [ex.get("fund_entity")] + [f.get("umbrella") for f in ex.get("funds", [])]]
        cands += [(f.get("name"), 0.95) for f in ex.get("funds", [])[:2]]  # Registrant über Fund-Namen finden
        for n, min_score in cands:
            for part in (n or "").split(", "):
                if part and part not in [x for x, _ in names]:
                    names.append((part, min_score))
    out, seen = [], set()
    for n, min_score in names[:40]:
        hits = [h for h in sec_search_entities(path, n, limit=3) if h["score"] >= min_score and h["cik"] not in seen]
        seen.update(h["cik"] for h in hits)
        if hits:
            out.append({"query": n, "results": hits})
    return out


@app.post("/api/universe/gleif")
def gleif_load(payload: dict = Body(default={})):
    names = payload.get("fund_names")
    if not names:
        names = [f["fund_name"] for f in coverage()]
    try:
        records, report = gleif_load_funds(names[:200], payload.get("umbrella"))
    except Exception as exc:
        raise HTTPException(502, f"GLEIF nicht erreichbar: {exc}")
    added = db.add_universe([r.to_dict() for r in records])
    return {"added": added, "report": report}


@app.post("/api/universe/import")
async def universe_import(file: UploadFile = File(...), source: str = "Import"):
    data = await file.read()
    records, warnings = import_table(file.filename or "import.csv", data, source=source or "Import")
    added = db.add_universe([r.to_dict() for r in records])
    return {"added": added, "rows": len(records), "warnings": warnings}


@app.post("/api/openfigi")
def openfigi(payload: dict = Body(...)):
    isins = payload.get("isins") or []
    try:
        return openfigi_enrich(isins[:500])
    except Exception as exc:
        raise HTTPException(502, f"OpenFIGI nicht erreichbar: {exc}")


@app.get("/api/overview")
def overview():
    docs = [d for d in db.documents(with_text=True) if d["status"] == "done"]
    return build_overview(db.universe(), docs)


# ------------------------------------------------------------------ Exporte (CSV, Excel-freundlich)
def _csv(rows: list[list], header: list[str], name: str) -> Response:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(header)
    w.writerows(rows)
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/api/export/overview.csv")
def export_overview(only_delta: bool = False):
    ov = overview()
    rows = []
    for u in ov["umbrellas"]:
        for f in u["funds"]:
            for c in f["classes"]:
                if only_delta and c["status"] == "abgedeckt":
                    continue
                rows.append([u["name"], f["fund_id"], f["fund_name"], c["class_id"], c["class_name"], c["isin"], c["ticker"],
                             c["currency"], c["status"], c["via"], ", ".join(c["documents"]), ", ".join(f["sources"])])
    header = ["Umbrella", "Fund-ID", "Fund", "Class-ID", "Share Class", "ISIN", "Ticker", "Währung", "Status", "Abgleich über",
              "Agreements", "Datenquelle"]
    return _csv(rows, header, "distrimatcher_delta.csv" if only_delta else "distrimatcher_uebersicht.csv")


@app.get("/api/export/extraction.csv")
def export_extraction():
    rows = []
    for d in db.documents():
        ex = d.get("extraction") or {}
        base = [d["filename"], ex.get("document_type"), ex.get("agreement_date"), ex.get("fund_entity"), ex.get("distributor"),
                ex.get("management_company"), ex.get("governing_law"), ", ".join(ex.get("territory") or []),
                ex.get("termination_notice"), ex.get("exclusivity")]
        for f in ex.get("funds", []) or [{"name": None, "share_classes": []}]:
            for sc in f.get("share_classes") or [{}]:
                rows.append(base + [f.get("umbrella"), f.get("name"), "ja" if f.get("all_classes") else "", sc.get("name"),
                                    sc.get("isin"), sc.get("fee")])
    header = ["Dokument", "Typ", "Datum", "Fondsgesellschaft", "Distributor", "Verwaltungsgesellschaft", "Recht", "Territorium",
              "Kündigungsfrist", "Exklusivität", "Umbrella", "Fund", "Alle Klassen", "Share Class", "ISIN", "Gebühr"]
    return _csv(rows, header, "distrimatcher_extraktion.csv")


@app.get("/api/export/extraction.json")
def export_json():
    return JSONResponse([{k: v for k, v in d.items() if k != "text"} for d in db.documents()])


# ------------------------------------------------------------------ Frontend
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")
