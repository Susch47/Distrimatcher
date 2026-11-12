/* Builds dist/Distrimatcher.html – one self-contained file (no server, no install, works offline).
 *   cd web && npm install && npm run build
 */
const fs = require("fs");
const path = require("path");

const W = __dirname;
const nm = (p) => path.join(W, "node_modules", p);
const read = (p) => fs.readFileSync(p, "utf8");
const b64 = (p) => fs.readFileSync(p).toString("base64");
const safe = (js) => js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
const inline = (js) => `<script>${safe(js)}</script>`;
const textBlock = (id, content) => `<script type="text/plain" id="${id}">${safe(content)}</script>`;

const pkg = JSON.parse(read(path.join(W, "package.json")));
let css = read(path.join(W, "src/app.css"));
css = css.replace(/url\(fonts\/([^)]+)\)/g, (_, f) => `url(data:font/woff2;base64,${b64(path.join(W, "../distrimatcher/static/fonts", f))})`);

const scripts = [
  textBlock("dm-manual", read(path.join(W, "src/manual.md"))),
  // pdf.js (+ worker started from an in-page blob)
  inline(read(nm("pdfjs-dist/build/pdf.min.js"))),
  textBlock("dm-pdf-worker", read(nm("pdfjs-dist/build/pdf.worker.min.js"))),
  inline(`pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([document.getElementById("dm-pdf-worker").textContent], { type: "text/javascript" }));`),
  // ZIP + Excel
  inline(read(nm("fflate/umd/index.js"))),
  inline(read(nm("xlsx/dist/xlsx.core.min.js"))),
  // OCR: tesseract.js, its worker, the wasm core and German + English language data – all embedded
  inline(read(nm("tesseract.js/dist/tesseract.min.js"))),
  textBlock("dm-tess-worker", read(nm("tesseract.js/dist/worker.min.js"))),
  textBlock("dm-tess-core", read(nm("tesseract.js-core/tesseract-core-lstm.wasm.js"))),
  textBlock("dm-lang-deu", b64(nm("@tesseract.js-data/deu/4.0.0_best_int/deu.traineddata.gz"))),
  textBlock("dm-lang-eng", b64(nm("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"))),
  // app
  inline(read(path.join(W, "src/core.js"))),
  inline(read(path.join(W, "src/pdf.js"))),
  inline(read(path.join(W, "src/local-api.js"))),
  inline(read(path.join(W, "src/app.js"))),
].join("\n");

let html = read(path.join(W, "src/index.html"));
html = html.replace("<style>/*CSS*/</style>", () => `<style>${css}</style>`);
html = html.replace("<!--SCRIPTS-->", () => scripts);
html = html.replace("<title>Distrimatcher</title>", () => `<title>Distrimatcher</title>\n  <meta name="generator" content="Distrimatcher ${pkg.version} – single-file build">`);

fs.mkdirSync(path.join(W, "dist"), { recursive: true });
const out = path.join(W, "dist", "Distrimatcher.html");
fs.writeFileSync(out, html);
console.log(`${out}  ${(html.length / 1e6).toFixed(1)} MB`);
