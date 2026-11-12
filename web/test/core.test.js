/* node --test test/  – JS port must match the Python reference results on all sample agreements */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path");
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
const C = require("../src/core.js"), P = require("../src/pdf.js");
const SAMPLES = path.join(__dirname, "../../samples");

test("ISIN / LEI check digits and OCR repair", () => {
  assert.ok(C.isValidIsin("US0378331005") && !C.isValidIsin("US0378331006"));
  assert.ok(C.isValidLei("529900T8BM49AURSDO55") && !C.isValidLei("529900T8BM49AURSDO56"));
  assert.strictEqual(C.repairIsin("169861166812"), "IE9861166812");
  assert.strictEqual(C.repairIsin("159729609219"), "IE9729609219");
  assert.strictEqual(C.repairIsin("123456789012"), null);
});

test("share class matching", () => {
  assert.ok(C.classMatches("JNL Government Money Market Fund (Class I)", "Institutional Class"));
  assert.ok(C.classMatches("Class R-6", "Class R6"));
  assert.ok(!C.classMatches("I CHF hedged acc", "I CHF acc"));
  assert.ok(!C.classMatches("A EUR acc", "A EUR dis"));
});

const KNOWN_JS_BETTER = {
  // multi-line fund names in a schedule spanning several pages: Python keeps a fragment, JS reads the full names
  "SEC_ivy_funds_2026.pdf": { pythonFragments: ["Securities Fund"], jsAdditional: ["Nomura High Income Fund", "Nomura Real Estate Securities Fund"] },
};
const expected = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/python_expected.json"), "utf8"));
for (const [file, exp] of Object.entries(expected)) {
  test(`extraction matches Python: ${file}`, async () => {
    const dir = file.startsWith("SEC_") ? "sec_public" : "synthetic_eu";
    const r = await P.readPdf(new Uint8Array(fs.readFileSync(path.join(SAMPLES, "agreements", dir, file))), { pdfjsLib: pdfjs, ocr: "never" });
    const ex = C.extractDocument(r.text, r.tables);
    for (const k of ["document_type", "agreement_date", "fund_entity", "distributor", "management_company", "governing_law", "jurisdiction", "exclusivity", "termination_notice", "territory", "signatories"])
      assert.deepStrictEqual(ex[k], exp[k], k);
    const rr = ex.retrocession;
    assert.deepStrictEqual({ agreed: rr.agreed, rate: rr.rate, included_classes: rr.included_classes, excluded_classes: rr.excluded_classes }, exp.retro);
    const got = Object.fromEntries(ex.funds.map((f) => [f.name, f.share_classes.map((c) => [c.name, c.isin, c.retro]).sort()]));
    const want = Object.fromEntries(Object.entries(exp.funds).map(([n, cs]) => [n, cs.map((c) => [c[0], c[1], c[2]]).sort()]));
    // documented cases where the JS table reconstruction reads more than pdfplumber (Python)
    const better = KNOWN_JS_BETTER[file];
    if (better) {
      for (const n of better.pythonFragments) delete want[n];
      for (const n of better.jsAdditional) { assert.ok(got[n], `expected JS to find ${n}`); delete got[n]; }
    }
    assert.deepStrictEqual(got, want);
  });
}

test("delta / retro against the sample fund list", async () => {
  const docs = [];
  for (const [i, f] of ["Alpenblick_Global_Distribution_Agreement_2024.pdf", "Alpenblick_Nachtrag_1_2025.pdf"].entries()) {
    const r = await P.readPdf(new Uint8Array(fs.readFileSync(path.join(SAMPLES, "agreements/synthetic_eu", f))), { pdfjsLib: pdfjs, ocr: "never" });
    docs.push({ id: i + 1, filename: f, text: r.text, extraction: C.extractDocument(r.text, r.tables) });
  }
  const rows = C.parseCsv(fs.readFileSync(path.join(SAMPLES, "public_data/synthetic_fund_universe.csv"), "utf8"));
  const { records } = C.importRows("u.csv", rows);
  const t = C.buildOverview(records.filter((r) => r.umbrella === "Alpenblick Invest SICAV"), docs).totals;
  assert.deepStrictEqual([t.classes, t.covered, t.delta, t.retro_classes, t.retro_delta], [18, 10, 8, 10, 5]);
});
