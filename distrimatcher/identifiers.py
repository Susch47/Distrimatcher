"""Erkennung und Prüfziffern-Validierung von Wertpapier- und Firmen-IDs."""
from __future__ import annotations

import re

ISIN_RE = re.compile(r"\b([A-Z]{2}[A-Z0-9]{9}[0-9])\b")
LEI_RE = re.compile(r"\b([A-Z0-9]{18}[0-9]{2})\b")
SEC_SERIES_RE = re.compile(r"\b(S0000\d{5})\b")
SEC_CLASS_RE = re.compile(r"\b(C0000\d{5}|C000\d{6})\b")


def _char_value(c: str) -> str:
    return c if c.isdigit() else str(ord(c) - 55)


def isin_check_digit(body11: str) -> int:
    """Prüfziffer für die ersten 11 Zeichen einer ISIN (Luhn über die Ziffernfolge)."""
    digits = "".join(_char_value(c) for c in body11.upper())
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch)
        if i % 2 == 0:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return (10 - total % 10) % 10


def is_valid_isin(code: str) -> bool:
    code = code.strip().upper()
    if not re.fullmatch(r"[A-Z]{2}[A-Z0-9]{9}[0-9]", code):
        return False
    return isin_check_digit(code[:11]) == int(code[11])


def make_isin(country: str, nsin9: str) -> str:
    body = (country + nsin9).upper()
    return body + str(isin_check_digit(body))


def is_valid_lei(code: str) -> bool:
    code = code.strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{18}[0-9]{2}", code):
        return False
    return int("".join(_char_value(c) for c in code)) % 97 == 1


def make_lei(prefix18: str) -> str:
    body = prefix18.upper()
    num = int("".join(_char_value(c) for c in body) + "00")
    return body + f"{98 - num % 97:02d}"


def find_isins(text: str) -> list[str]:
    seen: list[str] = []
    for m in ISIN_RE.finditer(text.upper()):
        c = m.group(1)
        if is_valid_isin(c) and c not in seen:
            seen.append(c)
    return seen


def find_leis(text: str) -> list[str]:
    seen: list[str] = []
    for m in LEI_RE.finditer(text.upper()):
        c = m.group(1)
        if is_valid_lei(c) and not is_valid_isin(c) and c not in seen:
            seen.append(c)
    return seen


# ---------------------------------------------------------------- OCR-Reparatur
_LETTER_FOR = {"0": "O", "1": "I", "2": "Z", "5": "S", "6": "G", "8": "B", "4": "A", "7": "T", "!": "I", "|": "I"}
_DIGIT_FOR = {"O": "0", "D": "0", "Q": "0", "I": "1", "L": "1", "!": "1", "|": "1", "Z": "2", "S": "5", "G": "6", "B": "8", "T": "7"}
_COUNTRY_FIX = {"16": "IE", "1E": "IE", "I6": "IE", "IF": "IE", "1U": "LU", "LV": "LU", "D6": "DE", "0E": "DE", "C4": "CH", "6B": "GB", "U5": "US"}
FUND_ISIN_COUNTRIES = set("LU IE DE CH AT FR GB US NL BE IT ES LI JE GG KY DK SE NO FI XS PT GR CA AU SG HK JP".split())
OCR_ISIN_CANDIDATE = re.compile(r"(?<![A-Z0-9])([A-Z0-9!|]{12})(?![A-Z0-9])")


def repair_isin(token: str) -> str | None:
    """Versucht eine durch OCR verfälschte ISIN zu reparieren; Ergebnis nur bei gültiger Prüfziffer."""
    t = token.upper()
    if is_valid_isin(t):
        return t
    if len(t) != 12:
        return None
    head = _COUNTRY_FIX.get(t[:2], "".join(_LETTER_FOR.get(c, c) for c in t[:2]))
    tail = t[-1]
    tail = _DIGIT_FOR.get(tail, tail)
    candidates = {head + t[2:11] + tail}
    # mittlere 9 Stellen: bei Fonds-ISINs fast immer numerisch -> Buchstaben-Verwechsler in Ziffern
    mid_num = "".join(_DIGIT_FOR.get(c, c) for c in t[2:11])
    candidates.add(head + mid_num + tail)
    valid = [c for c in candidates if is_valid_isin(c) and c[:2] in FUND_ISIN_COUNTRIES]
    return valid[0] if len(set(valid)) == 1 else None


def repair_isins_in_text(text: str) -> tuple[str, list[tuple[str, str]]]:
    fixes: list[tuple[str, str]] = []

    def sub(m: re.Match) -> str:
        tok = m.group(1)
        if is_valid_isin(tok) or not re.search(r"\d{6}", tok):
            return tok
        fixed = repair_isin(tok)
        if fixed and fixed != tok:
            fixes.append((tok, fixed))
            return fixed
        return tok

    return OCR_ISIN_CANDIDATE.sub(sub, text), fixes
