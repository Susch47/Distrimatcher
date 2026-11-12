"""FastAPI backend. Listens on 127.0.0.1 only – the UI is a local web page."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import shutil
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__
from .db import DB, data_dir
from .delta import build_overview, coverage_only_overview, name_score
from .extract import extract_document
from .ingest import extract_pdf, ocr_available, read_upload, tesseract_cmd
from .universe import (
    class_features, gleif_load_funds, import_table, online_enabled, openfigi_enrich, sec_dataset_path, sec_load_entity,
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
            ex.warnings.append(f"OCR correction (check digit verified): {', '.join(f'{a}→{b}' for a, b in px.ocr_fixes)}")
        if px.ocr_pages and not ocr_available():
            ex.warnings.append("Scanned pages detected, but Tesseract OCR is not installed.")
        if not px.text.strip() or all(len(p.text.strip()) < 40 for p in px.pages):
            ex.warnings.append("Hardly any text found – possibly a scan without OCR.")
        db.update_document(doc_id, status="done", pages=len(px.pages), ocr_pages=px.ocr_pages,
                           ocr_fixes=px.ocr_fixes, text=px.text, extraction=ex.to_dict(), error=None)
        n_cls = sum(len(f.share_classes) for f in ex.funds)
        name = (db.document(doc_id) or {}).get("filename", doc_id)
        db.log("extraction", f"{name}: {len(ex.funds)} funds, {n_cls} share classes"
                             + (f", {px.ocr_pages} page(s) via OCR" if px.ocr_pages else ""))
    except Exception as exc:
        db.update_document(doc_id, status="error", error=f"{type(exc).__name__}: {exc}")
        db.log("error", f"Document {doc_id}: {type(exc).__name__}: {exc}")


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
        raise HTTPException(400, "ocr must be auto|always|never")
    result = []
    for f in files:
        data = await f.read()
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, f"{f.filename}: file too large")
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
    new_docs = sum(1 for r in result if r.get("id") and not r.get("duplicate"))
    db.log("upload", f"Uploaded {', '.join(f.filename or '?' for f in files)}: {new_docs} new PDF(s)"
                     + (f", {len(result) - new_docs} duplicate/skipped" if len(result) > new_docs else ""))
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
    db.log("edit", f"Extraction of document {doc_id} edited manually")
    return {"ok": True}


@app.post("/api/documents/{doc_id}/reprocess")
def reprocess(doc_id: int, ocr: str = "auto"):
    d = db.document(doc_id)
    if not d or not _pdf_path(d["sha256"]).exists():
        raise HTTPException(404, "Original PDF not found")
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
        db.log("delete", f"Deleted {d['filename']}")
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
    db.log("universe", f"Removed public data: {source or 'all sources'}{' / ' + umbrella if umbrella else ''}")
    return {"ok": True}


@app.get("/api/universe/sec/search")
def sec_search(q: str):
    try:
        path = sec_dataset_path(cache_dir)
    except Exception as exc:
        raise HTTPException(502, f"SEC data not available: {exc}")
    return {"dataset": path.name, "results": sec_search_entities(path, q)}


@app.post("/api/universe/sec")
def sec_load(payload: dict = Body(...)):
    ciks = payload.get("ciks") or ([payload["cik"]] if payload.get("cik") else [])
    if not ciks:
        raise HTTPException(400, "cik(s) missing")
    path = sec_dataset_path(cache_dir)
    added = 0
    for cik in ciks:
        recs = sec_load_entity(path, str(cik))
        added += db.add_universe([r.to_dict() for r in recs])
        db.log("universe", f"SEC: loaded {recs[0].umbrella if recs else cik} ({len(recs)} share classes)")
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
        raise HTTPException(502, f"GLEIF not reachable: {exc}")
    added = db.add_universe([r.to_dict() for r in records])
    db.log("universe", f"GLEIF: LEI found for {sum(1 for r in report if r.get('lei'))}/{len(report)} funds, {added} new records")
    return {"added": added, "report": report}


@app.post("/api/universe/import")
async def universe_import(file: UploadFile = File(...), source: str = "Import"):
    data = await file.read()
    records, warnings = import_table(file.filename or "import.csv", data, source=source or "Import")
    added = db.add_universe([r.to_dict() for r in records])
    db.log("universe", f"Imported {file.filename}: {len(records)} rows, {added} new")
    return {"added": added, "rows": len(records), "warnings": warnings}


@app.post("/api/openfigi")
def openfigi(payload: dict = Body(...)):
    isins = payload.get("isins") or []
    try:
        return openfigi_enrich(isins[:500])
    except Exception as exc:
        raise HTTPException(502, f"OpenFIGI not reachable: {exc}")


def _manual() -> dict[str, dict]:
    names = {d["id"]: d["filename"] for d in db.documents()}
    return {k: {"doc_id": w["doc_id"], "doc_name": names.get(w["doc_id"])}
            for k, w in db.watch_states().items() if w["status"] == "added"}


@app.get("/api/overview")
def overview():
    docs = [d for d in db.documents(with_text=True) if d["status"] == "done"]
    return build_overview(db.universe(), docs, _manual())


# ------------------------------------------------------------------ Watchlist
WATCH_STATUSES = {"open", "confirmed", "dismissed", "added"}


def _agreements_for(umbrella: str | None, docs: list[dict]) -> list[dict]:
    """Agreements whose fund entity / umbrella resembles the given umbrella name."""
    out = []
    for d in docs:
        ex = d.get("extraction") or {}
        names = [ex.get("fund_entity") or ""] + [f.get("umbrella") or "" for f in ex.get("funds", [])]
        names += [n for part in names for n in part.split(", ")]
        if umbrella and any(n and name_score(n, umbrella) >= 0.86 for n in names):
            out.append({"id": d["id"], "name": d["filename"]})
    return out


@app.get("/api/watchlist")
def watchlist():
    ov = overview()
    docs = [d for d in db.documents() if d["status"] == "done"]
    items = []
    for u in ov["umbrellas"]:
        related = None
        for f in u["funds"]:
            for c in f["classes"]:
                if c["status"] == "covered" and c["via"] != "added manually":
                    continue
                if related is None:
                    related = _agreements_for(u["name"], docs)
                agr = [{"id": i, "name": n} for i, n in zip(f["matched_agreement_ids"], f["matched_agreements"])] or related
                items.append({
                    "key": c["key"], "umbrella": u["name"], "fund_name": f["fund_name"], "fund_id": f["fund_id"],
                    "isin": c["isin"], "class_id": c["class_id"], "class_name": c["class_name"], "ticker": c["ticker"],
                    "currency": c["currency"], "gap_status": c["status"], "via": c["via"],
                    "features": class_features(c["class_name"], c["currency"], c["retro"]),
                    "retro": c["retro"], "retro_basis": c["retro_basis"], "pays_retro": c["pays_retro"],
                    "origin": c["origin"], "origin_url": c["origin_url"], "agreements": agr,
                })
    db.watch_seen([i["key"] for i in items])
    states = db.watch_states()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")
    for i in items:
        w = states.get(i["key"], {})
        i["status"] = w.get("status", "open")
        i["first_seen"] = w.get("first_seen")
        i["is_new"] = bool(w.get("first_seen") and w["first_seen"] >= cutoff and i["status"] == "open")
        i["agreement_id"] = w.get("doc_id")
    return items


@app.post("/api/watchlist/status")
def watch_status(payload: dict = Body(...)):
    keys = payload.get("keys") or ([payload["key"]] if payload.get("key") else [])
    status = payload.get("status")
    if status not in WATCH_STATUSES or not keys:
        raise HTTPException(400, "keys and a valid status (open|confirmed|dismissed|added) are required")
    doc_id = payload.get("doc_id")
    if status == "added" and not doc_id:
        raise HTTPException(400, "doc_id is required to add a share class to an agreement")
    for k in keys:
        db.watch_set(k, status, doc_id if status == "added" else None)
    doc = db.document(doc_id) if doc_id else None
    label = {"open": "re-opened", "confirmed": "confirmed as gap", "dismissed": "dismissed", "added": "added to agreement"}[status]
    db.log("watchlist", f"{len(keys)} item(s) {label}: {', '.join(keys[:5])}{' …' if len(keys) > 5 else ''}"
                        + (f" → {doc['filename']}" if doc else ""))
    return {"ok": True}


# ------------------------------------------------------------------ Provider e-mail
EMAIL_TEXT = {
    "en": {
        "subject": "Distribution agreement {provider} – share classes not covered",
        "greeting": "Dear Sir or Madam,",
        "intro": ("As part of our periodic review of the distribution agreement{s} with {provider}{refs}, we have identified "
                  "the following share classes that are available but are currently not covered by the agreement{s}:"),
        "retro_note": "Share classes marked with * pay retrocessions / trail commissions according to the available data.",
        "ask": ("Could you please confirm whether these share classes can be added to our agreement (e.g. by an amendment to "
                "the schedule of funds and share classes), including the applicable retrocession / trail commission terms? "
                "If individual share classes are not intended for distribution through us, a short note would be appreciated."),
        "closing": "Thank you in advance for your support.\n\nKind regards",
        "ref": " (agreement{s}: {list})",
        "line": "- {fund} | {cls} | ISIN {isin}",
    },
    "de": {
        "subject": "Vertriebsvereinbarung {provider} – nicht abgedeckte Anteilsklassen",
        "greeting": "Sehr geehrte Damen und Herren",
        "intro": ("Im Rahmen unserer periodischen Überprüfung der Vertriebsvereinbarung{s} mit {provider}{refs} haben wir "
                  "folgende Anteilsklassen identifiziert, die verfügbar, aber derzeit nicht von der Vereinbarung abgedeckt sind:"),
        "retro_note": "Mit * markierte Anteilsklassen zahlen gemäss den vorliegenden Daten Retrozessionen / Bestandespflegekommissionen.",
        "ask": ("Können Sie uns bitte bestätigen, ob diese Anteilsklassen in unsere Vereinbarung aufgenommen werden können "
                "(z. B. durch einen Nachtrag zum Anhang der Fonds und Anteilsklassen), inklusive der anwendbaren "
                "Retrozessions- bzw. Bestandespflegekonditionen? Falls einzelne Klassen nicht für den Vertrieb über uns "
                "vorgesehen sind, freuen wir uns über einen kurzen Hinweis."),
        "closing": "Besten Dank für Ihre Unterstützung.\n\nFreundliche Grüsse",
        "ref": " (Vereinbarung{s}: {list})",
        "line": "- {fund} | {cls} | ISIN {isin}",
    },
}


@app.get("/api/email/providers")
def email_providers():
    agg: dict[str, dict] = {}
    for i in watchlist():
        if i["status"] in ("dismissed", "added"):
            continue
        a = agg.setdefault(i["umbrella"], {"provider": i["umbrella"], "open": 0, "confirmed": 0, "retro": 0})
        a[i["status"]] = a.get(i["status"], 0) + 1
        a["retro"] += 1 if i["pays_retro"] else 0
    return sorted(agg.values(), key=lambda a: a["provider"])


@app.get("/api/email/draft")
def email_draft(provider: str, lang: str = "en", scope: str = "confirmed", retro_only: bool = False):
    t = EMAIL_TEXT.get(lang, EMAIL_TEXT["en"])
    items = [i for i in watchlist() if i["umbrella"] == provider and i["status"] not in ("dismissed", "added")]
    if scope == "confirmed":
        items = [i for i in items if i["status"] == "confirmed"]
    if retro_only:
        items = [i for i in items if i["pays_retro"]]
    items.sort(key=lambda i: (i["fund_name"] or "", i["class_name"] or ""))
    agreements = sorted({a["name"].split("/")[-1] for i in items for a in i["agreements"]})
    plural = "s" if len(agreements) > 1 else ""
    if lang == "de":
        plural = "en" if len(agreements) > 1 else ""
    refs = t["ref"].format(s=plural, list=", ".join(agreements)) if agreements else ""
    lines = [t["line"].format(fund=i["fund_name"], cls=(i["class_name"] or i["class_id"] or "–") + (" *" if i["pays_retro"] else ""),
                              isin=i["isin"] or i["class_id"] or "n/a") for i in items]
    pretty = re.sub(r"\s+", " ", provider.title() if provider.isupper() else provider)
    body = "\n\n".join([
        t["greeting"],
        t["intro"].format(s=plural, provider=pretty, refs=refs),
        "\n".join(lines) if lines else "(no share classes selected)",
        *([t["retro_note"]] if any(i["pays_retro"] for i in items) else []),
        t["ask"],
        t["closing"],
    ])
    return {"to": "", "subject": t["subject"].format(provider=pretty), "body": body, "count": len(items),
            "keys": [i["key"] for i in items]}


@app.post("/api/email/eml")
def email_eml(payload: dict = Body(...)):
    msg = EmailMessage()
    msg["To"] = payload.get("to", "")
    if payload.get("cc"):
        msg["Cc"] = payload["cc"]
    msg["Subject"] = payload.get("subject", "")
    msg["X-Unsent"] = "1"  # Outlook opens the file as an editable draft
    msg.set_content(payload.get("body", ""))
    db.log("email", f"E-mail draft created: {payload.get('subject', '')}")
    name = re.sub(r"[^A-Za-z0-9_-]+", "_", payload.get("subject", "email"))[:60] + ".eml"
    return Response(msg.as_bytes(), media_type="message/rfc822", headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ------------------------------------------------------------------ Manual (editable file)
MANUAL_DEFAULT = Path(__file__).parent / "manual.md"


def manual_path() -> Path:
    p = data_dir() / "manual.md"
    if not p.exists() and MANUAL_DEFAULT.exists():
        shutil.copyfile(MANUAL_DEFAULT, p)
    return p


@app.get("/api/manual")
def manual_get():
    p = manual_path()
    return {"content": p.read_text(encoding="utf-8") if p.exists() else "", "path": str(p)}


@app.put("/api/manual")
def manual_put(payload: dict = Body(...)):
    manual_path().write_text(payload.get("content", ""), encoding="utf-8")
    db.log("manual", "User manual edited")
    return {"ok": True}


@app.post("/api/manual/reset")
def manual_reset():
    shutil.copyfile(MANUAL_DEFAULT, manual_path())
    return manual_get()


# ------------------------------------------------------------------ Activity log & reset
@app.get("/api/events")
def events():
    return db.events()


@app.post("/api/reset")
def reset():
    db.reset()
    for p in pdf_dir.glob("*.pdf"):
        p.unlink(missing_ok=True)
    db.log("reset", "All data was reset")
    return {"ok": True}


# ------------------------------------------------------------------ Exporte (CSV, Excel-freundlich)
def _csv(rows: list[list], header: list[str], name: str) -> Response:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(header)
    w.writerows(rows)
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/api/export/overview.csv")
def export_overview(only_delta: bool = False, only_retro: bool = False):
    ov = overview()
    rows = []
    for u in ov["umbrellas"]:
        for f in u["funds"]:
            for c in f["classes"]:
                if only_delta and c["status"] == "covered":
                    continue
                if only_retro and not c["pays_retro"]:
                    continue
                rows.append([u["name"], f["fund_id"], f["fund_name"], c["class_id"], c["class_name"], c["isin"], c["ticker"],
                             c["currency"], c["retro"], c["retro_basis"], c["status"], c["via"], ", ".join(c["documents"]),
                             ", ".join(f["sources"])])
    header = ["Umbrella", "Fund ID", "Fund", "Class ID", "Share class", "ISIN", "Ticker", "Currency", "Retrocession",
              "Retro basis", "Status", "Matched via", "Agreements", "Data source"]
    name = "distrimatcher_" + ("gaps" if only_delta else "overview") + ("_retro" if only_retro else "") + ".csv"
    return _csv(rows, header, name)


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
                retro = {True: "yes", False: "no"}.get(sc.get("retro"), "")
                rows.append(base + [(ex.get("retrocession") or {}).get("rate"), f.get("umbrella"), f.get("name"),
                                    "yes" if f.get("all_classes") else "", sc.get("name"), sc.get("isin"), sc.get("fee"), retro])
    header = ["Document", "Type", "Date", "Fund entity", "Distributor", "Management company", "Governing law", "Territory",
              "Notice period", "Exclusivity", "Retro rate (agreement)", "Umbrella", "Fund", "All classes", "Share class", "ISIN",
              "Fee", "Retrocession"]
    return _csv(rows, header, "distrimatcher_extraction.csv")


@app.get("/api/export/extraction.json")
def export_json():
    return JSONResponse([{k: v for k, v in d.items() if k != "text"} for d in db.documents()])


# ------------------------------------------------------------------ Frontend
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")
