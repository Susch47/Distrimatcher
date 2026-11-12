import csv
from pathlib import Path

import pytest

from distrimatcher.delta import build_overview, class_matches
from distrimatcher.extract import extract_document
from distrimatcher.identifiers import is_valid_isin, is_valid_lei, make_isin, repair_isin
from distrimatcher.ingest import extract_pdf, ocr_available, read_upload

SAMPLES = Path(__file__).resolve().parent.parent / "samples"
SEC = SAMPLES / "agreements" / "sec_public"
EU = SAMPLES / "agreements" / "synthetic_eu"


def run(path: Path):
    data = path.read_bytes()
    px = extract_pdf(data)
    return px, extract_document(px.text, data, {p.number for p in px.pages if p.ocr})


# ------------------------------------------------------------------ IDs
def test_isin_and_lei_checksums():
    assert is_valid_isin("US0378331005")  # Apple
    assert is_valid_isin("LU0274208692")
    assert not is_valid_isin("US0378331006")
    assert is_valid_isin(make_isin("LU", "912345678"))
    assert is_valid_lei("529900T8BM49AURSDO55")
    assert not is_valid_lei("529900T8BM49AURSDO56")


def test_ocr_isin_repair_only_with_valid_checksum():
    assert repair_isin("169861166812") == "IE9861166812"
    assert repair_isin("LU9I48987654") == "LU9148987654"
    assert repair_isin("123456789012") is None  # kein Fonds-Länderkürzel -> keine Erfindung


def test_class_matching():
    assert class_matches("JNL Government Money Market Fund (Class I)", "Institutional Class")
    assert class_matches("Class R-6", "Class R6")
    assert not class_matches("I CHF hedged acc", "I CHF acc")
    assert not class_matches("A EUR acc", "A EUR dis")
    assert not class_matches("Class A", "Class C")


# ------------------------------------------------------------------ Extraktion
def test_zip_reading(tmp_path):
    zp = SAMPLES / "demo_agreements.zip"
    pdfs = read_upload(zp.name, zp.read_bytes())
    assert len(pdfs) >= 9 and all(p.data[:4] == b"%PDF" for p in pdfs)


def test_sec_artisan_schedule_table():
    _, ex = run(SEC / "SEC_artisan_2022.pdf")
    names = {f.name for f in ex.funds}
    assert len(ex.funds) == 21
    assert "Artisan International Small-Mid Fund" in names
    assert "Artisan Emerging Markets Debt Opportunities Fund" in names
    assert all({c.name for c in f.share_classes} == {"Investor Shares", "Institutional Shares", "Advisor Shares"} for f in ex.funds)


def test_sec_jnl_full_agreement():
    _, ex = run(SEC / "SEC_jnl_investors_2022.pdf")
    assert ex.fund_entity == "JNL Investors Series Trust"
    assert ex.distributor == "Jackson National Life Distributors LLC"
    assert ex.governing_law == "Illinois"
    assert {f.name for f in ex.funds} == {"JNL Government Money Market Fund", "JNL Securities Lending Collateral Fund"}


def test_sec_all_share_classes_flag():
    _, ex = run(SEC / "SEC_nexpoint_2025.pdf")
    assert len(ex.funds) == 4 and all(f.all_classes for f in ex.funds)
    assert {f.umbrella for f in ex.funds} == {"NexPoint Funds I", "NexPoint Funds II"}


def test_sec_footnote_fund_list_without_fragments():
    _, ex = run(SEC / "SEC_carillon_2025.pdf")
    names = {f.name for f in ex.funds}
    assert len(names) == 15
    assert "Carillon Chartwell Short Duration High Yield Fund" in names
    assert "High Yield Fund" not in names


def test_eu_agreement_fields():
    _, ex = run(EU / "Alpenblick_Global_Distribution_Agreement_2024.pdf")
    assert ex.fund_entity == "Alpenblick Invest SICAV"
    assert ex.distributor == "Seeland Vertriebs AG"
    assert ex.management_company == "Alpenblick Asset Management S.A."
    assert ex.termination_notice == "90 days"
    assert ex.exclusivity == "non-exclusive"
    assert set(ex.territory) == {"Switzerland", "Germany", "Austria", "Liechtenstein"}
    assert sum(len(f.share_classes) for f in ex.funds) == 7
    assert all(sc.isin for f in ex.funds for sc in f.share_classes)


@pytest.mark.skipif(not ocr_available(), reason="Tesseract nicht installiert")
def test_scanned_german_agreement_via_ocr():
    px, ex = run(EU / "Nordlicht_Vertriebsvereinbarung_2023_SCAN.pdf")
    assert px.ocr_pages >= 1
    assert ex.distributor == "Rheintal Privatbank AG"
    assert ex.termination_notice == "3 months"
    assert set(ex.territory) == {"Liechtenstein", "Switzerland", "Austria"}
    universe = {r["isin"] for r in csv.DictReader(open(SAMPLES / "public_data" / "synthetic_fund_universe.csv", encoding="utf-8"))}
    found = {sc.isin for f in ex.funds for sc in f.share_classes}
    assert len(found) == 5 and found <= universe


# ------------------------------------------------------------------ Delta
def test_delta_against_universe():
    docs = []
    for i, p in enumerate(sorted(EU.glob("Alpenblick*.pdf"))):
        px, ex = run(p)
        docs.append({"id": i, "filename": p.name, "text": px.text, "extraction": ex.to_dict()})
    rows = [r for r in csv.DictReader(open(SAMPLES / "public_data" / "synthetic_fund_universe.csv", encoding="utf-8"))
            if r["umbrella"] == "Alpenblick Invest SICAV"]
    universe = [{"source": "Import", "umbrella": r["umbrella"], "fund_id": r["fund_id"], "fund_name": r["fund_name"],
                 "class_name": r["share_class"], "isin": r["isin"], "currency": r["currency"]} for r in rows]
    ov = build_overview(universe, docs)
    t = ov["totals"]
    assert t["classes"] == 18 and t["covered"] == 10 and t["delta"] == 8
    emd = next(f for u in ov["umbrellas"] for f in u["funds"] if "Emerging Markets Debt" in f["fund_name"])
    assert emd["covered"] == 0 and not emd["matched_agreements"]


# ------------------------------------------------------------------ Retrozessionen
def test_retrocession_terms_from_agreements():
    _, ex = run(EU / "Alpenblick_Global_Distribution_Agreement_2024.pdf")
    assert ex.retrocession["agreed"] is True
    assert ex.retrocession["rate"].startswith("40%")
    assert ex.retrocession["excluded_classes"] == ["I"]
    retro = {sc.name: sc.retro for f in ex.funds for sc in f.share_classes}
    assert retro["A EUR acc"] is True and retro["I EUR acc"] is False

    _, ex = run(EU / "Alpenblick_Nachtrag_1_2025.pdf")  # "Für I-Klassen fällt keine Bestandsprovision an"
    assert "I" in ex.retrocession["excluded_classes"] and "A" in ex.retrocession["included_classes"]

    _, ex = run(SEC / "SEC_carillon_2025.pdf")  # 12b-1-Sätze je Klasse
    f = next(f for f in ex.funds if f.name == "Carillon Eagle Growth & Income Fund")
    assert {sc.name: sc.retro for sc in f.share_classes} == {"Class A": True, "Class C": True, "Class I": False, "Class R-6": False}


def test_retro_import_parsing_and_guess():
    from distrimatcher.universe import guess_retro, parse_retro

    assert parse_retro("Ja") == "yes" and parse_retro("0,00%") == "no" and parse_retro("0.40%") == "0.40%"
    assert guess_retro("I EUR acc") == "no" and guess_retro("A EUR acc") == "yes" and guess_retro("Clean CHF") == "no"
    assert guess_retro("Class W") is None


def test_retro_delta():
    docs = []
    for i, p in enumerate(sorted(EU.glob("Alpenblick*.pdf"))):
        px, ex = run(p)
        docs.append({"id": i, "filename": p.name, "text": px.text, "extraction": ex.to_dict()})
    from distrimatcher.universe import import_table

    recs, _ = import_table("u.csv", (SAMPLES / "public_data" / "synthetic_fund_universe.csv").read_bytes())
    universe = [r.to_dict() for r in recs if r.umbrella == "Alpenblick Invest SICAV"]
    t = build_overview(universe, docs)["totals"]
    # A- und R-Klassen zahlen Retro (aus der Fondsliste), I-Klassen sind clean
    assert t["retro_classes"] == 10 and t["retro_unknown"] == 0
    assert t["retro_delta"] == 5


def test_watchlist_email_and_manual_flow(tmp_path, monkeypatch):
    """End-to-end through the API: empty start -> upload -> import -> watchlist -> add/confirm -> e-mail."""
    monkeypatch.setenv("DISTRIMATCHER_DATA", str(tmp_path))
    import importlib, time
    import distrimatcher.app as appmod
    importlib.reload(appmod)
    from fastapi.testclient import TestClient

    c = TestClient(appmod.app)
    assert c.get("/api/documents").json() == [] and c.get("/api/watchlist").json() == []
    files = [("files", (p.name, p.read_bytes(), "application/pdf")) for p in sorted(EU.glob("Alpenblick*.pdf"))]
    c.post("/api/upload", files=files)
    for _ in range(100):
        if all(d["status"] == "done" for d in c.get("/api/documents").json()):
            break
        time.sleep(0.1)
    csv_bytes = (SAMPLES / "public_data" / "synthetic_fund_universe.csv").read_bytes()
    c.post("/api/universe/import", files={"file": ("fondsliste.csv", csv_bytes, "text/csv")})
    wl = [i for i in c.get("/api/watchlist").json() if i["umbrella"] == "Alpenblick Invest SICAV"]
    assert len(wl) == 8 and all(i["status"] == "open" and i["is_new"] for i in wl)
    item = next(i for i in wl if i["class_name"] == "R USD acc")
    assert item["agreements"] and "row" in item["origin"] and item["isin"] in item["origin"]
    assert any(t["label"] == "Retail" for t in item["features"])
    doc_id = item["agreements"][0]["id"]
    c.post("/api/watchlist/status", json={"keys": [item["key"]], "status": "added", "doc_id": doc_id})
    ov = c.get("/api/overview").json()
    assert ov["totals"]["covered"] >= 11
    others = [i["key"] for i in wl if i["key"] != item["key"]][:3]
    c.post("/api/watchlist/status", json={"keys": others, "status": "confirmed"})
    d = c.get("/api/email/draft", params={"provider": "Alpenblick Invest SICAV", "scope": "confirmed"}).json()
    assert d["count"] == 3 and "not covered" in d["subject"] and all(k in d["keys"] for k in others)
    eml = c.post("/api/email/eml", json={"to": "x@example.org", "subject": d["subject"], "body": d["body"]})
    assert eml.status_code == 200 and b"X-Unsent: 1" in eml.content
    assert "Watchlist" in c.get("/api/manual").json()["content"]
    kinds = {e["kind"] for e in c.get("/api/events").json()}
    assert {"upload", "extraction", "universe", "watchlist", "email"} <= kinds
    c.post("/api/reset")
    assert c.get("/api/documents").json() == []
