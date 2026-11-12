/* Renders brochure.html to Distrimatcher-Brochure.pdf (A4) and PNG previews.  node render.js */
const { chromium } = require("playwright");
const path = require("path");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto("file://" + path.join(__dirname, "brochure.html"), { waitUntil: "load" });
  await p.evaluate(() => document.fonts.ready);
  await p.pdf({ path: path.join(__dirname, "Distrimatcher-Brochure.pdf"), preferCSSPageSize: true, printBackground: true });
  await b.close();
  console.log("PDF written");
})();
