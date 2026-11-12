/* Exports the concept diagrams and logos as PNG (3x).  node export-assets.js */
const { chromium } = require("playwright");
const path = require("path");
(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ deviceScaleFactor: 3, viewport: { width: 900, height: 1300 } })).newPage();
  await p.goto("file://" + path.join(__dirname, "brochure.html"));
  await p.evaluate(() => document.fonts.ready);
  const pages = await p.$$("section.page");
  await (await pages[3].$("svg.diagram")).screenshot({ path: path.join(__dirname, "concept-business.png") });
  await (await pages[4].$("svg.diagram")).screenshot({ path: path.join(__dirname, "concept-architecture.png") });
  await (await pages[5].$("svg.diagram")).screenshot({ path: path.join(__dirname, "waterfall.png") });
  const brand = path.join(__dirname, "../../brand");
  const items = [["logo.svg", "#ffffff", 1040], ["logo-light-on-dark.svg", "#01161E", 1040], ["logo-mark.svg", "transparent", 512]];
  for (const [file, bg, w] of items) {
    const pad = bg === "transparent" ? 0 : 24;
    await p.goto("file://" + path.join(brand, "preview.html"));
    await p.setContent(`<body style="margin:0;background:${bg}"><div id="x" style="display:inline-block;padding:${pad}px;background:${bg}"><img src="file://${path.join(brand, file)}" style="display:block;width:${w / 3}px"></div></body>`);
    await p.waitForTimeout(500);
    await (await p.$("#x")).screenshot({ path: path.join(brand, file.replace(".svg", ".png")), omitBackground: bg === "transparent" });
  }
  await b.close();
  console.log("assets exported");
})();
