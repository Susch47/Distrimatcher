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
    assert ex.termination_notice == "90 Tage"
    assert ex.exclusivity == "nicht exklusiv"
    assert set(ex.territory) == {"Switzerland", "Germany", "Austria", "Liechtenstein"}
    assert sum(len(f.share_classes) for f in ex.funds) == 7
    assert all(sc.isin for f in ex.funds for sc in f.share_classes)


@pytest.mark.skipif(not ocr_available(), reason="Tesseract nicht installiert")
def test_scanned_german_agreement_via_ocr():
    px, ex = run(EU / "Nordlicht_Vertriebsvereinbarung_2023_SCAN.pdf")
    assert px.ocr_pages >= 1
    assert ex.distributor == "Rheintal Privatbank AG"
    assert ex.termination_notice == "3 Monate"
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
