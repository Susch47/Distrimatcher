/* Distrimatcher PDF layer: text lines + table reconstruction from pdf.js text items, OCR fallback.
 * Works in the browser (global pdfjsLib / Tesseract) and in Node.js (tests pass pdfjs in).
 */
(function (root) {
  "use strict";
  const Core = typeof module !== "undefined" && module.exports ? require("./core.js") : root.DMCore;
  const { clean, HEADER_FUND, HEADER_CLASS, HEADER_ISIN, findIsins, ocrCleanup } = Core;
  const MIN_CHARS_PER_PAGE = 40;

  /* ---------------------------------------------------------------- lines */
  function toItems(textContent) {
    return textContent.items
      .filter((it) => it.str && it.str.trim())
      .map((it) => {
        const fs = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
        return { str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || it.str.length * fs * 0.5, fs };
      });
  }
  function buildLines(items) {
    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of sorted) {
      const ln = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(1.5, 0.45 * Math.min(l.fs, it.fs)));
      if (ln) { ln.items.push(it); ln.fs = Math.max(ln.fs, it.fs); }
      else lines.push({ y: it.y, fs: it.fs, items: [it] });
    }
    lines.sort((a, b) => b.y - a.y);
    for (const l of lines) {
      l.items.sort((a, b) => a.x - b.x);
      let text = "", prevEnd = null;
      for (const it of l.items) {
        if (prevEnd != null) {
          const gap = it.x - prevEnd;
          if (gap > 0.12 * it.fs && !text.endsWith(" ") && !it.str.startsWith(" ")) text += " ";
        }
        text += it.str;
        prevEnd = it.x + it.w;
      }
      l.text = clean(text);
    }
    return lines.filter((l) => l.text);
  }

  /* ---------------------------------------------------------------- tables
   * Finds a header line with a fund column and a class or ISIN column, derives column starts from the
   * header and groups the following lines into rows (multi-line cells are joined with "\n").
   * Output matches pdfplumber's extract_tables(): [headerRow, ...rows]. Column layouts carry over to
   * the next page, so schedules continuing without a repeated header are still read. */
  const TERMINAL = /(?:\b(?:Fund|Portfolio|Allocation|ETF|Trust|Teilfonds|Fonds|SICAV|ICAV|Sub-Fund|Series)(?:\s+[IVX]+)?|\))\s*$/i;
  const HEAD_FUND_ITEM = /^(?:funds?|fund name|name of (?:the )?fund|sub-?funds?|teilfonds|fonds|portfolios?|series|compartments?|umbrella\s*\/\s*sub-?fund)\b/i;
  const HEAD_OTHER_ITEM = /^(?:share\s+class(?:es)?|class(?:es)?(?:\s*\(es\))?|class\(es\)|anteils?klassen?|klassen?|isin)\b/i;

  /* merge adjacent items (pdf.js sometimes emits single letters) into word groups / cell segments */
  function segments(line) {
    if (line.segs) return line.segs;
    const segs = [];
    for (const it of line.items) {
      const last = segs[segs.length - 1];
      const gap = last ? it.x - (last.x + last.w) : Infinity;
      if (last && gap <= 0.4 * it.fs) {
        last.str += gap > 0.12 * it.fs && !last.str.endsWith(" ") ? " " + it.str : it.str;
        last.w = it.x + it.w - last.x;
      } else segs.push({ str: it.str, x: it.x, w: it.w, y: line.y });
    }
    for (const sg of segs) sg.str = clean(sg.str);
    return (line.segs = segs.filter((sg) => sg.str));
  }
  function headerColumns(lines, i) {
    const l = lines[i], segs = segments(l);
    const hasFund = segs.some((sg) => sg.str.length <= 30 && HEAD_FUND_ITEM.test(sg.str));
    const hasOther = segs.some((sg) => sg.str.length <= 30 && HEAD_OTHER_ITEM.test(sg.str));
    if (!hasFund || !hasOther || l.text.length > 120 || segs.length < 2 || segs.length > 8) return null;
    const cand = [...segs];
    const above = lines[i - 1];
    if (above && above.y - l.y < 2.6 * l.fs && above.text.length < 120 && segments(above).every((sg) => sg.str.length <= 30)) cand.push(...segments(above));
    cand.sort((a, b) => a.x - b.x);
    const cols = [];
    for (const sg of cand) {
      const c = cols.find((c) => Math.abs(c.x - sg.x) < 14 || (sg.x >= c.x && sg.x <= c.end + 4));
      if (c) { c.parts.push(sg); c.end = Math.max(c.end, sg.x + sg.w); c.x = Math.min(c.x, sg.x); }
      else cols.push({ x: sg.x, end: sg.x + sg.w, parts: [sg] });
    }
    cols.sort((a, b) => a.x - b.x);
    for (const c of cols) c.title = clean(c.parts.sort((a, b) => b.y - a.y || a.x - b.x).map((p) => p.str).join(" "));
    return cols.length >= 2 ? cols : null;
  }
  function colIndex(cols, x) {
    let idx = 0;
    for (let k = 0; k < cols.length; k++) if (x + 10 >= cols[k].x) idx = k;
    return idx;
  }
  /* parse table body starting at line j; returns [table, nextIndex] */
  function parseBody(lines, j, cols, prevY) {
    const fundCol = cols.findIndex((c) => HEADER_FUND.test(c.title) && !HEADER_CLASS.test(c.title));
    const isinCol = cols.findIndex((c) => HEADER_ISIN.test(c.title));
    const table = [cols.map((c) => c.title)];
    let row = null, rowFund = "", rowHasIsin = false;
    const flush = () => { if (row && row.some((c) => c.length)) table.push(row.map((c) => c.join("\n"))); row = null; rowFund = ""; rowHasIsin = false; };
    for (; j < lines.length; j++) {
      const l = lines[j], segs = segments(l);
      if (headerColumns(lines, j)) break;
      if (prevY != null && prevY - l.y > 2.6 * Math.max(l.fs, 8)) break; // large vertical gap: table ended
      prevY = l.y;
      const overflow = segs.some((sg) => { const k = colIndex(cols, sg.x); return k < cols.length - 1 && sg.x + sg.w > cols[k + 1].x + 6 && sg.str.length > 25; });
      if (overflow || /^(?:IN WITNESS|\[|\d+\s+[A-Z][a-z]+\s+[a-z]+\s+[a-z]+)/.test(l.text) || segs[0].x < cols[0].x - 40) break;
      const cells = cols.map(() => []);
      for (const sg of segs) cells[colIndex(cols, sg.x)].push(sg.str);
      const texts = cells.map((c) => clean(c.join(" ")));
      const fundTxt = texts[fundCol];
      const lineIsin = isinCol >= 0 ? findIsins(texts[isinCol]).length > 0 : findIsins(l.text).length > 0;
      if (!row || (fundTxt && (TERMINAL.test(rowFund) || !rowFund || (lineIsin && rowHasIsin)))) { flush(); row = cols.map(() => []); }
      texts.forEach((t, k) => { if (t) row[k].push(t); });
      if (fundTxt) rowFund = clean(rowFund + " " + fundTxt);
      rowHasIsin = rowHasIsin || lineIsin;
    }
    flush();
    return [table, j];
  }
  function extractTables(lines, carry = null) {
    const tables = [];
    let last = null, i = 0;
    // continuation of a table from the previous page (no repeated header); allow a short page header
    // above it and a small horizontal shift of the whole layout
    if (carry && lines.length) {
      for (let k = 0; k < Math.min(3, lines.length); k++) {
        const segs = segments(lines[k]);
        if (segs.length < 2) continue;
        const off = segs[0].x - carry[0].x;
        const aligned = Math.abs(off) < 25 && segs.every((sg) => carry.some((c) => Math.abs(c.x + off - sg.x) < 26));
        if (!aligned) continue;
        const shifted = carry.map((c) => ({ ...c, x: c.x + off, end: c.end + off }));
        const [table, j] = parseBody(lines, k, shifted, null);
        if (table.length > 1) { tables.push(table); last = shifted; }
        i = j;
        break;
      }
    }
    for (; i < lines.length; i++) {
      const cols = headerColumns(lines, i);
      if (!cols) continue;
      if (cols.findIndex((c) => HEADER_FUND.test(c.title) && !HEADER_CLASS.test(c.title)) < 0) continue;
      let j = i + 1;
      const nxt = lines[j];
      if (nxt && lines[i].y - nxt.y < 1.8 * lines[i].fs && !findIsins(nxt.text).length && segments(nxt).every((sg) => sg.str.length <= 24)
          && /fee|date|%|isin|class|\d+b-1|term|rate|end|commission|provision/i.test(nxt.text)) {
        for (const sg of segments(nxt)) { const c = cols[colIndex(cols, sg.x)]; c.title = clean(c.title + " " + sg.str); }
        j++;
      }
      const [table, nextJ] = parseBody(lines, j, cols, lines[j - 1].y);
      if (table.length > 1) tables.push(table);
      last = cols;
      // keep the layout for the next page only if the table ran to the page end
      if (nextJ < lines.length) last = lines.slice(nextJ).every((l) => /^\d+$|^\[|^page\b/i.test(l.text) || l.text.length < 4) ? cols : null;
      i = nextJ - 1;
    }
    return { tables, carry: last };
  }

  /* ---------------------------------------------------------------- reading a PDF */
  async function readPdf(bytes, { pdfjsLib, ocr = "auto", ocrEngine = null, onProgress = () => {} } = {}) {
    const lib = pdfjsLib || root.pdfjsLib;
    const doc = await lib.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true }).promise;
    const pages = [], tables = [], ocrFixes = [];
    let carry = null;
    for (let n = 1; n <= doc.numPages; n++) {
      onProgress({ page: n, pages: doc.numPages });
      const page = await doc.getPage(n);
      const lines = buildLines(toItems(await page.getTextContent()));
      let text = lines.map((l) => l.text).join("\n"), usedOcr = false;
      const needOcr = ocr === "always" || (ocr === "auto" && text.replace(/\s/g, "").length < MIN_CHARS_PER_PAGE);
      if (needOcr && ocrEngine) {
        try {
          const [t, fixes] = ocrCleanup(await ocrEngine(page, n));
          text = t; ocrFixes.push(...fixes); usedOcr = true;
        } catch (e) { text += `\n[OCR failed: ${e.message || e}]`; }
      } else {
        const r = extractTables(lines, carry);
        tables.push(...r.tables); carry = r.carry;
      }
      pages.push({ number: n, text, ocr: usedOcr });
      page.cleanup?.();
    }
    await doc.destroy?.();
    return { pages, tables, ocr_fixes: ocrFixes, text: pages.map((p) => `[[Page ${p.number}]]\n${p.text}`).join("\n\n"), ocr_pages: pages.filter((p) => p.ocr).length };
  }

  const api = { toItems, buildLines, extractTables, readPdf };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.DMPdf = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
