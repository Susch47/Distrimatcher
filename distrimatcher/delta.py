"""Abgleich: Vertragsabdeckung (aus den Agreements) vs. öffentliches Universum -> Delta."""
from __future__ import annotations

import re
from collections import defaultdict
from difflib import SequenceMatcher

from .extract import clean, norm_class, norm_fund
from .universe import guess_retro

COVERED = "abgedeckt"
NOT_COVERED = "nicht abgedeckt"
CHECK = "prüfen"
MATCH_THRESHOLD = 0.86


def name_score(a: str, b: str) -> float:
    na, nb = norm_fund(a), norm_fund(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    ta, tb = set(na.split()), set(nb.split())
    jacc = len(ta & tb) / len(ta | tb)
    seq = SequenceMatcher(None, " ".join(sorted(ta)), " ".join(sorted(tb))).ratio()
    contain = 0.93 if (f" {na} " in f" {nb} " or f" {nb} " in f" {na} ") and min(len(ta), len(tb)) >= 2 else 0
    return round(max(seq * 0.6 + jacc * 0.4, contain), 3)


CLASS_SYNONYMS = {"institutional": "i", "inst": "i", "retail": "r", "investor": "inv", "advisor": "adv", "adviser": "adv",
                  "thesaurierend": "acc", "accumulating": "acc", "ausschüttend": "dis", "distributing": "dis", "hdg": "hedged", "h": "hedged"}


def canonical_class(name: str) -> str:
    """'JNL Government Money Market Fund (Class I)' -> 'i'; 'Institutional Class' -> 'i'."""
    s = clean(name)
    m = re.search(r"\(((?:Share\s+)?Class[^)]*|[^)]*Shares?)\)\s*$", s)
    if m:
        s = m.group(1)
    s = re.sub(r"^.*?\b(?:Fund|Portfolio|ETF)\b\s*[-–:]?\s*", "", s) if re.search(r"\b(?:Fund|Portfolio|ETF)\b.+", s) else s
    toks = [CLASS_SYNONYMS.get(t, t) for t in norm_class(s).split()]
    return " ".join(toks)


def class_matches(universe_class: str | None, covered_class: str | None) -> bool:
    if not universe_class or not covered_class:
        return False
    a, b = canonical_class(universe_class), canonical_class(covered_class)
    if a == b:
        return True
    # Gleiche Klassenbasis; Währung, Hedging und Ertragsverwendung dürfen sich nicht widersprechen
    ta, tb = a.split(), b.split()
    if not ta or not tb or ta[0] != tb[0]:
        return False

    def attrs(t: list[str]) -> dict:
        return {
            "ccy": next((x for x in t if x.upper() in CCYS), None),
            "hedged": "hedged" in t,
            "use": next((x for x in t if x in ("acc", "dis", "inc")), None),
            "other": {x for x in t[1:] if x.upper() not in CCYS and x not in ("hedged", "acc", "dis", "inc")},
        }

    x, y = attrs(ta), attrs(tb)
    if x["hedged"] != y["hedged"] or x["other"] != y["other"]:
        return False
    if x["ccy"] and y["ccy"] and x["ccy"] != y["ccy"]:
        return False
    if x["use"] and y["use"] and x["use"] != y["use"]:
        return False
    return True


CCYS = {"EUR", "USD", "CHF", "GBP", "JPY", "SEK", "NOK", "DKK", "AUD", "CAD", "SGD", "HKD"}


def retro_status(universe_class: dict, contract_retro: list[bool]) -> tuple[str | None, str | None]:
    """Retro-Status einer Klasse: Datenquelle > Vertrag > Vermutung (Klassenname)."""
    if universe_class.get("retro"):
        return universe_class["retro"], "Daten"
    if contract_retro:
        return ("ja" if any(contract_retro) else "nein"), "Vertrag"
    g = guess_retro(universe_class.get("class_name"))
    return (g, "Vermutung") if g else (None, None)


def coverage_from_documents(docs: list[dict]) -> list[dict]:
    """Flacht alle Extraktionen zu Coverage-Einträgen ab (ein Eintrag je Fund und Dokument)."""
    out = []
    for d in docs:
        ex = d.get("extraction") or {}
        for f in ex.get("funds", []):
            out.append({
                "doc_id": d["id"],
                "doc_name": d["filename"],
                "agreement_date": ex.get("agreement_date"),
                "distributor": ex.get("distributor"),
                "fund_entity": ex.get("fund_entity"),
                "fund_name": f["name"],
                "umbrella": f.get("umbrella"),
                "all_classes": f.get("all_classes", False),
                "share_classes": f.get("share_classes", []),
            })
    return out


def _phrase_in(text_norm: str, fund_name: str) -> bool:
    n = norm_fund(fund_name)
    return len(n.split()) >= 2 and f" {n} " in text_norm


def build_overview(universe: list[dict], docs: list[dict]) -> dict:
    coverage = coverage_from_documents(docs)
    doc_text_norm = {d["id"]: " " + norm_fund(d.get("text") or "") + " " for d in docs}
    isin_cov: dict[str, list[dict]] = defaultdict(list)
    for c in coverage:
        for sc in c["share_classes"]:
            if sc.get("isin"):
                isin_cov[sc["isin"]].append(c)

    # Universum nach Fund gruppieren
    funds: dict[tuple, dict] = {}
    for r in universe:
        key = (r.get("umbrella") or "", r.get("fund_id") or r["fund_name"])
        f = funds.setdefault(key, {
            "umbrella": r.get("umbrella"), "fund_id": r.get("fund_id"), "fund_name": r["fund_name"],
            "sources": set(), "classes": [],
        })
        f["sources"].add(r["source"])
        if r.get("class_name") or r.get("isin") or r.get("class_id"):
            f["classes"].append(r)

    used_coverage: set[int] = set()
    result_funds = []
    for key, f in sorted(funds.items(), key=lambda kv: (kv[0][0], kv[1]["fund_name"])):
        # 1) Fund-Match über ISIN, 2) über Namen, 3) Volltextsuche im Vertrag
        matches: dict[int, dict] = {}
        for cl in f["classes"]:
            for c in isin_cov.get(cl.get("isin") or "", []):
                matches[id(c)] = {"cov": c, "score": 1.0, "how": "ISIN"}
        for c in coverage:
            if id(c) in matches:
                continue
            s = name_score(f["fund_name"], c["fund_name"])
            if s >= MATCH_THRESHOLD:
                matches[id(c)] = {"cov": c, "score": s, "how": "Name"}
        fulltext_docs = []
        if not matches:
            fulltext_docs = [d for d in docs if _phrase_in(doc_text_norm[d["id"]], f["fund_name"])]
        used_coverage.update(matches)

        classes_out = []
        for cl in f["classes"] or [{"class_name": None, "isin": None}]:
            status, via, docs_hit, contract_retro = NOT_COVERED, None, [], []
            for m in matches.values():
                c = m["cov"]
                hit, sc_hit = None, None
                sc_hit = next((sc for sc in c["share_classes"] if cl.get("isin") and sc.get("isin") == cl["isin"]), None)
                if sc_hit:
                    hit = "ISIN"
                elif c["all_classes"]:
                    hit = "alle Klassen"
                else:
                    sc_hit = next((sc for sc in c["share_classes"] if class_matches(cl.get("class_name"), sc.get("name"))
                                   and not (sc.get("isin") and cl.get("isin") and sc["isin"] != cl["isin"])), None)
                    hit = "Klassenname" if sc_hit else None
                if hit:
                    status, via = COVERED, hit
                    docs_hit.append(c["doc_name"])
                    if sc_hit and sc_hit.get("retro") is not None:
                        contract_retro.append(sc_hit["retro"])
            if status != COVERED and (any(not m["cov"]["share_classes"] and not m["cov"]["all_classes"] for m in matches.values()) or fulltext_docs):
                status, via = CHECK, "Fund genannt, Klassen nicht spezifiziert" if matches else "Fund nur im Volltext gefunden"
                docs_hit = [m["cov"]["doc_name"] for m in matches.values()] or [d["filename"] for d in fulltext_docs]
            retro, basis = retro_status(cl, contract_retro)
            classes_out.append({
                "class_name": cl.get("class_name"), "class_id": cl.get("class_id"), "isin": cl.get("isin"),
                "ticker": cl.get("ticker"), "currency": cl.get("currency"), "source": cl.get("source"),
                "status": status, "via": via, "documents": sorted(set(docs_hit)),
                "retro": retro, "retro_basis": basis, "pays_retro": None if retro is None else retro != "nein",
            })
        n_cov = sum(1 for c in classes_out if c["status"] == COVERED)
        result_funds.append({
            "umbrella": f["umbrella"], "fund_id": f["fund_id"], "fund_name": f["fund_name"],
            "sources": sorted(f["sources"]),
            "matched_agreements": sorted({m["cov"]["doc_name"] for m in matches.values()} | {d["filename"] for d in fulltext_docs}),
            "match": max((m["score"] for m in matches.values()), default=0.8 if fulltext_docs else 0.0),
            "match_how": sorted({m["how"] for m in matches.values()}) or (["Volltext"] if fulltext_docs else []),
            "classes": classes_out,
            "covered": n_cov,
            "total": len(classes_out),
            "delta": sum(1 for c in classes_out if c["status"] == NOT_COVERED),
            "check": sum(1 for c in classes_out if c["status"] == CHECK),
        })

    # Vertragseinträge ohne Gegenstück im Universum (z. B. Universum noch nicht geladen)
    unmatched = [
        {"fund_name": c["fund_name"], "doc_name": c["doc_name"], "share_classes": c["share_classes"], "all_classes": c["all_classes"]}
        for c in coverage if id(c) not in used_coverage
    ]
    totals = {
        "funds": len(result_funds),
        "classes": sum(f["total"] for f in result_funds),
        "covered": sum(f["covered"] for f in result_funds),
        "delta": sum(f["delta"] for f in result_funds),
        "check": sum(f["check"] for f in result_funds),
        "funds_without_agreement": sum(1 for f in result_funds if not f["matched_agreements"]),
        "agreement_funds_not_in_universe": len(unmatched),
        "retro_classes": sum(1 for f in result_funds for c in f["classes"] if c["pays_retro"]),
        "retro_delta": sum(1 for f in result_funds for c in f["classes"] if c["pays_retro"] and c["status"] == NOT_COVERED),
        "retro_unknown": sum(1 for f in result_funds for c in f["classes"] if c["pays_retro"] is None),
    }
    umbrellas: dict[str, list] = defaultdict(list)
    for f in result_funds:
        umbrellas[f["umbrella"] or "(ohne Umbrella)"].append(f)
    return {
        "totals": totals,
        "umbrellas": [{"name": k, "funds": v} for k, v in umbrellas.items()],
        "unmatched_agreement_funds": unmatched,
    }


def coverage_only_overview(docs: list[dict]) -> list[dict]:
    """Übersicht nur aus den Verträgen (ohne Universum): Fund -> Klassen mit Quellen."""
    agg: dict[str, dict] = {}
    for c in coverage_from_documents(docs):
        k = norm_fund(c["fund_name"])
        f = agg.setdefault(k, {"fund_name": c["fund_name"], "umbrella": c["umbrella"] or c["fund_entity"], "all_classes": False,
                               "classes": {}, "documents": set()})
        f["all_classes"] |= bool(c["all_classes"])
        f["documents"].add(c["doc_name"])
        for sc in c["share_classes"]:
            ck = sc.get("isin") or norm_class(sc.get("name") or "")
            e = f["classes"].setdefault(ck, {"name": sc.get("name"), "isin": sc.get("isin"), "fee": sc.get("fee"),
                                             "retro": sc.get("retro"), "documents": set()})
            e["documents"].add(c["doc_name"])
    out = []
    for f in sorted(agg.values(), key=lambda x: ((x["umbrella"] or ""), x["fund_name"])):
        out.append({**f, "documents": sorted(f["documents"]),
                    "classes": [{**v, "documents": sorted(v["documents"])} for v in f["classes"].values()]})
    return out
