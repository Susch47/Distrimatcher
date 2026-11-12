"""Regelbasierte Extraktion der Inhalte eines Distribution Agreements.

Liefert u. a. Parteien (Fonds/Umbrella, Distributor, Verwaltungsgesellschaft), Datum,
anwendbares Recht, Territorium, Gebühren, Kündigungsfrist, Exklusivität, Unterzeichner
sowie die Liste der abgedeckten Funds mit ihren Share Classes / ISINs.
Alle Regeln laufen lokal – es werden keine Dokumentinhalte nach außen gesendet.
"""
from __future__ import annotations

import io
import re
from dataclasses import asdict, dataclass, field

import pdfplumber

from .identifiers import find_isins, find_leis, is_valid_isin, SEC_SERIES_RE, SEC_CLASS_RE

# ---------------------------------------------------------------- Hilfsmuster
MONTHS_EN = "January|February|March|April|May|June|July|August|September|October|November|December"
MONTHS_DE = "Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember"
DATE_RE = (
    rf"(?:(?:{MONTHS_EN})\s+\d{{1,2}},?\s+\d{{4}}"
    rf"|\d{{1,2}}(?:st|nd|rd|th)?\s+(?:day of\s+)?(?:{MONTHS_EN}),?\s+\d{{4}}"
    rf"|\d{{1,2}}\.\s*(?:{MONTHS_DE})\s+\d{{4}}"
    rf"|\d{{1,2}}\.\d{{1,2}}\.\d{{4}}|\d{{4}}-\d{{2}}-\d{{2}})"
)
CCY = r"EUR|USD|CHF|GBP|JPY|SEK|NOK|DKK|AUD|CAD|SGD|HKD"
NUMBER_WORDS = {
    "fifteen": 15, "thirty": 30, "forty-five": 45, "forty five": 45, "sixty": 60,
    "ninety": 90, "one hundred twenty": 120, "dreissig": 30, "dreißig": 30, "sechzig": 60,
    "neunzig": 90, "three": 3, "six": 6, "twelve": 12, "drei": 3, "sechs": 6,
}
COUNTRIES = [
    "Austria", "Belgium", "Denmark", "Finland", "France", "Germany", "Greece", "Ireland", "Italy",
    "Liechtenstein", "Luxembourg", "Netherlands", "Norway", "Portugal", "Spain", "Sweden",
    "Switzerland", "United Kingdom", "Singapore", "Hong Kong", "United States", "Chile", "Peru",
    "Österreich", "Deutschland", "Schweiz", "Frankreich", "Italien", "Spanien", "Luxemburg",
    "Niederlande", "Belgien", "Schweden", "Norwegen", "Dänemark", "Finnland", "Irland",
    "Vereinigtes Königreich", "Portugal",
]
COUNTRY_NORMAL = {
    "Österreich": "Austria", "Deutschland": "Germany", "Schweiz": "Switzerland",
    "Frankreich": "France", "Italien": "Italy", "Spanien": "Spain", "Luxemburg": "Luxembourg",
    "Niederlande": "Netherlands", "Belgien": "Belgium", "Schweden": "Sweden",
    "Norwegen": "Norway", "Dänemark": "Denmark", "Finnland": "Finland", "Irland": "Ireland",
    "Vereinigtes Königreich": "United Kingdom",
}

CLASS_PATTERNS = [
    # "Class A", "Class R-6", "Class I2", "Class A EUR acc", "Klasse B CHF"
    rf"(?:Share\s+)?(?:Class|Klasse|Anteilsklasse|Anteilklasse)\s+[A-Z][A-Za-z0-9]*(?:-\d+)?(?:\s+(?:{CCY}))?(?:\s+(?:hedged|H|acc|dis|inc|thes|aussch))*",
    # "Investor Shares", "Institutional Class", "Advisor Shares", "Service Class"
    r"(?:Investor|Institutional|Advisor|Retail|Service|Administrative|Admin|Premier|Select|Investor\s+A|Investor\s+C|Ultra|Y)\s+(?:Shares|Class)",
    # EU-Kurzform "A EUR acc", "I CHF dis", "R USD hedged acc"
    rf"\b[A-Z]{{1,3}}\d?\s+(?:{CCY})(?:\s+(?:hedged|H|acc|dis|inc|thes|aussch))+",
]
CLASS_RE = re.compile("|".join(f"(?:{p})" for p in CLASS_PATTERNS))
CLASS_LIST_RE = re.compile(r"Class(?:es)?\s+((?:[A-Z][A-Z0-9-]{0,4})(?:\s*,\s*[A-Z][A-Z0-9-]{0,4})*\s*(?:,?\s*(?:and|und|&)\s*[A-Z][A-Z0-9-]{0,4}))\b")
ALL_CLASSES_RE = re.compile(r"all\s+(?:share\s+)?classes|sämtliche\s+anteilsklassen|alle\s+anteilsklassen", re.I)

FUND_WORD = r"(?:[A-Z][\w’'&./\-]*|of|and|the|&|SM|\d{4})"
FUND_NAME_RE = re.compile(
    rf"\b((?:{FUND_WORD}\s+){{0,9}}?(?:[A-Z][\w’'&./\-]*\s+)(?:Fund|Portfolio|Allocation|ETF|Teilfonds|Sub-Fund)(?:\s+(?:I{{1,3}}|II|IV))?)\b(?!\s+(?:Portfolios|Funds|Series|Trust|Inc)\b)"
)
FUND_GENERIC = {
    "the fund", "each fund", "such fund", "a fund", "any fund", "the funds", "fund", "series fund",
    "the portfolio", "each portfolio", "money market fund", "investment fund", "the sub-fund",
    "each sub-fund", "other fund", "new fund", "underlying fund", "acquiring fund",
}
FUND_LEAD_STRIP = re.compile(r"^(?:The|Each|All|Any|Such|Of|And|For|To|Add|Shares of|Including|Under|With|In)\s+", re.I)

HEADER_FUND = re.compile(r"fund|portfolio|series|teilfonds|sub-?fund|compartment|fonds", re.I)
HEADER_CLASS = re.compile(r"class|klasse|share", re.I)
HEADER_ISIN = re.compile(r"isin", re.I)
HEADER_FEE = re.compile(r"fee|provision|commission|gebühr|retro|%", re.I)


# ---------------------------------------------------------------- Datenmodell
@dataclass
class ShareClassEntry:
    name: str | None = None
    isin: str | None = None
    currency: str | None = None
    fee: str | None = None
    retro: bool | None = None  # zahlt laut Vertrag Retrozession/Trail?


@dataclass
class FundEntry:
    name: str
    umbrella: str | None = None
    all_classes: bool = False
    share_classes: list[ShareClassEntry] = field(default_factory=list)
    source: str = "text"

    def add_class(self, sc: ShareClassEntry) -> None:
        for existing in self.share_classes:
            if sc.isin and existing.isin == sc.isin:
                existing.name = existing.name or sc.name
                existing.fee = existing.fee or sc.fee
                return
            if not sc.isin and not existing.isin and sc.name and norm_class(existing.name or "") == norm_class(sc.name):
                existing.fee = existing.fee or sc.fee
                return
        self.share_classes.append(sc)


@dataclass
class Extraction:
    document_type: str | None = None
    title: str | None = None
    agreement_date: str | None = None
    effective_date: str | None = None
    parties: list[dict] = field(default_factory=list)
    fund_entity: str | None = None
    distributor: str | None = None
    management_company: str | None = None
    investment_adviser: str | None = None
    governing_law: str | None = None
    jurisdiction: str | None = None
    territory: list[str] = field(default_factory=list)
    exclusivity: str | None = None
    termination_notice: str | None = None
    term: str | None = None
    fees: list[str] = field(default_factory=list)
    retrocession: dict = field(default_factory=dict)
    signatories: list[str] = field(default_factory=list)
    isins: list[str] = field(default_factory=list)
    leis: list[str] = field(default_factory=list)
    sec_series_ids: list[str] = field(default_factory=list)
    sec_class_ids: list[str] = field(default_factory=list)
    funds: list[FundEntry] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------- Normalisierung
def clean(s: str) -> str:
    s = s.replace(" ", " ").replace("“", '"').replace("”", '"').replace("’", "'")
    return re.sub(r"\s+", " ", s).strip()


def norm_fund(name: str) -> str:
    s = clean(name).lower().replace("&", " and ")
    s = re.sub(r"\bsm\b|®|™", " ", s)
    s = re.sub(r"[^a-z0-9äöüß ]+", " ", s)
    stop = {"fund", "the", "portfolio", "inc", "sicav", "plc", "icav", "sub", "teilfonds", "a", "of", "funds"}
    return " ".join(t for t in s.split() if t not in stop)


def norm_class(name: str) -> str:
    s = clean(name).lower()
    s = re.sub(r"\b(share|shares|class|klasse|anteilsklasse|anteilklasse|anteile|of)\b", " ", s)
    s = s.replace("-", "")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return " ".join(s.split())


def class_currency(name: str | None) -> str | None:
    if not name:
        return None
    m = re.search(rf"\b({CCY})\b", name)
    return m.group(1) if m else None


# ---------------------------------------------------------------- Kopf-/Vertragsfelder
def _first(pattern: str, text: str, flags=re.I | re.S, group: int = 1) -> str | None:
    m = re.search(pattern, text, flags)
    return clean(m.group(group)) if m else None


def _party_role(name: str, alias: str | None) -> str:
    a = (alias or "").lower()
    probe = f"{name} {alias or ''}".lower()
    # Der definierte Begriff (Alias) ist das stärkste Signal
    if re.search(r"distribut|vertrieb|underwriter|placement|jnld", a):
        return "distributor"
    if re.search(r"management company|verwaltungsgesellschaft|manco|kvg|aifm", a):
        return "management_company"
    if re.search(r"advis|berater|investment manager", a):
        return "investment_adviser"
    if re.search(r"trust|fund|fonds|company|gesellschaft|sicav|icav|issuer|registrant|corporation", a):
        return "fund_entity"
    if re.search(r"distribut|vertrieb|underwriter|placement agent", probe):
        return "distributor"
    if re.search(r"management company|verwaltungsgesellschaft|asset management|capital management|kapitalverwaltung", probe):
        return "management_company"
    if re.search(r"advis|berater", probe):
        return "investment_adviser"
    if re.search(r"trust|fund|sicav|icav|fonds|series|portfolio", probe):
        return "fund_entity"
    if re.search(r"bank|ag\b|gmbh|llc|s\.a\.", probe):
        return "distributor"
    return "party"


DEFINITION_RE = re.compile(
    r"\((?:the\s+|die\s+|der\s+|das\s+|im\s+Folgenden\s+|nachfolgend\s+|hereinafter\s+)?[\"“„]([^\"”“]{2,40})[\"”“]\)"
)
LEGAL_FORM = r"(?:LLC|L\.L\.C\.|Inc\.?|Ltd\.?|Limited|S\.A\.|S\.à\s?r\.l\.|GmbH|AG|SICAV|ICAV|plc|LP|L\.P\.|N\.V\.|B\.V\.|KGaA|SE|Trust|Funds?(?:\s+[IVX]+)?|Corporation|Company)"
ENTITY_SUFFIX = re.compile(rf"\b{LEGAL_FORM}(?![\w])")
SKIP_ALIASES = {
    "agreement", "1940 act", "1933 act", "act", "sec", "finra", "exchange act", "vertrag", "vereinbarung", "shares",
    "prospectus", "territory", "registration statement", "distribution plan", "board of trustees", "board",
    "eligible separate accounts", "participating insurance companies", "investment company act", "portfolios",
    "anteile", "vertriebsgebiet", "plan", "contracts", "nachtrag",
}
PARTY_CUT = re.compile(
    r",\s+(?:a|an|ein|eine|einem|einer)\s|,\s+(?:organized|incorporated|established|with\s+its|LEI|having|mit\s+Sitz)|\s+LEI\s|,\s+\d|,\s+[A-Z][a-z]+strasse|,\s+[A-Z][a-z]+ (?:Street|Avenue|Road)|\s+(?:acting|vertreten|represented)\b",
    re.I,
)


def _entity_name(segment: str) -> str | None:
    """Schneidet aus dem Text vor einer Definition den eigentlichen Firmennamen heraus."""
    seg = clean(segment)
    seg = re.split(r"\b(?:by\s+and\s+between|between|zwischen|and|und|durch|through)\s+(?=[A-Z])|;|\)\s*,", seg)[-1]
    seg = PARTY_CUT.split(seg)[0].split("(")[0]
    seg = re.sub(r"^(?:the|die|der|das|its|ihre|seine|sowie)\s+", "", seg.strip(" ,;:(\"“"), flags=re.I)
    seg = re.sub(r"^(?:management company|Verwaltungsgesellschaft)\s+", "", seg, flags=re.I)
    m = list(ENTITY_SUFFIX.finditer(seg))
    if not m:
        return None
    name = seg[: m[-1].end()].strip(" ,")
    if len(name) < 4 or len(name) > 110 or not re.match(r"[A-Z0-9]", name):
        return None
    if re.search(r"\b(?:shall|amended|registration|hereby|separate accounts|whereas)\b|^the\s", name, re.I):
        return None
    return name


def extract_parties(text: str) -> list[dict]:
    head = clean(text[:6000])
    parties: list[dict] = []
    seen: set[str] = set()

    def add(name: str | None, alias: str | None, role: str | None = None) -> None:
        if not name:
            return
        key = name.lower()
        if key in seen:
            for p in parties:
                if p["name"].lower() == key and alias and not p["alias"]:
                    p["alias"] = alias
            return
        seen.add(key)
        parties.append({"name": name, "alias": alias, "role": role or _party_role(name, alias)})

    # 1) Definitionen: 'Name ... (the "Distributor")'
    last_end = 0
    for m in DEFINITION_RE.finditer(head[:4500]):
        alias = clean(m.group(1))
        segment = head[max(last_end, m.start() - 260): m.start()]
        last_end = m.end()
        if alias.lower() in SKIP_ALIASES:
            continue
        add(_entity_name(segment), alias)
    # 2) "acting through its management company X" / "vertreten durch die Verwaltungsgesellschaft X"
    for m in re.finditer(
        rf"(?:acting\s+through|represented\s+by|vertreten\s+durch)\s+(?:its|ihre|seine|die|the)?\s*(?:management\s+company|Verwaltungsgesellschaft)?\s*([A-Z][^,;()]{{2,90}}?{LEGAL_FORM})",
        head[:4500],
    ):
        add(_entity_name(m.group(1)), None, "management_company")
    # 3) Fallback ohne Definitionen: "between X and Y"
    if len(parties) < 2:
        m = re.search(r"(?:by\s+and\s+between|between|zwischen)\s+(.{3,160}?)\s+(?:and|und)\s+(.{3,160}?)(?:[;.(]|\s+dated|\s+vom|$)", head, re.I)
        if m:
            add(_entity_name(m.group(1)), None)
            add(_entity_name(m.group(2)), None)
    return parties[:6]


def extract_fees(text: str) -> list[str]:
    fees: list[str] = []
    for line in text.splitlines():
        l = clean(line)
        if re.search(r"\d+(?:[.,]\d+)?\s?%|\bbps\b|basis points|Basispunkte", l) and re.search(
            r"fee|commission|retrocession|trail|provision|vergütung|gebühr|12b-1|distribution|service|kickback|rebate|entgelt|bestandspflege",
            l, re.I,
        ):
            if l not in fees:
                fees.append(l[:300])
    return fees[:40]


RETRO_KW = (
    r"retro(?:cession|zession)s?|trail(?:\s+(?:fee|commission))?|bestande?s?(?:pflege)?(?:kommission|provision)|"
    r"vertriebs(?:entsch(?:ä|ae)digung|provision|verg(?:ü|ue)tung)|kickback|rebate|distribution\s+(?:and\s+service\s+)?fee|"
    r"12b-1|service\s+fee|commission\s+de\s+distribution"
)
RETRO_RE = re.compile(RETRO_KW, re.I)
RETRO_NEG_RE = re.compile(
    rf"(?:no|keine?|not\s+entitled\s+to\s+any|ohne)\s+(?:{RETRO_KW})[^.]{{0,80}}?"
    r"(?:on|for|für|auf|in)\s+((?:Class(?:es)?\s+[A-Z0-9-]+(?:\s*(?:,|and|und)\s*[A-Z0-9-]+)*)|[A-Z]{1,2}-?(?:Klassen|classes|shares|Anteile[n]?))",
    re.I,
)


CLASS_REF_RE = re.compile(r"\bClass(?:es)?\s+([A-Z][A-Z0-9]?(?:-\d)?)\b|\b([A-Z]{1,2})-(?:Klassen|Klasse|classes|Anteile[n]?|shares)\b")
RETRO_NEG_REV_RE = re.compile(
    rf"(?:für|for|on|auf)\s+((?:Class(?:es)?\s+[A-Z0-9-]+)|[A-Z]{{1,2}}-?(?:Klassen|classes|shares|Anteile[n]?))[^.]{{0,40}}?(?:keine?|no)\s+(?:{RETRO_KW})",
    re.I,
)


def _class_refs(s: str) -> list[str]:
    return [(m.group(1) or m.group(2)).upper() for m in CLASS_REF_RE.finditer(s)]


def extract_retrocession(text: str) -> dict:
    """Retrozessions-/Trail-Regelung des Vertrags (Satz, Satzhöhe, ausgenommene Klassen)."""
    t = clean(text)
    sentences = re.split(r"(?<=[.;])\s+(?=[A-ZÄÖÜ§0-9])", t)
    terms = [s_[:400] for s_ in sentences if RETRO_RE.search(s_) and re.search(r"\d+(?:[.,]\d+)?\s?%|basis points|bps|Basispunkte|management fee|Verwaltungs", s_, re.I)]
    rate = None
    for s_ in terms:
        m = re.search(r"(\d+(?:[.,]\d+)?\s?%(?:\s*(?:p\.?\s?a\.?|per annum))?(?:\s+(?:of|der|des)\s+(?:the\s+)?(?:management\s+fee|Verwaltungs\w+|mgmt\.?\s+fee|average\s+daily\s+net\s+assets))?)", s_, re.I)
        if m and not re.fullmatch(r"0+(?:[.,]0+)?\s?%", m.group(1).split()[0] + "%" if "%" not in m.group(1).split()[0] else m.group(1).split()[0]):
            rate = clean(m.group(1))
            break
    excluded: list[str] = []
    for m in list(RETRO_NEG_RE.finditer(t)) + list(RETRO_NEG_REV_RE.finditer(t)):
        grp = m.group(1)
        lm = re.match(r"([A-Z]{1,2})-?(?:Klassen|classes|shares|Anteile)", grp, re.I)
        if lm:
            excluded.append(lm.group(1).upper())
        else:
            excluded += [c.strip().upper() for c in re.split(r",|and|und", re.sub(r"Class(?:es)?\s+", "", grp)) if c.strip()]
    included = sorted({c for s_ in terms for c in _class_refs(s_)} - set(excluded))
    no_retro_at_all = bool(re.search(r"(?:no|keine?)\s+(?:retrocessions?|Retrozessionen?|trail commissions?)\s+(?:shall\s+be|will\s+be|werden|wird|is|are)\s+(?:paid|gezahlt|bezahlt|payable|geschuldet)", t, re.I)) and not rate
    agreed = True if rate else (False if no_retro_at_all else None)
    return {"agreed": agreed, "rate": rate, "included_classes": included, "excluded_classes": sorted(set(excluded)), "terms": terms[:10]}


def _fee_is_zero(fee: str | None) -> bool | None:
    if not fee:
        return None
    f = fee.strip().lower()
    if re.fullmatch(r"(?:none|keine?|nil|n/?a|-|–|0+(?:[.,]0+)?\s?%?)", f):
        return True
    if re.search(r"[1-9]", f) and ("%" in f or "bp" in f or "fee" in f):
        return False
    return None


def assign_class_retro(ex: "Extraction") -> None:
    r = ex.retrocession or {}
    excluded = set(r.get("excluded_classes") or [])
    included = set(r.get("included_classes") or [])

    def hit(base: str, group: set) -> bool:
        return bool(base) and (base in group or (len(base) <= 3 and base[:1] in group))

    for f in ex.funds:
        for sc in f.share_classes:
            zero = _fee_is_zero(sc.fee)
            base = (norm_class(sc.name or "").split() or [""])[0].upper()
            if zero is True:
                sc.retro = False
            elif zero is False:
                sc.retro = True
            elif hit(base, excluded):
                sc.retro = False
            elif included:
                sc.retro = True if hit(base, included) else None
            elif r.get("agreed") is True:
                sc.retro = True
            elif r.get("agreed") is False:
                sc.retro = False


def extract_notice(text: str) -> str | None:
    t = clean(text)
    m = re.search(
        r"(?:(\d{1,3})|(" + "|".join(NUMBER_WORDS) + r"))\s*(?:\((\d{1,3})\))?\s*(days?|months?|Tage[n]?|Monate[n]?)['’]?\s*(?:prior\s+)?(?:written\s+)?(?:notice|Kündigungsfrist|schriftlich)",
        t, re.I,
    )
    if m:
        n = m.group(1) or m.group(3) or str(NUMBER_WORDS.get(m.group(2).lower(), m.group(2)))
        unit = m.group(4).lower()
        unit = "Tage" if unit.startswith(("day", "tag")) else "Monate"
        return f"{n} {unit}"
    m = re.search(r"Kündigungsfrist\s+(?:von\s+)?(\d+)\s+(Tage|Monate|Monaten|Tagen)", t, re.I)
    if m:
        return f"{m.group(1)} {m.group(2).rstrip('n') if m.group(2).endswith('en') else m.group(2)}"
    return None


def extract_territory(text: str) -> list[str]:
    t = clean(text)
    windows = [m.start() for m in re.finditer(r"territor|countries|jurisdictions|Vertriebsländer|Vertriebsgebiet|Länder", t, re.I)]
    found: list[str] = []
    for c in COUNTRIES:
        for pos in windows:
            if re.search(rf"\b{re.escape(c)}\b", t[max(0, pos - 100): pos + 700]):
                n = COUNTRY_NORMAL.get(c, c)
                if n not in found:
                    found.append(n)
                break
    return found


def extract_signatories(text: str) -> list[str]:
    names: list[str] = []
    for m in re.finditer(r"/s/\s*([A-Z][A-Za-z.' -]{2,40}?)(?=\s{2,}|\n|\s+(?:Name|Title|By|[A-Z]{3,})|$)", text):
        n = clean(m.group(1))
        if n not in names:
            names.append(n)
    for m in re.finditer(r"(?:Name|Name/Funktion)\s*:\s*([A-Z][A-Za-z.'\- ]{2,40}?)(?=\s+(?:Title|Funktion|Name)\s*:|\n|$)", text):
        n = clean(m.group(1))
        if n not in names and len(n.split()) <= 5:
            names.append(n)
    return names[:12]


def extract_header_fields(text: str, ex: Extraction) -> None:
    t = clean(text)
    head = t[:3000]
    if re.search(r"amended\s+schedule|revised\s+schedule|schedule\s+a\b.{0,40}amended|amendment|nachtrag|änderungsvereinbarung", head, re.I):
        ex.document_type = "Amendment / Schedule"
    elif re.search(r"distribution\s+agreement|vertriebsvertrag|vertriebsvereinbarung|placement agreement|distribution and services agreement", head, re.I):
        ex.document_type = "Distribution Agreement"
    elif re.search(r"schedule\s+a", head, re.I):
        ex.document_type = "Schedule"
    m = re.search(
        r"((?:[A-Z0-9&.,'-]+\s+){0,10}(?:DISTRIBUTION|DISTRIBUTOR|VERTRIEBS|PLACEMENT|SUB-DISTRIBUTION)\s*(?:AND\s+[A-Z]+\s+)?(?:AGREEMENT|VERTRAG|VEREINBARUNG))",
        text,
    )
    ex.title = clean(m.group(1))[:200] if m else None
    ex.agreement_date = _first(
        rf"(?:dated\s+(?:as\s+of\s+)?|made\s+(?:as\s+of\s+)?(?:this\s+)?|vom\s+|Datum:?\s*|Date:\s*|as\s+of\s+)({DATE_RE})", t
    )
    ex.effective_date = _first(rf"(?:effective\s+(?:as\s+of\s+|date[:\s]+)?|in\s+kraft\s+(?:ab|am|per)\s+|wirksam\s+ab\s+)({DATE_RE})", t)
    if not ex.agreement_date:
        d = re.search(DATE_RE, head)
        ex.agreement_date = d.group(0) if d else None

    ex.governing_law = _first(
        r"(?:governed\s+by|construed\s+in\s+accordance\s+with|subject\s+to)\s+(?:and\s+construed\s+in\s+accordance\s+with\s+)?the\s+(?:internal\s+)?laws?\s+of\s+(?:the\s+)?((?:State|Commonwealth|Grand\s+Duchy)\s+of\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)",
        t, flags=re.S,
    ) or (lambda w: f"{w} Recht" if w else None)(_first(r"unterliegt\s+(?:dem\s+)?(\w+(?:em|en|es))\s+Recht", t)) or _first(r"(\w+(?:isches|sches))\s+Recht\s+(?:anwendbar|Anwendung)", t)
    ex.jurisdiction = _first(r"(?:courts?\s+of|Gerichtsstand\s+(?:ist\s+)?)\s*(?:the\s+)?([A-Z][\w-]+(?:\s+[A-Z][\w-]+)?)", t, flags=0)
    if re.search(r"non-?exclusive|nicht\s+exklusiv|nicht-exklusiv", t, re.I):
        ex.exclusivity = "nicht exklusiv"
    elif re.search(r"\bexclusive\b|exklusiv", t, re.I):
        ex.exclusivity = "exklusiv"
    ex.termination_notice = extract_notice(text)
    ex.term = _first(
        r"((?:shall\s+(?:continue|remain)\s+in\s+(?:full\s+)?(?:force|effect)|initial\s+term|unbestimmte\s+Zeit|auf\s+unbestimmte\s+Dauer)[^.]{0,200}\.)",
        t,
    )
    ex.parties = extract_parties(text)
    for p in ex.parties:
        key = p["role"]
        if key in ("fund_entity", "distributor", "management_company", "investment_adviser") and not getattr(ex, key):
            setattr(ex, key, p["name"])
    ex.fees = extract_fees(text)
    ex.retrocession = extract_retrocession(text)
    ex.territory = extract_territory(text)
    ex.signatories = extract_signatories(text)
    ex.isins = find_isins(text)
    ex.leis = find_leis(text)
    ex.sec_series_ids = sorted(set(SEC_SERIES_RE.findall(text)))
    ex.sec_class_ids = sorted(set(SEC_CLASS_RE.findall(text)))


# ---------------------------------------------------------------- Funds & Share Classes
def find_classes(s: str) -> list[str]:
    out: list[str] = []
    for m in CLASS_LIST_RE.finditer(s):
        for c in re.split(r"\s*(?:,|\band\b|\bund\b|&)\s*", m.group(1)):
            c = c.strip()
            if c and f"Class {c}" not in out:
                out.append(f"Class {c}")
    for m in CLASS_RE.finditer(s):
        c = clean(m.group(0))
        c = re.sub(r"^Share\s+", "", c)
        if c.lower() in {"class of", "class shares"} or re.fullmatch(r"(?:Class|Klasse)\s+(?:Of|The|Shares|Und|And)", c, re.I):
            continue
        if c not in out and not any(norm_class(c) == norm_class(o) for o in out):
            out.append(c)
    return out


def _fund_name_ok(name: str) -> bool:
    n = clean(name)
    low = n.lower()
    if low in FUND_GENERIC or len(n) < 6 or len(n) > 120:
        return False
    words = n.split()
    if len(words) < 2:
        return False
    if re.search(r"\b(?:shall|will|may|must|agreement|act|investment company|hereto|hereby|herein|pursuant|each|such|shares|class)\b", low):
        return False
    return True


def _strip_fund_lead(name: str) -> str:
    prev = None
    name = clean(name)
    while prev != name:
        prev = name
        name = FUND_LEAD_STRIP.sub("", name)
        name = re.sub(rf"^(?:\d+[,.]?|{MONTHS_EN}|{MONTHS_DE})\s+", "", name)
    return name


def _merge(funds: dict[str, FundEntry], entry: FundEntry) -> FundEntry:
    key = norm_fund(entry.name)
    if not key:
        return entry
    if key in funds:
        f = funds[key]
        f.all_classes = f.all_classes or entry.all_classes
        for sc in entry.share_classes:
            f.add_class(sc)
        if entry.source == "table":
            f.source = "table"
        return f
    funds[key] = entry
    return entry


def _cell(row: list, idx: int | None) -> str:
    if idx is None or idx >= len(row) or row[idx] is None:
        return ""
    return re.sub(r"-\n(?=[A-Z])", "-", str(row[idx]))


def funds_from_tables(pdf_bytes: bytes, funds: dict[str, FundEntry], ocr_pages: set[int]) -> int:
    rows_used = 0
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        header: dict[str, int | None] | None = None
        for pno, page in enumerate(pdf.pages, start=1):
            if pno in ocr_pages:
                continue
            for table in page.extract_tables():
                if not table or max(len(r) for r in table) < 2:
                    continue
                first = [clean(str(c or "")) for c in table[0]]
                cand = {
                    "fund": next((i for i, c in enumerate(first) if HEADER_FUND.search(c) and not HEADER_CLASS.search(c)), None),
                    "class": next((i for i, c in enumerate(first) if HEADER_CLASS.search(c)), None),
                    "isin": next((i for i, c in enumerate(first) if HEADER_ISIN.search(c)), None),
                    "fee": next((i for i, c in enumerate(first) if HEADER_FEE.search(c) and not HEADER_CLASS.search(c)), None),
                }
                body = table
                if cand["fund"] is not None and (cand["class"] is not None or cand["isin"] is not None):
                    header = cand
                    body = table[1:]
                if header is None:
                    continue  # Tabellen ohne erkennbaren Kopf übernimmt die Textanalyse
                last_fund: FundEntry | None = None
                for row in body:
                    fname = clean(_cell(row, header["fund"]))
                    classes_raw = _cell(row, header["class"])
                    isin_raw = _cell(row, header["isin"])
                    fee_raw = clean(_cell(row, header["fee"])) or None
                    if fname and not HEADER_FUND.fullmatch(fname):
                        last_fund = _merge(funds, FundEntry(name=fname, source="table"))
                    if last_fund is None:
                        continue
                    isins = find_isins(isin_raw) or find_isins(" ".join(str(c or "") for c in row))
                    class_lines = [clean(c) for c in classes_raw.split("\n") if clean(c)]
                    if ALL_CLASSES_RE.search(classes_raw):
                        last_fund.all_classes = True
                        class_lines = []
                    if isins:
                        for i, isin in enumerate(isins):
                            cname = class_lines[i] if i < len(class_lines) else (class_lines[0] if len(class_lines) == 1 else None)
                            last_fund.add_class(ShareClassEntry(cname, isin, class_currency(cname), fee_raw))
                    else:
                        fee_lines = (fee_raw or "").split(" ") if fee_raw and len(class_lines) > 1 else [fee_raw]
                        for i, cname in enumerate(class_lines):
                            fee = fee_lines[i] if i < len(fee_lines) else None
                            last_fund.add_class(ShareClassEntry(cname, None, class_currency(cname), fee))
                    rows_used += 1
    return rows_used


def funds_from_text(text: str, funds: dict[str, FundEntry]) -> None:
    known_isins = {sc.isin for f in funds.values() for sc in f.share_classes if sc.isin}
    lines = [clean(l) for l in text.splitlines()]
    in_schedule = False
    all_mode = False
    umbrella: str | None = None
    current: FundEntry | None = None
    group: list[FundEntry] = []
    for line in lines:
        if not line or line.startswith("[[Seite"):
            continue
        if re.search(r"\b(?:schedule|anhang|appendix|annex|exhibit)\s+[A-Z1-9]\b", line, re.I):
            in_schedule = True
        if ALL_CLASSES_RE.search(line):
            all_mode = True
        # Umbrella-Überschrift, z. B. "Highland Funds I:" oder "Alpenblick SICAV"
        um = re.fullmatch(r"([A-Z][\w&.' -]{2,60}?(?:Funds?\s+[IVX]+|SICAV|ICAV|Trust|FCP|plc))\s*[:–-]?", line)
        if um and not FUND_NAME_RE.fullmatch(line):
            umbrella = clean(um.group(1))
            current = None
            group = []
            continue

        all_isins = find_isins(line)
        isins = [i for i in all_isins if i not in known_isins]
        if all_isins and not isins:
            current, group = None, []
            continue  # Zeile stammt aus einer bereits ausgewerteten Tabelle
        classes = find_classes(line)
        names: list[str] = []
        # EU-Zeilenformat: "<Umbrella> – <Teilfonds>  <Klasse>  <ISIN>"
        if isins:
            before = line.split(isins[0])[0]
            if classes:
                cpos = before.find(classes[0])
                before = before[:cpos] if cpos > 0 else before
            before = re.sub(r"\s+\d+(?:[.,]\d+)?\s?%.*$", "", before).strip(" |;:-–")
            if len(before) >= 6 and re.search(r"[A-Za-z]{3}", before) and not CLASS_RE.fullmatch(before):
                names = [before]
        if not names:
            for m in FUND_NAME_RE.finditer(line):
                nm = _strip_fund_lead(m.group(1))
                if _fund_name_ok(nm):
                    names.append(nm)
        # komma-separierte Fondslisten (z. B. Fußnoten) nur außerhalb von Fließtext-Klauseln
        if names:
            group = []
            for nm in names:
                if re.search(r"\b(?:agreement|act|trust)\b", nm, re.I) and not re.search(r"fund|portfolio|teilfonds", nm, re.I):
                    continue
                e = FundEntry(name=nm, umbrella=umbrella, all_classes=all_mode)
                current = _merge(funds, e)
                group.append(current)
            if len(group) > 3:  # Fließtext-Aufzählung: Klassen nicht pauschal zuordnen
                group = []
                current = None
        prose = re.search(r"\b(?:authori[sz]ed|approved|shall|pursuant|may|will|soll|darf|wird)\b", line, re.I)
        if isins and current is not None:
            group = [current]
        if group and not isins and classes and not prose and (in_schedule or len(line) < 120):
            fm = re.search(r"(\d+(?:[.,]\d+)?\s?%)", line)
            for f in group:
                for cname in classes:
                    f.add_class(ShareClassEntry(cname, None, class_currency(cname), fm.group(1) if fm else None))
            continue
        if current is not None and isins:
            fee = None
            fm = re.search(r"(\d+(?:[.,]\d+)?\s?%)", line)
            if fm:
                fee = fm.group(1)
            if isins:
                for i, isin in enumerate(isins):
                    cname = classes[i] if i < len(classes) else None
                    current.add_class(ShareClassEntry(cname, isin, class_currency(cname), fee))
            elif in_schedule or len(line) < 120:
                for cname in classes:
                    current.add_class(ShareClassEntry(cname, None, class_currency(cname), fee))


def extract_document(text: str, pdf_bytes: bytes | None = None, ocr_pages: set[int] | None = None) -> Extraction:
    ex = Extraction()
    extract_header_fields(text, ex)
    funds: dict[str, FundEntry] = {}
    if pdf_bytes:
        try:
            funds_from_tables(pdf_bytes, funds, ocr_pages or set())
        except Exception as exc:
            ex.warnings.append(f"Tabellenerkennung fehlgeschlagen: {exc}")
    funds_from_text(text, funds)
    # Funds, deren Name nur Teil eines längeren Namens ist, zusammenführen
    keys = sorted(funds, key=len, reverse=True)
    for k in keys:
        f = funds.get(k)
        if f is None:
            continue
        for other in list(funds):
            if other != k and other in funds and len(other) < len(k) and re.search(rf"(?:^| ){re.escape(other)}$", k) and not funds[other].share_classes and f.source == "table":
                f.all_classes = f.all_classes or funds[other].all_classes
                del funds[other]
    # Zeilenumbruch-Fragmente ("Mid Cap Value Fund") in den vollständigen Namen einfügen
    for m in FUND_NAME_RE.finditer(clean(text)):
        full = _strip_fund_lead(m.group(1))
        fk = norm_fund(full)
        if _fund_name_ok(full) and fk not in funds and any(fk.endswith(" " + k) for k in funds):
            frag = next(k for k in funds if fk.endswith(" " + k))
            if funds[frag].source == "text":
                old = funds.pop(frag)
                old.name = full
                funds[fk] = old
    for k in sorted(funds, key=len):
        if k not in funds:
            continue
        longer = [o for o in funds if o != k and len(o) > len(k) and o.endswith(" " + k)]
        if longer and funds[k].source == "text":
            target = funds[longer[0]]
            if not target.share_classes:
                for sc in funds[k].share_classes:
                    target.add_class(sc)
            target.all_classes = target.all_classes or funds[k].all_classes
            del funds[k]
    # Vertrag gilt nur für bestimmte Klassen ("CLASS A SHARES DISTRIBUTION AGREEMENT")
    doc_classes = re.findall(r"\bCLASS\s+([A-Z0-9-]{1,4})\s+SHARES\b", text[:3000])
    if doc_classes:
        for f in funds.values():
            if not f.share_classes and not f.all_classes:
                for c in dict.fromkeys(doc_classes):
                    f.add_class(ShareClassEntry(f"Class {c}"))
    # Klassen-Dubletten ohne ISIN entfernen, wenn eine gleichnamige Klasse mit ISIN existiert
    for f in funds.values():
        named_with_isin = {norm_class(sc.name) for sc in f.share_classes if sc.isin and sc.name}
        f.share_classes = [sc for sc in f.share_classes if sc.isin or not sc.name or norm_class(sc.name) not in named_with_isin]
    ex.funds = list(funds.values())
    assign_class_retro(ex)
    if not ex.fund_entity:
        m = re.search(r"^\s*([A-Z][A-Z0-9 .&,'-]{3,60}?\s(?:TRUST|FUNDS?(?:\s+[IVX]+)?|SICAV|ICAV|PLC))\s*\d?\s*$", text, re.M)
        umbrellas = sorted({f.umbrella for f in ex.funds if f.umbrella})
        if m:
            ex.fund_entity = clean(m.group(1)).title() if m.group(1).isupper() else clean(m.group(1))
        elif umbrellas:
            ex.fund_entity = ", ".join(umbrellas)
    # ISINs, die keinem Fund zugeordnet werden konnten
    assigned = {sc.isin for f in ex.funds for sc in f.share_classes if sc.isin}
    orphan = [i for i in ex.isins if i not in assigned]
    if orphan:
        ex.warnings.append(f"{len(orphan)} ISIN(s) ohne Fund-Zuordnung: {', '.join(orphan[:10])}")
    if not ex.funds:
        ex.warnings.append("Keine Funds erkannt – bitte Dokument manuell prüfen.")
    if not ex.parties:
        ex.warnings.append("Vertragsparteien nicht erkannt (evtl. nur Schedule/Anhang).")
    return ex
