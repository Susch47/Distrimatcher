/* Distrimatcher – local "backend" running entirely in the browser.
 * Data lives in IndexedDB of this browser profile (nothing is uploaded). Exposes api(url, opts) with the
 * same routes as the former Python server, so the UI code stays the same.
 */
(function (root) {
  "use strict";
  const C = root.DMCore, P = root.DMPdf;
  const VERSION = "0.3.0";
  const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

  /* ================================================================ IndexedDB */
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open("distrimatcher", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore("docs", { keyPath: "id", autoIncrement: true });
        d.createObjectStore("pdfs");
        d.createObjectStore("universe", { keyPath: "id", autoIncrement: true });
        d.createObjectStore("watch", { keyPath: "key" });
        d.createObjectStore("events", { keyPath: "id", autoIncrement: true });
        d.createObjectStore("kv");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error || new Error("IndexedDB not available – data cannot be stored in this browser"));
    });
    return dbp;
  }
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode); let out;
      Promise.resolve(fn(t.objectStore(store))).then((v) => (out = v));
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  const all = (store) => tx(store, "readonly", (s) => req(s.getAll()));
  const get = (store, key) => tx(store, "readonly", (s) => req(s.get(key)));
  const put = (store, val, key) => tx(store, "readwrite", (s) => req(key === undefined ? s.put(val) : s.put(val, key)));
  const del = (store, key) => tx(store, "readwrite", (s) => req(s.delete(key)));
  const clear = (store) => tx(store, "readwrite", (s) => req(s.clear()));

  async function log(kind, message) { await put("events", { ts: now(), kind, message }); }

  /* ================================================================ helpers */
  async function sha256(bytes) {
    try { const h = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
    catch { let h = 2166136261; for (let i = 0; i < bytes.length; i += 7) { h ^= bytes[i]; h = Math.imul(h, 16777619); } return "fnv" + (h >>> 0).toString(16) + "-" + bytes.length; }
  }
  function unzipAll(name, bytes, depth = 0) {
    const out = [];
    if (depth > 3) return out;
    const files = root.fflate.unzipSync(bytes, { filter: (f) => !/(^|\/)(__MACOSX|\.)/.test(f.name) && /\.(pdf|zip)$/i.test(f.name) });
    for (const [path, data] of Object.entries(files)) {
      const full = (depth ? name + "/" : "") + path.replace(/\\/g, "/").split("/").filter((p) => p && p !== "..").join("/");
      if (/\.zip$/i.test(path)) out.push(...unzipAll(full, data, depth + 1));
      else if (data.length && data.length < 200 * 1024 * 1024) out.push({ name: full, data });
    }
    return out;
  }
  function readUpload(file, bytes) {
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return [{ name: file.name, data: bytes }];
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return unzipAll(file.name, bytes);
    throw new Error(`${file.name}: neither ZIP nor PDF`);
  }
  function csvResponse(rows, header, name) {
    const q = (v) => { const s = v == null ? "" : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const text = "﻿" + [header, ...rows].map((r) => r.map(q).join(";")).join("\r\n");
    return { download: { name, blob: new Blob([text], { type: "text/csv;charset=utf-8" }) } };
  }

  /* ================================================================ OCR (tesseract.js, fully embedded) */
  let ocrWorker = null;
  function ocrAvailable() { return !!(root.Tesseract && document.getElementById("dm-tess-core")); }
  async function getOcrWorker() {
    if (ocrWorker) return ocrWorker;
    const T = (id) => document.getElementById(id).textContent;
    const boot = `const L={"dm/deu.traineddata.gz":${JSON.stringify(T("dm-lang-deu"))},"dm/eng.traineddata.gz":${JSON.stringify(T("dm-lang-eng"))}};
const CORE=${JSON.stringify(T("dm-tess-core"))};
const F=self.fetch?self.fetch.bind(self):null;
self.fetch=async(u,o)=>{const k=Object.keys(L).find(k=>String(u).endsWith(k));if(k){const s=atob(L[k]);const a=new Uint8Array(s.length);for(let i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return new Response(a);}return F(u,o);};
const I=self.importScripts.bind(self);
self.importScripts=(...a)=>{for(const x of a){if(String(x).endsWith("core.js")){(0,eval)(CORE);}else I(x);}};
` + T("dm-tess-worker");
    const url = URL.createObjectURL(new Blob([boot], { type: "text/javascript" }));
    ocrWorker = await root.Tesseract.createWorker("deu+eng", 1, { workerPath: url, workerBlobURL: false, corePath: "core.js", langPath: "dm", cacheMethod: "none" });
    return ocrWorker;
  }
  async function ocrPage(page) {
    const w = await getOcrWorker();
    const vp = page.getViewport({ scale: 300 / 72 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const r = await w.recognize(canvas);
    canvas.width = canvas.height = 0;
    return r.data.text;
  }

  /* ================================================================ processing queue */
  const queue = [];
  let running = false;
  async function runQueue() {
    if (running) return; running = true;
    while (queue.length) {
      const { id, ocr } = queue.shift();
      const doc = await get("docs", id);
      if (!doc) continue;
      try {
        await put("docs", { ...doc, status: "processing" });
        const bytes = await get("pdfs", id);
        const r = await P.readPdf(new Uint8Array(bytes), { ocr, ocrEngine: ocrAvailable() ? (page) => ocrPage(page) : null,
          onProgress: async ({ page, pages }) => { const d = await get("docs", id); if (d) await put("docs", { ...d, status: "processing", progress: `${page}/${pages}` }); } });
        const ex = C.extractDocument(r.text, r.tables);
        if (r.ocr_fixes.length) ex.warnings.push(`OCR correction (check digit verified): ${r.ocr_fixes.map(([a, b]) => `${a}→${b}`).join(", ")}`);
        if (!ocrAvailable() && r.pages.some((p) => p.text.replace(/\s/g, "").length < 40)) ex.warnings.push("Scanned pages detected, but OCR is not available in this build.");
        if (r.pages.every((p) => p.text.trim().length < 40)) ex.warnings.push("Hardly any text found – possibly a scan without OCR.");
        const d = await get("docs", id);
        await put("docs", { ...d, status: "done", progress: null, pages: r.pages.length, ocr_pages: r.ocr_pages, ocr_fixes: r.ocr_fixes, text: r.text, extraction: ex, error: null });
        const ncls = ex.funds.reduce((a, f) => a + f.share_classes.length, 0);
        await log("extraction", `${doc.filename}: ${ex.funds.length} funds, ${ncls} share classes` + (r.ocr_pages ? `, ${r.ocr_pages} page(s) via OCR` : ""));
      } catch (e) {
        const d = await get("docs", id);
        if (d) await put("docs", { ...d, status: "error", progress: null, error: `${e.name || "Error"}: ${e.message || e}` });
        await log("error", `${doc.filename}: ${e.message || e}`);
      }
    }
    running = false;
  }

  /* ================================================================ universe & SEC dataset */
  const uniKey = (r) => [r.source, r.fund_id || "", r.fund_name, r.class_id || "", r.class_name || "", r.isin || ""].join("\u0001");
  async function addUniverse(records) {
    const existing = new Set((await all("universe")).map(uniKey));
    let added = 0;
    await tx("universe", "readwrite", (s) => {
      for (const r of records) { const k = uniKey(r); if (existing.has(k)) continue; existing.add(k); s.add({ ...r, loaded_at: now() }); added++; }
    });
    return added;
  }
  let secCache = null;
  async function secIndex() {
    if (secCache) return secCache;
    const raw = await get("kv", "sec_csv");
    if (!raw) throw new Error("Import the SEC dataset first (CSV, see the link in the SEC box).");
    secCache = { name: raw.name, index: C.secIndex(C.parseCsv(raw.text)) };
    return secCache;
  }
  async function readTable(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/\.(xlsx|xlsm|xls)$/i.test(file.name)) {
      const wb = root.XLSX.read(bytes, { type: "array" });
      return root.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: "" });
    }
    return C.parseCsv(new TextDecoder("utf-8").decode(bytes));
  }

  /* GLEIF (CORS enabled) */
  async function gleifLoad(fundNames, umbrella = null, minScore = 0.85) {
    const records = [], report = [];
    for (const name of fundNames) {
      const u = new URL("https://api.gleif.org/api/v1/lei-records");
      u.searchParams.set("filter[fulltext]", name); u.searchParams.set("filter[entity.category]", "FUND"); u.searchParams.set("page[size]", "10");
      const r = await fetch(u); if (!r.ok) throw new Error(`GLEIF HTTP ${r.status}`);
      const qn = C.normFund(name);
      const hits = ((await r.json()).data || []).map((rec) => ({ lei: rec.id, name: rec.attributes.entity.legalName.name, score: C.seqRatio(qn, C.normFund(rec.attributes.entity.legalName.name)) })).sort((a, b) => b.score - a.score);
      const best = hits[0] && hits[0].score >= minScore ? hits[0] : null;
      if (!best) { report.push({ fund: name, lei: null, isins: 0, note: "no LEI found" }); continue; }
      const isins = [];
      for (let page = 1; page <= 20; page++) {
        const ri = await fetch(`https://api.gleif.org/api/v1/lei-records/${best.lei}/isins?page[size]=200&page[number]=${page}`);
        if (!ri.ok) break;
        const d = await ri.json(); isins.push(...(d.data || []).map((x) => x.attributes.isin));
        if (page >= ((d.meta || {}).pagination || {}).lastPage) break;
      }
      report.push({ fund: name, lei: best.lei, gleif_name: best.name, isins: isins.length });
      const origin = `GLEIF LEI record ${best.lei} · ${best.name}`, url = `https://search.gleif.org/#/record/${best.lei}`;
      if (!isins.length) records.push({ source: "GLEIF", umbrella, fund_id: best.lei, fund_name: best.name, class_id: null, class_name: null, isin: null, ticker: null, lei: best.lei, currency: null, retro: null, origin, origin_url: url });
      for (const isin of isins) records.push({ source: "GLEIF", umbrella, fund_id: best.lei, fund_name: best.name, class_id: null, class_name: null, isin, ticker: null, lei: best.lei, currency: null, retro: null, origin: `${origin} · ISIN ${isin}`, origin_url: url });
    }
    return { records, report };
  }

  /* ================================================================ derived views */
  async function doneDocs() { return (await all("docs")).filter((d) => d.status === "done"); }
  async function manualMap() {
    const docs = await all("docs"), names = Object.fromEntries(docs.map((d) => [d.id, d.filename]));
    const m = {};
    for (const w of await all("watch")) if (w.status === "added") m[w.key] = { doc_id: w.doc_id, doc_name: names[w.doc_id] };
    return m;
  }
  async function overview() { return C.buildOverview(await all("universe"), await doneDocs(), await manualMap()); }
  function agreementsFor(umbrella, docs) {
    return docs.filter((d) => {
      const ex = d.extraction || {};
      let names = [ex.fund_entity || "", ...(ex.funds || []).map((f) => f.umbrella || "")];
      names = names.concat(names.flatMap((n) => n.split(", ")));
      return umbrella && names.some((n) => n && C.nameScore(n, umbrella) >= 0.86);
    }).map((d) => ({ id: d.id, name: d.filename }));
  }
  async function watchlist() {
    const ov = await overview(), docs = await doneDocs();
    const items = [];
    for (const u of ov.umbrellas) {
      let related = null;
      for (const f of u.funds) for (const c of f.classes) {
        if (c.status === "covered" && c.via !== "added manually") continue;
        if (!related) related = agreementsFor(u.name, docs);
        const agr = f.matched_agreement_ids.length ? f.matched_agreement_ids.map((id, i) => ({ id, name: f.matched_agreements[i] })) : related;
        items.push({ key: c.key, umbrella: u.name, fund_name: f.fund_name, fund_id: f.fund_id, isin: c.isin, class_id: c.class_id, class_name: c.class_name, ticker: c.ticker,
          currency: c.currency, gap_status: c.status, via: c.via, features: C.classFeatures(c.class_name, c.currency, c.retro), retro: c.retro, retro_basis: c.retro_basis,
          pays_retro: c.pays_retro, origin: c.origin, origin_url: c.origin_url, agreements: agr });
      }
    }
    const states = Object.fromEntries((await all("watch")).map((w) => [w.key, w]));
    const fresh = items.filter((i) => !states[i.key]);
    if (fresh.length) await tx("watch", "readwrite", (s) => { for (const i of fresh) { const w = { key: i.key, first_seen: now(), status: "open", doc_id: null }; s.put(w); states[i.key] = w; } });
    const cutoff = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 19).replace("T", " ");
    for (const i of items) { const w = states[i.key]; i.status = w.status; i.first_seen = w.first_seen; i.is_new = w.first_seen >= cutoff && w.status === "open"; i.agreement_id = w.doc_id; }
    return items;
  }

  /* ================================================================ manual */
  const defaultManual = () => (document.getElementById("dm-manual") || {}).textContent || "# Manual";

  /* ================================================================ router */
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), fn });

  route("GET", "/api/status", async () => ({ version: VERSION, ocr: ocrAvailable(), tesseract: ocrAvailable() ? "embedded" : null, online: navigator.onLine, data_dir: "this browser (IndexedDB)" }));

  route("POST", "/api/upload", async ({ body, query }) => {
    const ocr = query.get("ocr") || "auto", result = [];
    const known = new Map((await all("docs")).map((d) => [d.sha256, d.id]));
    for (const file of body.getAll("files")) {
      let pdfs;
      try { pdfs = readUpload(file, new Uint8Array(await file.arrayBuffer())); } catch (e) { result.push({ filename: file.name, error: e.message }); continue; }
      for (const pdf of pdfs) {
        const sha = await sha256(pdf.data);
        if (known.has(sha)) { result.push({ id: known.get(sha), filename: pdf.name, duplicate: true }); continue; }
        const id = await put("docs", { filename: pdf.name, sha256: sha, uploaded_at: now(), status: "queued", error: null, pages: null, ocr_pages: null, ocr_fixes: [], text: null, extraction: null, edited: 0 });
        await put("pdfs", pdf.data, id);
        known.set(sha, id);
        queue.push({ id, ocr });
        result.push({ id, filename: pdf.name, duplicate: false });
      }
    }
    const n = result.filter((r) => r.id && !r.duplicate).length;
    await log("upload", `Uploaded ${body.getAll("files").map((f) => f.name).join(", ")}: ${n} new PDF(s)` + (result.length > n ? `, ${result.length - n} duplicate/skipped` : ""));
    runQueue();
    return { documents: result };
  });
  route("GET", "/api/documents", async () => (await all("docs")).map((d) => {
    const ex = d.extraction || {};
    return { id: d.id, filename: d.filename, status: d.status, error: d.error, pages: d.pages, ocr_pages: d.ocr_pages, uploaded_at: d.uploaded_at, edited: d.edited, progress: d.progress,
      document_type: ex.document_type, agreement_date: ex.agreement_date, fund_entity: ex.fund_entity, distributor: ex.distributor, funds: (ex.funds || []).length,
      classes: (ex.funds || []).reduce((a, f) => a + (f.share_classes || []).length, 0), isins: (ex.isins || []).length, warnings: (ex.warnings || []).length };
  }));
  route("GET", "/api/documents/:id", async ({ p }) => { const d = await get("docs", +p.id); if (!d) throw new Error("Not found"); return d; });
  route("PUT", "/api/documents/:id/extraction", async ({ p, json }) => { const d = await get("docs", +p.id); await put("docs", { ...d, extraction: json, edited: 1 }); await log("edit", `Extraction of ${d.filename} edited manually`); return { ok: true }; });
  route("POST", "/api/documents/:id/reprocess", async ({ p, query }) => { const d = await get("docs", +p.id); await put("docs", { ...d, status: "queued", edited: 0 }); queue.push({ id: +p.id, ocr: query.get("ocr") || "auto" }); runQueue(); return { ok: true }; });
  route("GET", "/api/documents/:id/pdf", async ({ p }) => { const b = await get("pdfs", +p.id); return { blobUrl: URL.createObjectURL(new Blob([b], { type: "application/pdf" })) }; });
  route("DELETE", "/api/documents/:id", async ({ p }) => { const d = await get("docs", +p.id); await del("docs", +p.id); await del("pdfs", +p.id); if (d) await log("delete", `Deleted ${d.filename}`); return { ok: true }; });
  route("GET", "/api/coverage", async () => C.coverageOnlyOverview(await doneDocs()));

  route("GET", "/api/universe", async () => {
    const g = new Map();
    for (const r of await all("universe")) {
      const k = r.source + "\u0001" + (r.umbrella || "");
      if (!g.has(k)) g.set(k, { source: r.source, umbrella: r.umbrella, funds: new Set(), classes: 0, loaded_at: r.loaded_at });
      const e = g.get(k); e.funds.add(r.fund_id || r.fund_name); e.classes++; if (r.loaded_at > e.loaded_at) e.loaded_at = r.loaded_at;
    }
    return [...g.values()].map((e) => ({ ...e, funds: e.funds.size })).sort((a, b) => (a.source + (a.umbrella || "") < b.source + (b.umbrella || "") ? -1 : 1));
  });
  route("DELETE", "/api/universe", async ({ query }) => {
    const src = query.get("source"), umb = query.get("umbrella");
    const rows = await all("universe");
    await tx("universe", "readwrite", (s) => { for (const r of rows) if ((!src || r.source === src) && (!umb || r.umbrella === umb)) s.delete(r.id); });
    await log("universe", `Removed public data: ${src || "all sources"}${umb ? " / " + umb : ""}`);
    return { ok: true };
  });
  route("POST", "/api/universe/sec/dataset", async ({ body }) => {
    const file = body.get("file"); const text = await file.text();
    const rows = C.parseCsv(text.slice(0, 5000));
    if (!rows.length || !C.isSecDataset(rows[0])) throw new Error("This is not the SEC 'Investment Company Series and Class Information' CSV.");
    await put("kv", { name: file.name, text, loaded_at: now() }, "sec_csv");
    secCache = null;
    const idx = await secIndex();
    await log("universe", `SEC dataset imported: ${file.name} (${idx.index.length} share classes)`);
    return { name: file.name, rows: idx.index.length };
  });
  route("GET", "/api/universe/sec/info", async () => { const raw = await get("kv", "sec_csv"); return raw ? { name: raw.name, loaded_at: raw.loaded_at } : null; });
  route("GET", "/api/universe/sec/search", async ({ query }) => { const s = await secIndex(); return { dataset: s.name, results: C.secSearch(s.index, query.get("q") || "") }; });
  route("GET", "/api/universe/sec/suggest", async () => {
    const s = await secIndex(); const names = [];
    for (const d of await doneDocs()) {
      const ex = d.extraction || {};
      const cands = [...[ex.fund_entity, ...(ex.funds || []).map((f) => f.umbrella)].map((n) => [n, 0.8]), ...(ex.funds || []).slice(0, 2).map((f) => [f.name, 0.95])];
      for (const [n, min] of cands) for (const part of String(n || "").split(", ")) if (part && !names.some(([x]) => x === part)) names.push([part, min]);
    }
    const out = [], seen = new Set();
    for (const [n, min] of names.slice(0, 40)) {
      const hits = C.secSearch(s.index, n, 3).filter((h) => h.score >= min && !seen.has(h.cik));
      hits.forEach((h) => seen.add(h.cik));
      if (hits.length) out.push({ query: n, results: hits });
    }
    return out;
  });
  route("POST", "/api/universe/sec", async ({ json }) => {
    const s = await secIndex(); let added = 0;
    for (const cik of json.ciks || []) { const recs = C.secLoad(s.index, cik, `SEC series/class dataset (${s.name})`); added += await addUniverse(recs); await log("universe", `SEC: loaded ${recs[0] ? recs[0].umbrella : cik} (${recs.length} share classes)`); }
    return { added, dataset: s.name };
  });
  route("POST", "/api/universe/gleif", async () => {
    const names = C.coverageOnlyOverview(await doneDocs()).map((f) => f.fund_name).slice(0, 200);
    const { records, report } = await gleifLoad(names);
    const added = await addUniverse(records);
    await log("universe", `GLEIF: LEI found for ${report.filter((r) => r.lei).length}/${report.length} funds, ${added} new records`);
    return { added, report };
  });
  route("POST", "/api/universe/import", async ({ body, query }) => {
    const file = body.get("file"), rows = await readTable(file);
    if (rows.length && C.isSecDataset(rows[0])) throw new Error("This is the SEC dataset – please use “Import SEC dataset” in the SEC box.");
    const { records, warnings } = C.importRows(file.name, rows, query.get("source") || "Import");
    const added = await addUniverse(records);
    await log("universe", `Imported ${file.name}: ${records.length} rows, ${added} new`);
    return { added, rows: records.length, warnings };
  });
  route("GET", "/api/overview", overview);

  route("GET", "/api/watchlist", watchlist);
  route("POST", "/api/watchlist/status", async ({ json }) => {
    const keys = json.keys || [], status = json.status;
    if (!["open", "confirmed", "dismissed", "added"].includes(status) || !keys.length) throw new Error("keys and a valid status are required");
    if (status === "added" && !json.doc_id) throw new Error("Choose an agreement");
    const states = Object.fromEntries((await all("watch")).map((w) => [w.key, w]));
    await tx("watch", "readwrite", (s) => { for (const k of keys) s.put({ ...(states[k] || { key: k, first_seen: now() }), status, doc_id: status === "added" ? json.doc_id : null, updated_at: now() }); });
    const doc = json.doc_id ? await get("docs", json.doc_id) : null;
    const label = { open: "re-opened", confirmed: "confirmed as gap", dismissed: "dismissed", added: "added to agreement" }[status];
    await log("watchlist", `${keys.length} item(s) ${label}: ${keys.slice(0, 5).join(", ")}${keys.length > 5 ? " …" : ""}${doc ? " → " + doc.filename : ""}`);
    return { ok: true };
  });

  route("GET", "/api/email/providers", async () => {
    const agg = new Map();
    for (const i of await watchlist()) {
      if (["dismissed", "added"].includes(i.status)) continue;
      if (!agg.has(i.umbrella)) agg.set(i.umbrella, { provider: i.umbrella, open: 0, confirmed: 0, retro: 0 });
      const a = agg.get(i.umbrella); a[i.status] = (a[i.status] || 0) + 1; if (i.pays_retro) a.retro++;
    }
    return [...agg.values()].sort((a, b) => (a.provider < b.provider ? -1 : 1));
  });
  route("GET", "/api/email/draft", async ({ query }) => {
    const provider = query.get("provider"), scope = query.get("scope") || "confirmed", retroOnly = query.get("retro_only") === "true";
    let items = (await watchlist()).filter((i) => i.umbrella === provider && !["dismissed", "added"].includes(i.status));
    if (scope === "confirmed") items = items.filter((i) => i.status === "confirmed");
    if (retroOnly) items = items.filter((i) => i.pays_retro);
    return C.emailDraft(provider, items, query.get("lang") || "en");
  });
  route("POST", "/api/email/eml", async ({ json }) => {
    await log("email", `E-mail draft created: ${json.subject || ""}`);
    const name = String(json.subject || "email").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60) + ".eml";
    return { download: { name, blob: new Blob([C.emlFile(json)], { type: "message/rfc822" }) } };
  });

  route("GET", "/api/manual", async () => ({ content: (await get("kv", "manual")) || defaultManual(), path: "stored in this browser – use “Download .md” to keep a file copy" }));
  route("PUT", "/api/manual", async ({ json }) => { await put("kv", json.content || "", "manual"); await log("manual", "User manual edited"); return { ok: true }; });
  route("POST", "/api/manual/reset", async () => { await del("kv", "manual"); return { content: defaultManual(), path: "" }; });

  route("GET", "/api/events", async () => (await all("events")).sort((a, b) => b.id - a.id).slice(0, 500));
  route("POST", "/api/reset", async () => {
    for (const s of ["docs", "pdfs", "universe", "watch", "events"]) await clear(s);
    await log("reset", "All data was reset");
    return { ok: true };
  });

  route("GET", "/api/export/overview.csv", async ({ query }) => {
    const onlyDelta = query.get("only_delta") === "true", onlyRetro = query.get("only_retro") === "true";
    const ov = await overview(), rows = [];
    for (const u of ov.umbrellas) for (const f of u.funds) for (const c of f.classes) {
      if (onlyDelta && c.status === "covered") continue;
      if (onlyRetro && !c.pays_retro) continue;
      rows.push([u.name, f.fund_id, f.fund_name, c.class_id, c.class_name, c.isin, c.ticker, c.currency, c.retro, c.retro_basis, c.status, c.via, c.documents.join(", "), f.sources.join(", ")]);
    }
    return csvResponse(rows, ["Umbrella", "Fund ID", "Fund", "Class ID", "Share class", "ISIN", "Ticker", "Currency", "Retrocession", "Retro basis", "Status", "Matched via", "Agreements", "Data source"],
      "distrimatcher_" + (onlyDelta ? "gaps" : "overview") + (onlyRetro ? "_retro" : "") + ".csv");
  });
  route("GET", "/api/export/extraction.csv", async () => {
    const rows = [];
    for (const d of await all("docs")) {
      const ex = d.extraction || {};
      const base = [d.filename, ex.document_type, ex.agreement_date, ex.fund_entity, ex.distributor, ex.management_company, ex.governing_law, (ex.territory || []).join(", "), ex.termination_notice, ex.exclusivity];
      for (const f of (ex.funds && ex.funds.length ? ex.funds : [{ name: null, share_classes: [] }])) for (const c of (f.share_classes && f.share_classes.length ? f.share_classes : [{}]))
        rows.push([...base, (ex.retrocession || {}).rate, f.umbrella, f.name, f.all_classes ? "yes" : "", c.name, c.isin, c.fee, c.retro === true ? "yes" : c.retro === false ? "no" : ""]);
    }
    return csvResponse(rows, ["Document", "Type", "Date", "Fund entity", "Distributor", "Management company", "Governing law", "Territory", "Notice period", "Exclusivity", "Retro rate (agreement)", "Umbrella", "Fund", "All classes", "Share class", "ISIN", "Fee", "Retrocession"], "distrimatcher_extraction.csv");
  });

  /* project file: everything in one JSON (PDFs included as base64) */
  route("GET", "/api/project/export", async () => {
    const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
    const docs = await all("docs"), pdfs = {};
    for (const d of docs) { const b = await get("pdfs", d.id); if (b) pdfs[d.id] = b64(new Uint8Array(b)); }
    const data = { app: "Distrimatcher", version: VERSION, saved_at: now(), docs, pdfs, universe: await all("universe"), watch: await all("watch"), events: await all("events"), manual: (await get("kv", "manual")) || null };
    await log("project", "Project file saved");
    return { download: { name: `distrimatcher-project-${now().slice(0, 10)}.json`, blob: new Blob([JSON.stringify(data)], { type: "application/json" }) } };
  });
  route("POST", "/api/project/import", async ({ body }) => {
    const data = JSON.parse(await body.get("file").text());
    if (data.app !== "Distrimatcher") throw new Error("Not a Distrimatcher project file");
    for (const s of ["docs", "pdfs", "universe", "watch", "events"]) await clear(s);
    await tx("docs", "readwrite", (s) => data.docs.forEach((d) => s.put(d)));
    await tx("pdfs", "readwrite", (s) => Object.entries(data.pdfs || {}).forEach(([id, b]) => { const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); s.put(u, +id); }));
    await tx("universe", "readwrite", (s) => data.universe.forEach((r) => s.put(r)));
    await tx("watch", "readwrite", (s) => data.watch.forEach((r) => s.put(r)));
    await tx("events", "readwrite", (s) => data.events.forEach((r) => s.put(r)));
    if (data.manual) await put("kv", data.manual, "manual");
    await log("project", `Project file opened (saved ${data.saved_at})`);
    return { ok: true, docs: data.docs.length };
  });

  async function api(url, opts = {}) {
    const u = new URL(url, "http://local");
    const method = (opts.method || "GET").toUpperCase();
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(u.pathname);
      if (!m) continue;
      const body = opts.body;
      let json = null;
      if (typeof body === "string") { try { json = JSON.parse(body); } catch { throw new Error("Invalid JSON"); } }
      return r.fn({ p: m.groups || {}, query: u.searchParams, body, json });
    }
    throw new Error(`Unknown route ${method} ${u.pathname}`);
  }
  // resume documents interrupted by closing the page
  (async () => { try { for (const d of await all("docs")) if (d.status === "queued" || d.status === "processing") queue.push({ id: d.id, ocr: "auto" }); runQueue(); } catch {} })();

  root.DMLocal = { api, VERSION };
})(globalThis);
