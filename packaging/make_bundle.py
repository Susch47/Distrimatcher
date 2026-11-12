"""Builds the test package Distrimatcher-Testpaket.zip (single-file edition + test data + brochure).

    cd web && npm run build && cd .. && python packaging/make_bundle.py <output_dir>
"""
from __future__ import annotations

import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main(out_dir: Path) -> Path:
    pkg = out_dir / "Distrimatcher-Testpaket"
    if pkg.exists():
        shutil.rmtree(pkg)
    (pkg / "Test data" / "Agreements (PDF)").mkdir(parents=True)
    (pkg / "Graphics").mkdir()

    shutil.copy(ROOT / "web/dist/Distrimatcher.html", pkg / "Distrimatcher.html")
    shutil.copy(ROOT / "docs/brochure/Distrimatcher-Brochure.pdf", pkg / "Distrimatcher-Brochure.pdf")
    shutil.copy(ROOT / "packaging/INSTRUCTIONS-HTML.txt", pkg / "INSTRUCTIONS.txt")

    agreements = ROOT / "samples/agreements"
    for sub, target in (("sec_public", "sec_public"), ("synthetic_eu", "synthetic")):
        shutil.copytree(agreements / sub, pkg / "Test data" / "Agreements (PDF)" / target)
    with zipfile.ZipFile(pkg / "Test data" / "Test-Agreements.zip", "w", zipfile.ZIP_DEFLATED) as zf:
        for pdf in sorted((pkg / "Test data" / "Agreements (PDF)").rglob("*.pdf")):
            zf.write(pdf, pdf.relative_to(pkg / "Test data" / "Agreements (PDF)"))
    shutil.copy(ROOT / "samples/public_data/synthetic_fund_universe.csv", pkg / "Test data" / "Fund_list_with_retro.csv")
    sec = sorted((ROOT / "samples/public_data").glob("sec_series_class_*.csv"))
    if sec:
        shutil.copy(sec[-1], pkg / "Test data" / "SEC_dataset_2026.csv")

    for f in ("concept-business.png", "concept-architecture.png", "waterfall.png"):
        shutil.copy(ROOT / "docs/brochure" / f, pkg / "Graphics" / f)
    for f in ("logo.png", "logo-light-on-dark.png", "logo-mark.png", "logo.svg"):
        shutil.copy(ROOT / "brand" / f, pkg / "Graphics" / f)

    zpath = out_dir / "Distrimatcher-Testpaket.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for f in sorted(pkg.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(out_dir))
    return zpath


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "dist")
    out.mkdir(parents=True, exist_ok=True)
    print(main(out))
