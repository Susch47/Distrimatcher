"""Erzeugt synthetische Distribution Agreements (EU/UCITS-Stil) zum Testen.

Alle Firmen, Fonds, ISINs und LEIs sind FIKTIV (Prüfziffern sind gültig, damit
die Validierung greift). Zusätzlich wird ein Fondsuniversum als CSV erzeugt, das
mehr Share Classes enthält als die Verträge abdecken -> Delta-Demo.

    python samples/generate_samples.py
"""
from __future__ import annotations

import csv
import io
import random
import re
import sys
import zipfile
from pathlib import Path

from fpdf import FPDF

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))
from distrimatcher.identifiers import make_isin, make_lei  # noqa: E402

OUT = ROOT / "agreements" / "synthetic_eu"
FONT_DIRS = [Path("/usr/share/fonts/truetype/dejavu"), Path("C:/Windows/Fonts")]

rng = random.Random(47)


def isin(country: str) -> str:
    return make_isin(country, "9" + "".join(rng.choice("0123456789") for _ in range(8)))


def lei(prefix: str) -> str:
    return make_lei(prefix + "".join(rng.choice("0123456789ABCDEFGHJKLMNPRSTUVWXYZ") for _ in range(18 - len(prefix))))


# ------------------------------------------------------------------ Stammdaten (fiktiv)
ALPEN = {
    "umbrella": "Alpenblick Invest SICAV",
    "umbrella_lei": lei("5299"),
    "manco": "Alpenblick Asset Management S.A.",
    "manco_lei": lei("5299"),
    "funds": {
        "Alpenblick Invest SICAV - Global Equity Fund": ["A EUR acc", "A EUR dis", "I EUR acc", "I CHF hedged acc", "R USD acc"],
        "Alpenblick Invest SICAV - Euro Corporate Bond Fund": ["A EUR acc", "A EUR dis", "I EUR acc", "I CHF hedged acc"],
        "Alpenblick Invest SICAV - Swiss Small & Mid Cap Fund": ["A CHF acc", "I CHF acc", "A EUR hedged acc"],
        "Alpenblick Invest SICAV - Sustainable Infrastructure Fund": ["A EUR acc", "I EUR acc", "I USD hedged acc"],
        "Alpenblick Invest SICAV - Emerging Markets Debt Fund": ["A USD acc", "I USD acc", "A EUR hedged dis"],
    },
}
NORD = {
    "umbrella": "Nordlicht Funds ICAV",
    "umbrella_lei": lei("6354"),
    "manco": "Nordlicht Capital Management Limited",
    "manco_lei": lei("6354"),
    "funds": {
        "Nordlicht Funds ICAV - Nordic Equity Fund": ["Class A EUR", "Class B EUR", "Class I EUR", "Class I SEK", "Class R CHF"],
        "Nordlicht Funds ICAV - Global Short Duration Fund": ["Class A EUR", "Class I EUR", "Class I USD", "Class Z EUR"],
        "Nordlicht Funds ICAV - Clean Energy Transition Fund": ["Class A EUR", "Class I EUR", "Class I CHF"],
    },
}
for fam, cc in ((ALPEN, "LU"), (NORD, "IE")):
    fam["isins"] = {f: {c: isin(cc) for c in classes} for f, classes in fam["funds"].items()}
    fam["fund_leis"] = {f: lei(fam["umbrella_lei"][:4]) for f in fam["funds"]}

# --- additional families (appended so that the ISINs above stay stable)
SEEALP = {
    "umbrella": "Seealp Swiss Funds",
    "umbrella_lei": lei("5067"),
    "manco": "Seealp Fondsleitung AG",
    "manco_lei": lei("5067"),
    "funds": {
        "Seealp Swiss Equity Fund": ["A CHF dis", "B CHF acc", "I CHF acc", "N CHF acc"],
        "Seealp CHF Bond Fund": ["A CHF dis", "B CHF acc", "I CHF acc"],
        "Seealp Global Balanced Fund": ["B CHF acc", "A EUR hedged acc", "I CHF acc", "N CHF acc"],
    },
}
KESTREL = {
    "umbrella": "Kestrel Point Funds ICAV",
    "umbrella_lei": lei("6354"),
    "manco": "Kestrel Point Asset Management Limited",
    "manco_lei": lei("6354"),
    "funds": {
        "Kestrel Point Funds ICAV - Global Credit Opportunities Fund": ["Class A USD", "Class A CHF hedged", "Class I USD", "Class Z USD"],
        "Kestrel Point Funds ICAV - Asia Dividend Fund": ["Class A USD", "Class B EUR", "Class I USD"],
    },
}
for fam, cc in ((SEEALP, "CH"), (KESTREL, "IE")):
    fam["isins"] = {f: {c: isin(cc) for c in classes} for f, classes in fam["funds"].items()}
    fam["fund_leis"] = {f: lei(fam["umbrella_lei"][:4]) for f in fam["funds"]}


# ------------------------------------------------------------------ PDF-Helfer
class Doc(FPDF):
    def __init__(self, footer_text: str):
        super().__init__(format="A4")
        self.footer_text = footer_text
        font_dir = next((d for d in FONT_DIRS if (d / "DejaVuSans.ttf").exists()), None)
        if font_dir:
            self.add_font("Body", "", str(font_dir / "DejaVuSans.ttf"))
            self.add_font("Body", "B", str(font_dir / "DejaVuSans-Bold.ttf"))
            self.fam = "Body"
        else:
            self.fam = "Helvetica"
        self.set_margins(22, 20, 22)
        self.set_auto_page_break(True, 20)
        self.add_page()

    def footer(self):
        self.set_y(-14)
        self.set_font(self.fam, "", 7)
        self.cell(0, 6, f"{self.footer_text} - Seite {self.page_no()}", align="C")

    def heading(self, text, size=13):
        self.set_font(self.fam, "B", size)
        self.multi_cell(0, 7, text, align="C", new_x="LMARGIN", new_y="NEXT")
        self.ln(2)

    def sub(self, text):
        self.set_font(self.fam, "B", 10)
        self.ln(2)
        self.multi_cell(0, 6, text, new_x="LMARGIN", new_y="NEXT")

    def para(self, text):
        self.set_font(self.fam, "", 9.5)
        self.multi_cell(0, 5, text, new_x="LMARGIN", new_y="NEXT")
        self.ln(1.5)

    def grid(self, rows, widths):
        self.set_font(self.fam, "", 8)
        with self.table(col_widths=widths, text_align="LEFT", line_height=5) as t:
            for i, r in enumerate(rows):
                row = t.row()
                for c in r:
                    if i == 0:
                        self.set_font(self.fam, "B", 8)
                    row.cell(str(c))
                self.set_font(self.fam, "", 8)
        self.ln(3)


def signatures(d: Doc, left: tuple[str, str, str], right: tuple[str, str, str]):
    d.ln(6)
    d.set_font(d.fam, "", 9)
    y = d.get_y()
    for x, (firm, name, title) in ((22, left), (112, right)):
        d.set_xy(x, y)
        d.multi_cell(80, 5, f"{firm}\n\nBy: /s/ {name}\nName: {name}\nTitle: {title}")


# ------------------------------------------------------------------ Vertrag 1: Alpenblick (Englisch, Tabelle)
def alpenblick_agreement() -> bytes:
    a = ALPEN
    d = Doc("Distribution Agreement Alpenblick Invest SICAV / Seeland Vertriebs AG")
    d.heading("GLOBAL DISTRIBUTION AGREEMENT")
    d.para(
        f"This Global Distribution Agreement (the \"Agreement\") is dated as of 15 March 2024 and made by and between "
        f"{a['umbrella']}, a société d'investissement à capital variable incorporated under the laws of the Grand Duchy of "
        f"Luxembourg, LEI {a['umbrella_lei']} (the \"Company\"), acting through its management company "
        f"{a['manco']} (the \"Management Company\"), LEI {a['manco_lei']}, and Seeland Vertriebs AG, Bahnhofstrasse 12, "
        f"8001 Zürich, Switzerland (the \"Distributor\")."
    )
    d.sub("1. Appointment")
    d.para(
        "The Company hereby appoints the Distributor as non-exclusive distributor of the shares of the sub-funds and "
        "share classes listed in Schedule A (the \"Shares\") in the following territory: Switzerland, Germany, Austria "
        "and Liechtenstein (the \"Territory\"). The Distributor shall not distribute the Shares to US Persons."
    )
    d.sub("2. Duties of the Distributor")
    d.para(
        "The Distributor shall comply with all applicable laws, in particular FIDLEG/FinSA, MiFID II and applicable "
        "anti-money laundering regulations, and shall only use marketing material approved by the Management Company. "
        "The Distributor shall perform the target market assessment for each share class prior to distribution."
    )
    d.sub("3. Remuneration")
    d.para(
        "As remuneration for its services the Distributor shall receive a trail commission of 40% of the management fee "
        "effectively charged to the relevant share class, calculated on the average daily net assets held by its clients. "
        "No trail commission is payable on Class I shares. Commissions are payable quarterly in arrears within 30 days "
        "after quarter end."
    )
    d.sub("4. Term and Termination")
    d.para(
        "This Agreement shall continue in force for an indefinite period of time. Either party may terminate this "
        "Agreement by giving ninety (90) days' prior written notice to the other party. The Agreement may be terminated "
        "with immediate effect in case of material breach."
    )
    d.sub("5. Governing Law and Jurisdiction")
    d.para(
        "This Agreement shall be governed by and construed in accordance with the laws of the Grand Duchy of Luxembourg. "
        "The courts of Luxembourg City shall have exclusive jurisdiction."
    )
    signatures(d, (a["umbrella"], "Claire Weber", "Director"), ("Seeland Vertriebs AG", "Martin Keller", "CEO"))
    d.add_page()
    d.heading("SCHEDULE A - Sub-Funds and Share Classes", 11)
    d.para("The following sub-funds and share classes are covered by this Agreement (status 15 March 2024):")
    rows = [["Sub-Fund", "Share Class", "ISIN", "Trail Commission"]]
    covered = {
        "Alpenblick Invest SICAV - Global Equity Fund": ["A EUR acc", "A EUR dis", "I EUR acc"],
        "Alpenblick Invest SICAV - Euro Corporate Bond Fund": ["A EUR acc", "I EUR acc"],
        "Alpenblick Invest SICAV - Swiss Small & Mid Cap Fund": ["A CHF acc", "I CHF acc"],
    }
    for f, classes in covered.items():
        for c in classes:
            rows.append([f, c, a["isins"][f][c], "0.00%" if c.startswith("I") else "40% of mgmt fee"])
    d.grid(rows, (62, 30, 34, 30))
    return bytes(d.output())


# ------------------------------------------------------------------ Vertrag 2: Nachtrag Alpenblick (Deutsch)
def alpenblick_nachtrag() -> bytes:
    a = ALPEN
    d = Doc("Nachtrag Nr. 1 zum Global Distribution Agreement")
    d.heading("NACHTRAG NR. 1 ZUM GLOBAL DISTRIBUTION AGREEMENT")
    d.para(
        f"Nachtrag vom 1. Oktober 2025 zum Global Distribution Agreement vom 15. März 2024 zwischen {a['umbrella']} "
        f"(die \"Gesellschaft\"), vertreten durch die Verwaltungsgesellschaft {a['manco']}, und Seeland Vertriebs AG "
        f"(der \"Vertriebsträger\")."
    )
    d.sub("1. Erweiterung des Anhangs A")
    d.para(
        "Anhang A wird mit Wirkung ab 1. Oktober 2025 um die folgenden Teilfonds und Anteilsklassen ergänzt. "
        "Die Bestandsprovision beträgt 35% der Verwaltungsvergütung für A-Klassen. Für I-Klassen fällt keine "
        "Bestandsprovision an."
    )
    rows = [["Teilfonds", "Anteilsklasse", "ISIN"]]
    add = {
        "Alpenblick Invest SICAV - Sustainable Infrastructure Fund": ["A EUR acc", "I EUR acc"],
        "Alpenblick Invest SICAV - Global Equity Fund": ["I CHF hedged acc"],
    }
    for f, classes in add.items():
        for c in classes:
            rows.append([f, c, a["isins"][f][c]])
    d.grid(rows, (90, 34, 36))
    d.sub("2. Vertriebsgebiet")
    d.para("Das Vertriebsgebiet (Vertriebsländer) wird um Italien erweitert. Im Übrigen bleibt der Vertrag unverändert.")
    d.sub("3. Anwendbares Recht")
    d.para("Dieser Nachtrag unterliegt luxemburgischem Recht. Gerichtsstand ist Luxemburg.")
    signatures(d, (a["manco"], "Claire Weber", "Director"), ("Seeland Vertriebs AG", "Martin Keller", "CEO"))
    return bytes(d.output())


# ------------------------------------------------------------------ Vertrag 3: Nordlicht (Deutsch, Fließtext-Liste) -> wird gescannt
def nordlicht_vertrag() -> bytes:
    n = NORD
    d = Doc("Vertriebsvereinbarung Nordlicht Funds ICAV")
    d.heading("VERTRIEBSVEREINBARUNG")
    d.para(
        f"Diese Vertriebsvereinbarung wird am 3. Juni 2023 zwischen {n['umbrella']}, einem in Irland registrierten "
        f"Irish Collective Asset-management Vehicle (der \"Fonds\"), vertreten durch {n['manco']} "
        f"(die \"Verwaltungsgesellschaft\"), und Rheintal Privatbank AG, Vaduz (der \"Vertriebspartner\") geschlossen."
    )
    d.sub("§ 1 Gegenstand")
    d.para(
        "Der Fonds beauftragt den Vertriebspartner nicht exklusiv mit dem Vertrieb der in Anhang 1 aufgeführten "
        "Anteilsklassen in den folgenden Vertriebsländern: Liechtenstein, Schweiz und Österreich."
    )
    d.sub("§ 2 Vergütung")
    d.para(
        "Der Vertriebspartner erhält eine Vertriebsprovision von 0,50% p.a. auf den durchschnittlichen Bestand in "
        "Class A Anteilen sowie eine Bestandsprovision von 0,25% p.a. für Class B Anteile."
    )
    d.sub("§ 3 Laufzeit und Kündigung")
    d.para(
        "Die Vereinbarung wird auf unbestimmte Zeit geschlossen und kann von jeder Partei mit einer Kündigungsfrist "
        "von 3 Monaten zum Quartalsende schriftlich gekündigt werden."
    )
    d.sub("§ 4 Anwendbares Recht")
    d.para("Diese Vereinbarung unterliegt irischem Recht. Gerichtsstand ist Dublin.")
    d.sub("Anhang 1 - Anteilsklassen")
    for f, classes in (("Nordlicht Funds ICAV - Nordic Equity Fund", ["Class A EUR", "Class B EUR", "Class I EUR"]),
                       ("Nordlicht Funds ICAV - Global Short Duration Fund", ["Class A EUR", "Class I EUR"])):
        for c in classes:
            d.para(f"{f}   {c}   {n['isins'][f][c]}")
    signatures(d, (n["manco"], "Siobhan Murphy", "Director"), ("Rheintal Privatbank AG", "Andreas Büchel", "Head Distribution"))
    return bytes(d.output())


# ------------------------------------------------------------------ Vertrag 4: Seealp (Schweiz, Deutsch, Tabelle mit Retro-Spalte)
def seealp_vertrag() -> bytes:
    a = SEEALP
    d = Doc("Vertriebsvertrag Seealp Swiss Funds / Bodensee Privatbank AG - fiktives Testdokument")
    d.heading("VERTRIEBSVERTRAG")
    d.para(
        f"Vertriebsvertrag vom 12. Februar 2025 zwischen {a['manco']}, Zürich, als Fondsleitung der vertraglichen "
        f"Anlagefonds {a['umbrella']} (die \"Fondsleitung\"), und Bodensee Privatbank AG, St. Gallen (die \"Vertriebsträgerin\")."
    )
    d.sub("1. Gegenstand")
    d.para(
        "Die Fondsleitung ermächtigt die Vertriebsträgerin nicht exklusiv, die in Anhang 1 aufgeführten Anteilsklassen in "
        "folgenden Vertriebsländern anzubieten: Schweiz und Liechtenstein. Die Vertriebsträgerin hält die Vorgaben des "
        "FIDLEG sowie die Verhaltensregeln der Asset Management Association Switzerland ein."
    )
    d.sub("2. Bestandespflegekommission")
    d.para(
        "Die Vertriebsträgerin erhält eine Bestandespflegekommission von 0.60% p.a. auf dem durchschnittlichen Bestand "
        "ihrer Kunden in A- und B-Klassen. Für I-Klassen und N-Klassen werden keine Retrozessionen bezahlt. Die Abrechnung "
        "erfolgt halbjährlich."
    )
    d.sub("3. Dauer und Kündigung")
    d.para("Der Vertrag wird auf unbestimmte Zeit abgeschlossen und kann mit einer Kündigungsfrist von 6 Monaten auf ein Monatsende gekündigt werden.")
    d.sub("4. Anwendbares Recht")
    d.para("Dieser Vertrag unterliegt schweizerischem Recht. Gerichtsstand ist Zürich.")
    signatures(d, (a["manco"], "Reto Ammann", "Geschäftsführer"), ("Bodensee Privatbank AG", "Sandra Keller", "Leiterin Fondsvertrieb"))
    d.add_page()
    d.heading("ANHANG 1 - Teilfonds und Anteilsklassen", 11)
    rows = [["Teilfonds", "Anteilsklasse", "ISIN", "Bestandespflege"]]
    covered = {
        "Seealp Swiss Equity Fund": ["A CHF dis", "B CHF acc", "I CHF acc"],
        "Seealp CHF Bond Fund": ["A CHF dis", "I CHF acc"],
        "Seealp Global Balanced Fund": ["B CHF acc"],
    }
    for f, classes in covered.items():
        for c in classes:
            rows.append([f, c, a["isins"][f][c], "0.00%" if c[0] in "IN" else "0.60% p.a."])
    d.grid(rows, (62, 30, 34, 30))
    return bytes(d.output())


# ------------------------------------------------------------------ Vertrag 5: Kestrel Point (Englisch, Amendment)
def kestrel_amendment() -> bytes:
    k = KESTREL
    d = Doc("Amendment No. 2 - Kestrel Point Funds ICAV - fictitious test document")
    d.heading("AMENDMENT NO. 2 TO THE DISTRIBUTION AGREEMENT")
    d.para(
        f"This Amendment No. 2 is dated as of 30 June 2025 and made by and between {k['umbrella']}, an Irish collective "
        f"asset-management vehicle (the \"ICAV\"), {k['manco']} (the \"Manager\") and Bodensee Privatbank AG "
        f"(the \"Distributor\"), amending the Distribution Agreement dated 1 March 2022."
    )
    d.sub("1. Amendment of Schedule 1")
    d.para(
        "Schedule 1 is replaced by the schedule below. The Distributor shall receive a trail commission of 50% of the "
        "management fee on Class A and Class B shares. No trail commission is payable on Class I or Class Z shares."
    )
    rows = [["Sub-Fund", "Share Class", "ISIN", "Trail Commission"]]
    covered = {
        "Kestrel Point Funds ICAV - Global Credit Opportunities Fund": ["Class A USD", "Class I USD"],
        "Kestrel Point Funds ICAV - Asia Dividend Fund": ["Class A USD", "Class I USD"],
    }
    for f, classes in covered.items():
        for c in classes:
            rows.append([f, c, k["isins"][f][c], "None" if c.split()[1] in "IZ" else "50% of mgmt fee"])
    d.grid(rows, (70, 28, 34, 28))
    d.sub("2. Notice")
    d.para("Either party may terminate the Distribution Agreement by giving sixty (60) days' prior written notice. All other terms remain unchanged.")
    d.sub("3. Governing law")
    d.para("This Amendment shall be governed by and construed in accordance with the laws of Ireland.")
    signatures(d, (k["manco"], "Aoife Brennan", "Director"), ("Bodensee Privatbank AG", "Sandra Keller", "Head of Fund Distribution"))
    return bytes(d.output())


# ------------------------------------------------------------------ Vertrag 6: Seealp Side Letter (gescannt, Englisch)
def seealp_side_letter() -> bytes:
    a = SEEALP
    d = Doc("Side Letter Seealp Swiss Funds - fictitious test document")
    d.heading("SIDE LETTER")
    d.para(
        f"Side letter dated 3 September 2025 to the Distribution Agreement dated 12 February 2025 between {a['manco']} "
        f"(the \"Fund Management Company\") and Bodensee Privatbank AG (the \"Distributor\")."
    )
    d.para(
        "With effect from 1 October 2025 the following share class is added to Annex 1. The trail commission of 0.60% p.a. "
        "applies accordingly."
    )
    f = "Seealp Global Balanced Fund"
    d.para(f"{f}   A EUR hedged acc   {a['isins'][f]['A EUR hedged acc']}")
    d.para("All other provisions of the Distribution Agreement remain unchanged.")
    signatures(d, (a["manco"], "Reto Ammann", "Managing Director"), ("Bodensee Privatbank AG", "Sandra Keller", "Head of Fund Distribution"))
    return bytes(d.output())


def scan(pdf_bytes: bytes) -> bytes:
    """Rendert ein PDF zu Bildern (leicht gedreht, verrauscht) -> 'gescanntes' PDF ohne Textlayer."""
    import pypdfium2 as pdfium
    from PIL import Image, ImageFilter

    pdf = pdfium.PdfDocument(pdf_bytes)
    images = []
    for page in pdf:
        img = page.render(scale=200 / 72).to_pil().convert("L")
        img = img.rotate(0.6, expand=False, fillcolor=255).filter(ImageFilter.GaussianBlur(0.5))
        noise = Image.effect_noise(img.size, 18).convert("L")
        img = Image.blend(img, noise, 0.06)
        images.append(img.convert("RGB"))
    buf = io.BytesIO()
    images[0].save(buf, format="PDF", save_all=True, append_images=images[1:], resolution=200)
    return buf.getvalue()


# Retro-Angabe wie in einer Fondsliste: A/B/R-Klassen zahlen Trail, I/Z sind "clean"
RETRO = {"A": "0.40%", "B": "0.25%", "R": "0.50%", "I": "nein", "Z": "nein", "N": "nein"}


def universe_csv(path: Path) -> None:
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["umbrella", "fund_id", "fund_name", "share_class", "isin", "currency", "management_company", "retrocession"])
        for fam in (ALPEN, NORD, SEEALP, KESTREL):
            for f, classes in fam["funds"].items():
                for c in classes:
                    w.writerow([fam["umbrella"], fam["fund_leis"][f], f, c, fam["isins"][f][c], re.search(r"EUR|USD|CHF|SEK|GBP", c).group(0), fam["manco"],
                            RETRO.get(c.replace("Class ", "").split()[0], "")])


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    files = {
        "Alpenblick_Global_Distribution_Agreement_2024.pdf": alpenblick_agreement,
        "Alpenblick_Nachtrag_1_2025.pdf": alpenblick_nachtrag,
        "Nordlicht_Vertriebsvereinbarung_2023_SCAN.pdf": lambda: scan(nordlicht_vertrag()),
        "Seealp_Vertriebsvertrag_2025.pdf": seealp_vertrag,
        "Kestrel_Point_Amendment_2_2025.pdf": kestrel_amendment,
        "Seealp_Side_Letter_2025_SCAN.pdf": lambda: scan(seealp_side_letter()),
    }
    for name, make in files.items():
        if not (OUT / name).exists():  # keep existing test documents stable
            (OUT / name).write_bytes(make())
    universe_csv(ROOT / "public_data" / "synthetic_fund_universe.csv")
    # Demo-ZIP mit allen Verträgen (synthetisch + öffentliche SEC-Exhibits)
    zpath = ROOT / "demo_agreements.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as zf:
        for pdf in sorted((ROOT / "agreements").rglob("*.pdf")):
            zf.write(pdf, pdf.relative_to(ROOT / "agreements"))
    print("geschrieben:", *files, zpath.name, "synthetic_fund_universe.csv", sep="\n  ")


if __name__ == "__main__":
    main()
