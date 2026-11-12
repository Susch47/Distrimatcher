# Distrimatcher – User manual

Distrimatcher checks which fund share classes are covered by your **distribution agreements**. It also lists the share classes that are available on the market but not covered (**gaps**), with a focus on share classes that pay **retrocessions**.

Everything runs locally on your computer. Agreements, extracted text and results never leave the machine. Only public reference data (fund names, ISINs) is looked up online.

> This manual is a plain text file and you can edit it. Use the **Edit** button in this window, or open the file shown at the bottom with any text editor.

---

## The workflow

1. **Agreements**: upload your agreements.
2. **Overview**: load public fund data and see coverage and gaps.
3. **Watchlist**: review each gap and decide what to do.
4. **Provider e-mail**: send the open gaps to the fund provider.
5. **Activity log**: see what happened and when.

The app starts empty. Each page tells you what to do next.

---

## 1 · Agreements

**Upload.** Drag a **ZIP file** (nested ZIPs are fine) or single **PDFs** onto the upload area. Every PDF is read automatically:

- PDFs with a text layer are read directly.
- **Scanned pages** are read with OCR (Tesseract, English and German).
- An ISIN damaged by OCR is corrected **only if the check digit confirms it**. The correction is shown as a note on the document.
- Duplicates are recognised by their content and skipped.

**What is extracted**

| Field | Example |
|---|---|
| Parties and roles | Fund entity / umbrella, distributor, management company |
| Dates | "dated as of 15 March 2024", "vom 1. Oktober 2025" |
| Governing law, jurisdiction | Luxembourg law, courts of Luxembourg |
| Territory | Switzerland, Germany, Austria |
| Exclusivity, term, notice period | non-exclusive, 90 days |
| Retrocession / trail | 40% of the management fee; excluded classes (e.g. I) |
| Funds and share classes | from schedules and annexes (tables) and from running text, incl. "all share classes" |
| Identifiers | ISINs and LEIs (check digits verified), SEC series and class IDs |

Click a row to open the **document details**. There you can open the original PDF, re-run the extraction, correct the result (JSON editor) or delete the document.

Click a **column header** to sort the table.

---

## 2 · Overview

**Load public data** (the "universe" of funds and share classes):

| Source | What you get | Best for |
|---|---|---|
| **SEC** | Fund ID = series ID, share class = class ID and ticker | US mutual funds |
| **GLEIF** | Fund ID = LEI, plus ISINs reported to GLEIF | EU funds (often incomplete) |
| **File import** (CSV / Excel) | Whatever your list contains, incl. a retrocession column | SIX Fund Data exports, fund lists from management companies, fundinfo, Bloomberg |

Columns in the import file are recognised automatically, for example *Umbrella, Fund ID, Fund Name, Share Class, ISIN, Currency, Retrocession* (German headers work too). The retrocession column may contain *yes/no* or a rate such as *0.40%*.

**The waterfall chart** shows, from left to right:

1. **Fund IDs**: funds in the loaded universe
2. **ISINs**: share classes (ISINs / class IDs) of these funds
3. **Found in agreements**: share classes extracted from your agreements
4. **Covered**: universe share classes matched to an agreement
5. **Gaps**: share classes not covered (ISINs − covered)

**The fund list** shows umbrella → fund → share classes with a status:

- **covered**: matched by ISIN, by class name, or because the agreement covers *all share classes*
- **gap**: not covered by any agreement
- **review**: the fund is named in an agreement, but its share classes are not

Use the search box, the status filter, **Retro only** and **Sort** (name, fund ID, most gaps, lowest coverage) to focus on what matters.

**Retrocession status** of a share class, in order of priority:

1. **data**: from an imported list
2. **agreement**: from the agreement's retrocession clause
3. **assumed**: guessed from the class name (A/R/P = retail with retro, I/Z/N = clean). Treat this only as a hint.

---

## 3 · Watchlist

Every share class that is a **gap** or needs **review** appears here, with:

- **Features** (heuristic): institutional or retail, currency, hedged, clean share, accumulating or distributing
- **Source**: where the share class was found (file and row, SEC dataset, GLEIF record)
- **Found**: when it first appeared. **new** marks items first seen in the last 7 days.

**Actions**

- **Confirm**: it is a real gap and should be raised with the provider.
- **Dismiss**: not relevant (e.g. not intended for distribution).
- **Add to agreement**: the class is in fact covered (e.g. by a side letter). Choose the agreement; the class then counts as covered.
- **Open agreement**: opens the related agreement PDF.

Select several rows to act on them together. Click a column header to sort.

---

## 4 · Provider e-mail

1. Choose the **provider** (umbrella / fund house).
2. Choose which items to include (*confirmed only* or *all open*) and whether to include **only retro-paying** share classes.
3. Choose the language (English / German).
4. Check and edit the pre-written text.
5. **Download .eml** (opens as a draft in Outlook), **Open in mail app**, or **Copy** the text.

---

## 5 · Activity log

Lists uploads, extractions, data loads, watchlist decisions and e-mails with timestamps. **Reset all data** starts from scratch: documents, public data, watchlist and log are deleted.

---

## Data & files

- Data folder: `%LOCALAPPDATA%\Distrimatcher` on Windows. It holds the database, the PDFs, this manual (`manual.md`) and the log file.
- Deleting this folder resets the app completely.
- Offline mode: start with the environment variable `DISTRIMATCHER_OFFLINE=1`. Use the file import for the universe.

## Limitations

- Extraction is rule-based. Unusual layouts can be missed, so check the notes on each document.
- GLEIF lists ISINs only for some funds. For a complete Swiss / EU picture, import a fund list, e.g. a SIX Fund Data export.
- The retrocession status *assumed* is only a hint.
