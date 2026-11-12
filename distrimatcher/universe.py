"""Öffentliche Referenzdaten für das Fonds-/Share-Class-Universum.

Quellen:
* SEC "Investment Company Series and Class Information" (US-Fonds):
  Series ID = Fund-ID, Class ID + Ticker = Share Class.
* GLEIF (weltweit, v. a. EU-Fonds): LEI je (Teil-)Fonds und die dort gemeldeten ISINs.
* OpenFIGI: Anreicherung/Prüfung einzelner ISINs (Name, Ticker, Typ).
* CSV/XLSX-Import: eigene oder lizenzierte Listen (z. B. Fondsliste der KVG, WM-/fundinfo-Export).

Es werden ausschließlich Fonds-/Firmennamen bzw. ISINs abgefragt – niemals Vertragsinhalte.
"""
from __future__ import annotations

import csv
import io
import os
import re
import time
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher
from pathlib import Path

import httpx

from .extract import class_currency, norm_fund
from .identifiers import is_valid_isin

USER_AGENT = os.environ.get("DISTRIMATCHER_USER_AGENT", "Distrimatcher/0.1 (fund-coverage-analysis; contact: it@example.org)")
SEC_DATASET = "https://www.sec.gov/files/investment/data/other/investment-company-series-class-information/investment-company-series-class-{year}.csv"
GLEIF_API = "https://api.gleif.org/api/v1"
OPENFIGI_API = "https://api.openfigi.com/v3/mapping"


@dataclass
class UniverseRecord:
    source: str
    umbrella: str | None
    fund_id: str | None
    fund_name: str
    class_id: str | None = None
    class_name: str | None = None
    isin: str | None = None
    ticker: str | None = None
    lei: str | None = None
    currency: str | None = None
    retro: str | None = None  # "yes" / "no" / rate (e.g. "0.40%") – from the data source
    origin: str | None = None  # where the record was found ("Fundstelle")
    origin_url: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def online_enabled() -> bool:
    return os.environ.get("DISTRIMATCHER_OFFLINE", "0") not in ("1", "true", "yes")


def _client() -> httpx.Client:
    if not online_enabled():
        raise RuntimeError("Offline mode active (DISTRIMATCHER_OFFLINE=1) – no online lookups.")
    return httpx.Client(headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"}, timeout=60, follow_redirects=True)


# ------------------------------------------------------------------ SEC
def sec_dataset_path(cache_dir: Path, year: int | None = None) -> Path:
    """Lädt (einmalig) den SEC-Series/Class-Datensatz und cached ihn lokal."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    existing = sorted(cache_dir.glob("sec_series_class_*.csv"))
    fresh = [p for p in existing if time.time() - p.stat().st_mtime < 30 * 86400]
    if fresh and year is None:
        return fresh[-1]
    years = [year] if year else [time.gmtime().tm_year, time.gmtime().tm_year - 1]
    with _client() as c:
        for y in years:
            r = c.get(SEC_DATASET.format(year=y))
            if r.status_code == 200 and r.content[:200].lower().find(b"series id") >= 0:
                path = cache_dir / f"sec_series_class_{y}.csv"
                path.write_bytes(r.content)
                return path
    if existing:
        return existing[-1]
    raise RuntimeError("SEC dataset not available")


_SEC_CACHE: dict[tuple[str, float], list[dict]] = {}


def _read_sec(path: Path) -> list[dict]:
    key = (str(path), path.stat().st_mtime)
    if key not in _SEC_CACHE:
        _SEC_CACHE.clear()
        with path.open(encoding="utf-8-sig", errors="replace", newline="") as fh:
            rows = list(csv.DictReader(fh))
        for r in rows:  # Normalisierung einmalig vorberechnen
            r["_n"] = norm_fund(r.get("Entity Name") or "")
            r["_s"] = norm_fund(r.get("Series Name") or "")
        _SEC_CACHE[key] = rows
    return _SEC_CACHE[key]


def sec_search_entities(path: Path, query: str, limit: int = 15) -> list[dict]:
    """Sucht Registranten über den Entity-Namen oder über einen enthaltenen Fund-(Series-)Namen."""
    q = norm_fund(query)
    if not q:
        return []
    found: dict[str, dict] = {}
    fuzzy_cache: dict[str, float] = {}
    for row in _read_sec(path):
        cik = row.get("CIK Number") or ""
        name = row.get("Entity Name") or ""
        e = found.get(cik)
        if e:
            e["classes"] += 1
        n, series = row["_n"], row["_s"]
        if q == n:
            score, how = 1.0, "Registrant"
        elif q == series:
            score, how = 0.97, f"Fund: {row.get('Series Name')}"
        elif f" {q} " in f" {n} ":
            score, how = 0.9, "Registrant"
        elif len(q.split()) >= 2 and f" {q} " in f" {series} ":
            score, how = 0.85, f"Fund: {row.get('Series Name')}"
        else:
            if n not in fuzzy_cache:
                fuzzy_cache[n] = SequenceMatcher(None, q, n).ratio()
            score, how = fuzzy_cache[n], "ähnlicher Name"
            if score < 0.75:
                continue
        if not e:
            e = found[cik] = {"cik": cik, "entity_name": name, "score": 0, "classes": 1, "match": how}
        if score > e["score"]:
            e["score"], e["match"] = round(score, 3), how
    return sorted(found.values(), key=lambda d: (-d["score"], d["entity_name"]))[:limit]


def sec_load_entity(path: Path, cik: str) -> list[UniverseRecord]:
    cik = cik.zfill(10)
    out = []
    for row in _read_sec(path):
        if (row.get("CIK Number") or "").zfill(10) != cik:
            continue
        out.append(
            UniverseRecord(
                source="SEC",
                umbrella=row.get("Entity Name"),
                fund_id=row.get("Series ID"),
                fund_name=row.get("Series Name") or row.get("Entity Name") or "",
                class_id=row.get("Class ID"),
                class_name=row.get("Class Name"),
                ticker=row.get("Class Ticker") or None,
                currency="USD",
                origin=f"SEC series/class dataset ({path.stem.rsplit('_', 1)[-1]}) · {row.get('Entity Name')} · "
                       f"{row.get('Series ID')} {row.get('Series Name')} · {row.get('Class ID')} {row.get('Class Name')}",
                origin_url=f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type=485&dateb=&owner=include&count=40",
            )
        )
    return out


# ------------------------------------------------------------------ GLEIF
def gleif_find_fund(name: str, client: httpx.Client | None = None) -> list[dict]:
    own = client is None
    client = client or _client()
    try:
        r = client.get(
            f"{GLEIF_API}/lei-records",
            params={"filter[fulltext]": name, "filter[entity.category]": "FUND", "page[size]": 10},
        )
        r.raise_for_status()
        hits = []
        qn = norm_fund(name)
        for rec in r.json().get("data", []):
            ent = rec["attributes"]["entity"]
            legal = ent["legalName"]["name"]
            score = SequenceMatcher(None, qn, norm_fund(legal)).ratio()
            hits.append({"lei": rec["id"], "name": legal, "score": round(score, 3), "status": ent.get("status"),
                         "jurisdiction": ent.get("jurisdiction")})
        return sorted(hits, key=lambda h: -h["score"])
    finally:
        if own:
            client.close()


def gleif_isins(lei: str, client: httpx.Client) -> list[str]:
    isins: list[str] = []
    page = 1
    while page <= 20:
        r = client.get(f"{GLEIF_API}/lei-records/{lei}/isins", params={"page[size]": 200, "page[number]": page})
        if r.status_code != 200:
            break
        data = r.json()
        isins += [d["attributes"]["isin"] for d in data.get("data", [])]
        if page >= data.get("meta", {}).get("pagination", {}).get("lastPage", 1):
            break
        page += 1
    return isins


def gleif_load_funds(fund_names: list[str], umbrella: str | None = None, min_score: float = 0.85) -> tuple[list[UniverseRecord], list[dict]]:
    """Sucht zu jedem Fund-Namen die LEI und lädt die bei GLEIF gemeldeten ISINs."""
    records: list[UniverseRecord] = []
    report: list[dict] = []
    with _client() as c:
        for name in fund_names:
            hits = gleif_find_fund(name, c)
            best = hits[0] if hits and hits[0]["score"] >= min_score else None
            if not best:
                report.append({"fund": name, "lei": None, "isins": 0, "note": "no LEI found"})
                continue
            isins = gleif_isins(best["lei"], c)
            report.append({"fund": name, "lei": best["lei"], "gleif_name": best["name"], "isins": len(isins)})
            origin = f"GLEIF LEI record {best['lei']} · {best['name']}"
            url = f"https://search.gleif.org/#/record/{best['lei']}"
            if not isins:
                records.append(UniverseRecord("GLEIF", umbrella, best["lei"], best["name"], lei=best["lei"], origin=origin, origin_url=url))
            for isin in isins:
                records.append(UniverseRecord("GLEIF", umbrella, best["lei"], best["name"], isin=isin, lei=best["lei"],
                                              origin=f"{origin} · ISIN {isin}", origin_url=url))
    return records, report


# ------------------------------------------------------------------ OpenFIGI
def openfigi_enrich(isins: list[str], api_key: str | None = None) -> dict[str, dict]:
    """ISIN -> {name, ticker, securityType, exchCode}. Ohne API-Key max. 10 ISINs je Request."""
    api_key = api_key or os.environ.get("OPENFIGI_API_KEY")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["X-OPENFIGI-APIKEY"] = api_key
    batch = 100 if api_key else 10
    out: dict[str, dict] = {}
    with _client() as c:
        for i in range(0, len(isins), batch):
            chunk = isins[i: i + batch]
            r = c.post(OPENFIGI_API, json=[{"idType": "ID_ISIN", "idValue": x} for x in chunk], headers=headers)
            if r.status_code == 429:
                time.sleep(7)
                r = c.post(OPENFIGI_API, json=[{"idType": "ID_ISIN", "idValue": x} for x in chunk], headers=headers)
            r.raise_for_status()
            for isin, res in zip(chunk, r.json()):
                d = (res.get("data") or [{}])[0]
                if d:
                    out[isin] = {k: d.get(k) for k in ("name", "ticker", "securityType", "securityType2", "exchCode")}
    return out


# ------------------------------------------------------------------ CSV/XLSX-Import
COLUMN_ALIASES = {
    "umbrella": ["umbrella", "dachfonds", "sicav", "registrant", "entity", "entity name", "fondsgesellschaft", "trust"],
    "fund_id": ["fund_id", "fund id", "fonds-id", "fondsid", "series id", "lei", "fund lei", "teilfonds-id", "subfund id"],
    "fund_name": ["fund_name", "fund name", "fund", "fonds", "fondsname", "teilfonds", "sub-fund", "subfund", "series name", "compartment"],
    "class_id": ["class_id", "class id", "share class id"],
    "class_name": ["share_class", "share class", "class name", "class", "anteilsklasse", "anteilklasse", "klasse"],
    "isin": ["isin", "isin code"],
    "ticker": ["ticker", "class ticker", "bloomberg ticker"],
    "currency": ["currency", "ccy", "währung", "waehrung", "class currency"],
    "retro": ["retro", "retrocession", "retrocessions", "retrozession", "retrozessionen", "retro (ja/nein)", "trail",
              "trail fee", "trail commission", "bestandespflegekommission", "bestandespflege", "bestandsprovision",
              "vertriebsentschädigung", "distribution fee", "kickback"],
}


def parse_retro(value: str | None) -> str | None:
    """Normalisiert Retro-Angaben aus Importen: ja / nein / Satz."""
    if value is None:
        return None
    v = str(value).strip().lower()
    if not v:
        return None
    if v in {"ja", "yes", "y", "j", "true", "wahr", "1", "x", "✓"}:
        return "yes"
    if v in {"nein", "no", "n", "false", "falsch", "0", "-", "none", "keine", "clean", "0%", "0.00%", "0,00%"}:
        return "no"
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*(%|bp|bps)?", v)
    if m:
        num = float(m.group(1).replace(",", "."))
        if num == 0:
            return "no"
        unit = m.group(2) or "%"
        return f"{m.group(1)}{'%' if unit == '%' else ' bp'}"
    return str(value).strip()


# Heuristik nach Klassenbezeichnung (nur als Vermutung, klar gekennzeichnet)
NO_RETRO_HINTS = re.compile(r"\b(?:clean|no\s*retro|nr|institutional|inst|ohne\s+retro)\b", re.I)
NO_RETRO_LETTERS = {"I", "IA", "IB", "Z", "Q", "N", "X", "S", "J", "UB", "EB", "M", "F", "K", "R6", "Y"}
RETRO_LETTERS = {"A", "B", "C", "P", "R", "RA", "RB", "INV", "INVESTOR", "RETAIL", "T", "AA", "AD"}


def guess_retro(class_name: str | None) -> str | None:
    if not class_name:
        return None
    if NO_RETRO_HINTS.search(class_name):
        return "no"
    s = re.sub(r"^.*\(((?:Share\s+)?Class[^)]*)\)\s*$", r"\1", class_name.strip())
    s = re.sub(r"\b(?:Share|Shares|Class|Klasse|Anteilsklasse)\b", " ", s, flags=re.I)
    tok = (s.replace("-", "").split() or [""])[0].upper()
    if tok in NO_RETRO_LETTERS:
        return "no"
    if tok in RETRO_LETTERS:
        return "yes"
    return None


def _map_columns(header: list[str]) -> dict[str, int]:
    norm = [h.strip().lower().replace("_", " ") for h in header]
    mapping: dict[str, int] = {}
    for field, aliases in COLUMN_ALIASES.items():
        for a in aliases:
            a2 = a.replace("_", " ")
            if a2 in norm:
                mapping[field] = norm.index(a2)
                break
    return mapping


def import_table(filename: str, data: bytes, source: str = "Import") -> tuple[list[UniverseRecord], list[str]]:
    rows: list[list[str]]
    if filename.lower().endswith((".xlsx", ".xlsm")):
        import openpyxl

        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        ws = wb.worksheets[0]
        rows = [["" if v is None else str(v) for v in r] for r in ws.iter_rows(values_only=True)]
    else:
        text = data.decode("utf-8-sig", errors="replace")
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t") if text.strip() else csv.excel
        rows = list(csv.reader(io.StringIO(text), dialect))
    rows = [r for r in rows if any(c.strip() for c in r)]
    if not rows:
        return [], ["File is empty"]
    m = _map_columns(rows[0])
    warnings = []
    if "fund_name" not in m and "isin" not in m:
        return [], [f"Columns not recognised. Need at least 'Fund Name' or 'ISIN'. Found: {rows[0]}"]

    def g(r, f):
        i = m.get(f)
        return r[i].strip() if i is not None and i < len(r) and r[i].strip() else None

    out = []
    for n, r in enumerate(rows[1:], start=2):
        isin = (g(r, "isin") or "").upper() or None
        if isin and not is_valid_isin(isin):
            warnings.append(f"Row {n}: invalid ISIN {isin}")
        fund = g(r, "fund_name") or g(r, "umbrella") or isin or "?"
        cname = g(r, "class_name")
        out.append(UniverseRecord(source, g(r, "umbrella"), g(r, "fund_id"), fund, g(r, "class_id"), cname, isin,
                                  g(r, "ticker"), g(r, "fund_id") if re.fullmatch(r"[A-Z0-9]{20}", g(r, "fund_id") or "") else None,
                                  g(r, "currency") or class_currency(cname), parse_retro(g(r, "retro")),
                                  origin=f"{filename}, row {n}: " + " | ".join(c.strip() for c in r if c and c.strip())[:300]))
    return out, warnings[:50]


def class_features(class_name: str | None, currency: str | None = None, retro: str | None = None) -> list[dict]:
    """Heuristic share class characteristics shown as tags (e.g. Institutional, CHF, Clean share)."""
    n = (class_name or "")
    low = n.lower()
    tags: list[dict] = []
    base = (re.sub(r"\b(?:share|shares|class|klasse|anteilsklasse)\b", " ", re.sub(r"^.*\(([^)]*)\)\s*$", r"\1", n), flags=re.I)
            .replace("-", "").split() or [""])[0].upper()
    if re.search(r"\bclean\b|no\s*retro|ohne\s+retro", low) or retro == "no" and base not in NO_RETRO_LETTERS:
        tags.append({"label": "Clean share", "kind": "warn"})
    if re.search(r"institutional|\binst\b", low) or base in {"I", "IA", "IB", "J", "Z", "S", "X", "INST"}:
        tags.append({"label": "Institutional", "kind": ""})
    elif base in {"A", "B", "C", "P", "R", "RA", "RB", "INV", "INVESTOR", "RETAIL", "T"}:
        tags.append({"label": "Retail", "kind": ""})
    if re.search(r"hedged|\bh\b|hdg|gesichert", low):
        tags.append({"label": "Currency hedged", "kind": ""})
    ccy = currency or class_currency(n)
    if ccy:
        tags.append({"label": ccy, "kind": ""})
    if re.search(r"\bdis\b|distribut|aussch", low):
        tags.append({"label": "Distributing", "kind": ""})
    elif re.search(r"\bacc\b|accumul|thes", low):
        tags.append({"label": "Accumulating", "kind": ""})
    return tags
