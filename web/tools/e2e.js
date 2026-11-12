/* End-to-end test of dist/Distrimatcher.html opened via file:// (as on a locked-down PC).
 *   node test/e2e.js [screenshotDir] [secCsvPath]
 */
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

(async () => {
  const shots = process.argv[2];
  const secCsv = process.argv[3];
  const root = path.join(__dirname, "../..");
  const html = "file://" + path.join(__dirname, "../dist/Distrimatcher.html");
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  const shot = (n, full = false) => shots && p.screenshot({ path: path.join(shots, `h${n}.png`), fullPage: full });
  const check = (cond, msg) => { if (!cond) { console.log("FAIL:", msg); process.exitCode = 1; } else console.log("ok  ", msg); };

  await p.goto(html); await p.waitForTimeout(1500);
  check((await p.textContent("#status-pill")).includes("OCR"), "app loads from file://");
  check(await p.isHidden("#agreements-body"), "starts empty");
  await shot(1);

  // 1 upload ZIP (incl. scanned PDF -> OCR)
  await p.setInputFiles("#file", path.join(root, "samples/demo_agreements.zip"));
  await p.waitForFunction(() => document.querySelectorAll("#doc-table tbody tr").length >= 9 &&
    ![...document.querySelectorAll("#doc-table tbody td:nth-child(2)")].some((td) => /reading|queued/.test(td.textContent)), null, { timeout: 240000 });
  const rows = await p.$$eval("#doc-table tbody tr", (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
  const scan = rows.find((r) => r[0].includes("SCAN"));
  check(scan && scan[0].includes("OCR 1/1") && scan[1].startsWith("done"), "scanned PDF read via OCR");
  check(scan && scan[7] === "5" && scan[8] === "5", "OCR found 5 share classes / 5 ISINs");
  const art = rows.find((r) => r[0].includes("artisan"));
  check(art && art[6] === "21" && art[7] === "63", "Artisan: 21 funds, 63 classes");
  await shot(2, true);

  // document drawer
  await p.locator("#doc-table tbody tr", { hasText: "Alpenblick_Global" }).click(); await p.waitForTimeout(800);
  check((await p.textContent("#d-body")).includes("Seeland Vertriebs AG"), "drawer shows distributor");
  await shot(3);
  await p.click("#d-close");

  // 2 overview: SEC dataset + suggestions + file import
  await p.click(".step[data-tab=overview]"); await p.waitForTimeout(600);
  if (secCsv && fs.existsSync(secCsv)) {
    await p.setInputFiles("#sec-file", secCsv); await p.waitForFunction(() => /Dataset:/.test(document.querySelector("#sec-info").textContent), null, { timeout: 60000 });
    await p.click("#sec-suggest"); await p.waitForSelector("#sec-load", { timeout: 60000 });
    await p.click("#sec-load"); await p.waitForTimeout(2500);
  }
  await p.setInputFiles("#imp-file", path.join(root, "samples/public_data/synthetic_fund_universe.csv")); await p.waitForTimeout(2500);
  check(await p.isVisible("#waterfall svg"), "waterfall rendered");
  await p.evaluate(() => document.querySelector("#ov-results").scrollIntoView()); await p.waitForTimeout(300);
  await shot(4);

  // export CSV
  const [dl] = await Promise.all([p.waitForEvent("download"), p.click("[data-export*=only_retro]")]);
  check(dl.suggestedFilename().endsWith(".csv"), "retro gaps CSV download");

  // 3 watchlist
  await p.click(".step[data-tab=watchlist]"); await p.waitForTimeout(1500);
  await p.fill("#wl-filter", "Alpenblick"); await p.waitForTimeout(400);
  const nAlp = await p.$$eval("#wl-table tbody tr", (t) => t.length);
  check(nAlp === 5, `watchlist shows 5 retro gaps for Alpenblick (got ${nAlp})`);
  const r0 = p.locator("#wl-table tbody tr").nth(0), r1 = p.locator("#wl-table tbody tr").nth(1);
  await r0.locator("input").check(); await r1.locator("input").check();
  await p.click("#wl-bulk-confirm"); await p.waitForTimeout(1000);
  await p.locator("#wl-table tbody tr").first().locator("[data-act=add]").click(); await p.waitForTimeout(300);
  await p.click("#add-ok"); await p.waitForTimeout(1000);
  await shot(5);
  await p.click('#wl-status button[data-s=""]'); await p.waitForTimeout(300);
  await p.locator("#wl-table tbody tr").first().locator("[data-act=view]").click(); await p.waitForTimeout(1200);
  check(await p.isVisible("#drawer.open"), "open agreement from watchlist");
  await p.click("#d-close");

  // 4 e-mail
  await p.click(".step[data-tab=email]"); await p.waitForTimeout(1000);
  await p.locator("#em-providers button", { hasText: "Alpenblick" }).click(); await p.waitForTimeout(800);
  const body = await p.inputValue("#em-body-text");
  check(/ISIN LU\d{10}/.test(body), "e-mail lists ISINs");
  await shot(6);
  const [eml] = await Promise.all([p.waitForEvent("download"), p.click("#em-eml")]);
  const emlText = fs.readFileSync(await eml.path(), "utf8");
  check(eml.suggestedFilename().endsWith(".eml") && emlText.includes("X-Unsent: 1"), ".eml download (Outlook draft)");

  // manual
  await p.click("#tab-email ~ * .info-btn, [data-open-manual]"); await p.waitForTimeout(500);
  check((await p.textContent("#man-view")).includes("one HTML file"), "manual opens");
  await p.click("#man-close");

  // project save / reset / open
  const [proj] = await Promise.all([p.waitForEvent("download"), p.click("#proj-save")]);
  const projPath = await proj.path();
  await p.click(".step[data-tab=log]"); await p.waitForTimeout(500);
  await shot(7);
  p.once("dialog", (d) => d.accept());
  await p.click("#reset"); await p.waitForTimeout(1200);
  check(await p.isHidden("#agreements-body"), "reset empties the app");
  p.once("dialog", (d) => d.accept());
  await p.setInputFiles("#proj-file", projPath); await p.waitForTimeout(3000);
  const n = await p.$$eval("#doc-table tbody tr", (t) => t.length);
  check(n === 9, `project file restores 9 agreements (got ${n})`);

  // persistence after reload
  await p.reload(); await p.waitForTimeout(1500);
  check((await p.$$eval("#doc-table tbody tr", (t) => t.length)) === 9, "data persists after reopening the file");

  check(errs.length === 0, "no JavaScript errors" + (errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""));
  await b.close();
})();
