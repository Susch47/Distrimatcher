const fs = require("fs"), path = require("path");
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
const Core = require("../src/core.js"), Pdf = require("../src/pdf.js");
(async () => {
  const exp = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const root = path.join(__dirname, "../../samples/agreements");
  let diffs = 0;
  for (const dir of ["sec_public", "synthetic_eu"]) for (const f of fs.readdirSync(path.join(root, dir)).sort()) {
    if (f.includes("SCAN")) continue;
    const r = await Pdf.readPdf(new Uint8Array(fs.readFileSync(path.join(root, dir, f))), { pdfjsLib: pdfjs, ocr: "never" });
    const ex = Core.extractDocument(r.text, r.tables);
    const got = { ...Object.fromEntries(["document_type","agreement_date","fund_entity","distributor","management_company","governing_law","jurisdiction","exclusivity","termination_notice","territory","signatories"].map(k => [k, ex[k]])),
      retro: { agreed: ex.retrocession.agreed, rate: ex.retrocession.rate, included_classes: ex.retrocession.included_classes, excluded_classes: ex.retrocession.excluded_classes },
      funds: Object.fromEntries(ex.funds.map(fu => [fu.name, fu.share_classes.map(c => [c.name, c.isin, c.retro]).sort((a,b)=> String(a) < String(b) ? -1 : 1)])) };
    const e = exp[f];
    for (const k of Object.keys(e)) {
      if (k === "funds") {
        const en = Object.keys(e.funds).sort(), gn = Object.keys(got.funds).sort();
        const miss = en.filter(n => !gn.includes(n)), extra = gn.filter(n => !en.includes(n));
        if (miss.length || extra.length) { diffs++; console.log(`[${f}] funds missing:`, miss, " extra:", extra); }
        for (const n of en.filter(n => gn.includes(n))) {
          const a = JSON.stringify(e.funds[n].map(x => [x[0], x[1], x[2]]).sort()), b = JSON.stringify(got.funds[n].sort());
          if (a !== b) { diffs++; console.log(`[${f}] classes of ${n}:\n   py ${a}\n   js ${b}`); }
        }
      } else if (JSON.stringify(e[k]) !== JSON.stringify(got[k])) { diffs++; console.log(`[${f}] ${k}: py=${JSON.stringify(e[k])} js=${JSON.stringify(got[k])}`); }
    }
  }
  console.log("diffs:", diffs);
})();
