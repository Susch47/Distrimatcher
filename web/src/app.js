"use strict";
/* ============================================================ helpers */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (name, cls = "ic") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
/* local "backend" (IndexedDB) instead of a server */
function saveBlob(name, blob) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
const api = async (url, opts = {}) => {
  const r = await DMLocal.api(url, opts);
  if (r && r.download) { saveBlob(r.download.name, r.download.blob); return r; }
  return r;
};
const postJSON = (url, body) => api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const toast = (msg) => { const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), 3200); };
const debounce = (fn, ms = 200) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
const busy = async (btn, fn) => { if (btn) btn.disabled = true; try { await fn(); } catch (e) { toast("Error: " + e.message); } finally { if (btn) btn.disabled = false; } };
const fmtDate = (s) => { if (!s) return ""; const d = new Date(s.replace(" ", "T") + "Z"); return isNaN(d) ? s : d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }); };
const fmtTime = (s) => { if (!s) return ""; const d = new Date(s.replace(" ", "T") + "Z"); return isNaN(d) ? s : d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); };
const short = (p) => String(p || "").split("/").pop();

/* sortable tables: click header -> sort state per table */
const sortState = {};
function sortRows(tableId, rows, defaultKey) {
  const st = sortState[tableId] || { key: defaultKey, dir: 1 };
  const k = st.key;
  return [...rows].sort((a, b) => {
    const x = a[k] ?? "", y = b[k] ?? "";
    const r = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "en", { numeric: true, sensitivity: "base" });
    return r * st.dir;
  });
}
function bindSort(tableId, render, defaultKey) {
  sortState[tableId] = sortState[tableId] || { key: defaultKey, dir: 1 };
  $$(`#${tableId} th[data-sort]`).forEach((th) => th.addEventListener("click", () => {
    const st = sortState[tableId];
    st.dir = st.key === th.dataset.sort ? -st.dir : 1; st.key = th.dataset.sort; render();
  }));
}
function paintSort(tableId) {
  const st = sortState[tableId];
  $$(`#${tableId} th[data-sort]`).forEach((th) => { th.classList.toggle("asc", th.dataset.sort === st.key && st.dir === 1); th.classList.toggle("desc", th.dataset.sort === st.key && st.dir === -1); });
}

/* ============================================================ navigation */
let currentTab = "agreements";
function goto(tab) {
  currentTab = tab;
  $$(".step").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === "tab-" + tab));
  window.scrollTo({ top: 0 });
  ({ agreements: loadDocs, overview: loadOverview, watchlist: loadWatchlist, email: loadProviders, log: loadLog })[tab]?.();
}
$$(".step").forEach((b) => b.addEventListener("click", () => goto(b.dataset.tab)));
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-goto]"); if (g) { e.preventDefault(); goto(g.dataset.goto); }
  const m = e.target.closest("[data-open-manual]"); if (m) openManual();
});

async function loadStatus() {
  const s = await api("/api/status");
  $("#status-pill").innerHTML = `<span class="dot"></span>Offline app <span class="dot ${s.ocr ? "" : "off"}"></span>OCR`;
  $("#status-pill").title = `Version ${s.version}\nData: stored only in this browser (IndexedDB)\nOCR: ${s.ocr ? "built in" : "not available"}`;
  $("#data-path").textContent = `Version ${s.version} · Data is stored only in this browser on this computer. Use “Save project” to keep a file copy (e.g. next to this HTML file) – clearing the browser data deletes the in-browser copy.`;
}

/* ============================================================ 1 AGREEMENTS */
const drop = $("#drop");
["dragenter", "dragover"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (ev) => upload(ev.dataTransfer.files));
$("#file").addEventListener("change", (ev) => { upload(ev.target.files); ev.target.value = ""; });

async function upload(files) {
  if (!files?.length) return;
  const fd = new FormData();
  [...files].forEach((f) => fd.append("files", f));
  $("#upload-msg").textContent = "Uploading …";
  try {
    const r = await api(`/api/upload?ocr=${$("#ocr").value}`, { method: "POST", body: fd });
    const n = r.documents.filter((d) => d.id && !d.duplicate).length;
    const dup = r.documents.filter((d) => d.duplicate).length;
    const err = r.documents.filter((d) => d.error);
    $("#upload-msg").textContent = `${n} PDF(s) being read` + (dup ? ` · ${dup} already uploaded` : "") + (err.length ? ` · ${err.map((e) => e.error).join("; ")}` : "");
    poll();
  } catch (e) { $("#upload-msg").textContent = "Error: " + e.message; }
}

let docs = [], coverage = [], pollTimer = null;
async function loadDocs() {
  [docs, coverage] = await Promise.all([api("/api/documents"), api("/api/coverage")]);
  $("#agreements-body").hidden = docs.length === 0;
  renderDocs(); renderCovKpis(); renderCoverage();
  return docs;
}
function poll() {
  clearTimeout(pollTimer);
  loadDocs().then((d) => {
    if (d.some((x) => x.status === "queued" || x.status === "processing")) { pollTimer = setTimeout(poll, 1200); return; }
    if (/being read/.test($("#upload-msg").textContent)) $("#upload-msg").textContent = `All ${d.length} agreement${d.length === 1 ? "" : "s"} read.`;
    refreshWatchCount();
  });
}
const statusBadge = (s) => ({ done: '<span class="badge b-ok">done</span>', error: '<span class="badge b-gap">error</span>', processing: '<span class="badge">reading …</span>', queued: '<span class="badge b-mute">queued</span>' }[s] || esc(s));

function renderDocs() {
  const q = $("#doc-filter").value.toLowerCase();
  const rows = sortRows("doc-table", docs.filter((d) => !q || JSON.stringify(d).toLowerCase().includes(q)), "filename");
  paintSort("doc-table");
  $("#doc-table tbody").innerHTML = rows.map((d) => `
    <tr class="click" data-id="${d.id}">
      <td>${icon("file")} ${esc(short(d.filename))}${d.ocr_pages ? ` <span class="badge" title="pages read with OCR">OCR ${d.ocr_pages}/${d.pages}</span>` : ""}${d.edited ? ' <span class="badge b-mute">edited</span>' : ""}</td>
      <td>${statusBadge(d.status)}${d.progress ? ` <span class="muted small">p. ${esc(d.progress)}</span>` : ""}</td><td>${esc(d.document_type || "")}</td><td>${esc(d.agreement_date || "")}</td>
      <td>${esc(d.fund_entity || "")}</td><td>${esc(d.distributor || "")}</td>
      <td class="num">${d.funds}</td><td class="num">${d.classes}</td><td class="num">${d.isins}</td>
      <td class="num">${d.warnings ? `<span class="badge b-warn">${d.warnings}</span>` : ""}${d.error ? `<span class="badge b-gap" title="${esc(d.error)}">!</span>` : ""}</td>
    </tr>`).join("");
  $$("#doc-table tbody tr").forEach((tr) => tr.addEventListener("click", () => openDoc(+tr.dataset.id)));
}
bindSort("doc-table", renderDocs, "filename");
$("#doc-filter").addEventListener("input", debounce(renderDocs));

function renderCovKpis() {
  const nCls = coverage.reduce((a, f) => a + f.classes.length, 0);
  const nIsin = coverage.reduce((a, f) => a + f.classes.filter((c) => c.isin).length, 0);
  const nRetro = coverage.reduce((a, f) => a + f.classes.filter((c) => c.retro === true).length, 0);
  $("#cov-kpis").innerHTML = [["Agreements", docs.filter((d) => d.status === "done").length], ["Funds", coverage.length], ["Share classes", nCls], ["With ISIN", nIsin], ["Paying retro", nRetro]]
    .map(([l, v]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
}
const retroBadge = (v, basis) => {
  const t = basis ? ` title="basis: ${esc(basis)}"` : "";
  if (v === true || v === "yes") return `<span class="badge b-retro"${t}>retro</span>`;
  if (v === false || v === "no") return `<span class="badge b-mute"${t}>clean</span>`;
  if (v) return `<span class="badge b-retro"${t}>${esc(v)}</span>`;
  return '<span class="muted small">unknown</span>';
};
function renderCoverage() {
  const q = $("#cov-filter").value.toLowerCase();
  const sort = $("#cov-sort").value;
  let list = coverage.filter((f) => !q || JSON.stringify(f).toLowerCase().includes(q));
  list.sort((a, b) => sort === "classes" ? b.classes.length - a.classes.length : a.fund_name.localeCompare(b.fund_name) * (sort === "name-desc" ? -1 : 1));
  const groups = {};
  list.forEach((f) => (groups[f.umbrella || "(no umbrella)"] ||= []).push(f));
  const keys = Object.keys(groups).sort((a, b) => a.localeCompare(b) * (sort === "name-desc" ? -1 : 1));
  $("#cov-tree").innerHTML = keys.map((u) => `
    <details class="umb" open><summary>${esc(u)} <span class="badge b-mute">${groups[u].length} funds</span></summary><div class="inner">
    ${groups[u].map((f) => `
      <details><summary><span class="fname">${esc(f.fund_name)}</span>
        ${f.all_classes ? '<span class="badge b-ok">all share classes</span>' : `<span class="badge b-mute">${f.classes.length} classes</span>`}
        <span class="docs">${esc(f.documents.map(short).join(", "))}</span></summary>
        <div class="cls">${f.classes.length ? `<table class="data"><thead><tr><th>Share class</th><th>ISIN</th><th>Fee</th><th>Retro</th><th>Agreement</th></tr></thead><tbody>
          ${f.classes.map((c) => `<tr><td>${esc(c.name || "–")}</td><td class="mono">${esc(c.isin || "")}</td><td>${esc(c.fee || "")}</td><td>${retroBadge(c.retro, "agreement")}</td><td class="docs">${esc(c.documents.map(short).join(", "))}</td></tr>`).join("")}
        </tbody></table>` : '<p class="muted small">No individual share classes named.</p>'}</div>
      </details>`).join("")}
    </div></details>`).join("") || '<p class="empty">No funds detected yet.</p>';
}
$("#cov-filter").addEventListener("input", debounce(renderCoverage));
$("#cov-sort").addEventListener("change", renderCoverage);

/* ------------------------------ document drawer */
let current = null;
async function openDoc(id, showPdf = false) {
  current = await api(`/api/documents/${id}`);
  const ex = current.extraction || {};
  $("#d-title").innerHTML = `${icon("file")} ${esc(short(current.filename))}`;
  const pdfUrl = (await api(`/api/documents/${id}/pdf`)).blobUrl;
  $("#d-pdf").href = pdfUrl; $("#d-pdf").download = short(current.filename);
  const F = (label, v) => `<dt>${label}</dt><dd>${v && (!Array.isArray(v) || v.length) ? esc(Array.isArray(v) ? v.join(", ") : v) : '<span class="muted">–</span>'}</dd>`;
  const r = ex.retrocession || {};
  $("#d-body").innerHTML = `
    ${current.error ? `<div class="note">${esc(current.error)}</div>` : ""}
    ${(ex.warnings || []).map((w) => `<div class="note">${esc(w)}</div>`).join("")}
    <details class="sec" id="d-pdfsec" ${showPdf ? "open" : ""}><summary>Agreement (PDF)</summary><iframe class="pdf" data-src="${pdfUrl}" title="PDF"></iframe></details>
    <details class="sec" open><summary>Key terms</summary><dl class="fields">
      ${F("Document type", ex.document_type)}${F("Title", ex.title)}${F("Date", ex.agreement_date)}${F("Effective", ex.effective_date)}
      ${F("Fund entity / umbrella", ex.fund_entity)}${F("Distributor", ex.distributor)}${F("Management company", ex.management_company)}
      ${F("Investment adviser", ex.investment_adviser)}${F("Governing law", ex.governing_law)}${F("Jurisdiction", ex.jurisdiction)}
      ${F("Territory", ex.territory)}${F("Exclusivity", ex.exclusivity)}${F("Notice period", ex.termination_notice)}${F("Term", ex.term)}
      ${F("Signatories", ex.signatories)}${F("LEIs", ex.leis)}${F("Pages / OCR", current.pages != null ? `${current.pages} / ${current.ocr_pages}` : "")}
    </dl></details>
    <details class="sec" open><summary>Retrocession / trail</summary><dl class="fields">
      <dt>Agreed</dt><dd>${r.agreed === true ? "yes" : r.agreed === false ? "no" : '<span class="muted">not detected</span>'}</dd>
      <dt>Rate</dt><dd>${esc(r.rate || "–")}</dd>
      <dt>Applies to classes</dt><dd>${esc((r.included_classes || []).join(", ") || "all (unless excluded)")}</dd>
      <dt>Excluded classes</dt><dd>${esc((r.excluded_classes || []).join(", ") || "–")}</dd></dl>
      ${(r.terms || []).length ? `<ul class="small">${r.terms.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}</details>
    <details class="sec" open><summary>Parties</summary>
      ${(ex.parties || []).length ? `<table class="data"><thead><tr><th>Name</th><th>Defined as</th><th>Role</th></tr></thead><tbody>${ex.parties.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.alias || "")}</td><td>${esc(p.role.replace("_", " "))}</td></tr>`).join("")}</tbody></table>` : '<p class="muted small">None detected.</p>'}</details>
    <details class="sec" open><summary>Funds &amp; share classes (${(ex.funds || []).length})</summary>
      ${(ex.funds || []).map((f) => `<p class="small"><span class="fname">${esc(f.name)}</span> ${f.umbrella ? `<span class="badge b-mute">${esc(f.umbrella)}</span>` : ""} ${f.all_classes ? '<span class="badge b-ok">all share classes</span>' : ""}</p>
        ${f.share_classes.length ? `<table class="data"><tbody>${f.share_classes.map((c) => `<tr><td>${esc(c.name || "–")}</td><td class="mono">${esc(c.isin || "")}</td><td>${esc(c.currency || "")}</td><td>${esc(c.fee || "")}</td><td>${retroBadge(c.retro, "agreement")}</td></tr>`).join("")}</tbody></table>` : ""}`).join("")}</details>
    <details class="sec"><summary>Fee clauses</summary>${(ex.fees || []).length ? `<ul class="small">${ex.fees.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : '<p class="muted small">None detected.</p>'}</details>
    <details class="sec"><summary>Edit extraction (JSON)</summary>
      <textarea class="code" id="d-json">${esc(JSON.stringify(ex, null, 2))}</textarea>
      <div class="row mt"><button class="btn" id="d-save">Save</button></div></details>
    <details class="sec"><summary>Full text</summary><pre class="raw">${esc(current.text || "")}</pre></details>`;
  const loadPdf = () => { const f = $("#d-pdfsec iframe"); if ($("#d-pdfsec").open && !f.src) f.src = f.dataset.src; };
  $("#d-pdfsec").addEventListener("toggle", loadPdf); loadPdf();
  $("#d-save")?.addEventListener("click", async () => {
    try { await api(`/api/documents/${id}/extraction`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: $("#d-json").value }); toast("Saved"); loadDocs(); }
    catch (e) { toast("Error: " + e.message); }
  });
  $("#drawer").classList.add("open"); $("#scrim").classList.add("open");
}
const closeDrawer = () => { $("#drawer").classList.remove("open"); $("#scrim").classList.remove("open"); };
$("#d-close").addEventListener("click", closeDrawer);
$("#scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeDrawer(); $("#manual").hidden = true; $("#add-modal").hidden = true; } });
$("#d-delete").addEventListener("click", async () => {
  if (!current || !confirm(`Delete "${short(current.filename)}"?`)) return;
  await api(`/api/documents/${current.id}`, { method: "DELETE" }); closeDrawer(); loadDocs();
});
$("#d-reprocess").addEventListener("click", async () => {
  if (!current) return;
  await api(`/api/documents/${current.id}/reprocess?ocr=${$("#ocr").value}`, { method: "POST" }); closeDrawer(); poll();
});

/* ============================================================ 2 OVERVIEW */
function renderSecResults(groups) {
  $("#sec-results").innerHTML = groups.map((g) => `${g.query ? `<div class="q">${esc(g.query)}</div>` : ""}
    ${g.results.map((r, i) => `<label><input type="checkbox" value="${esc(r.cik)}" ${i === 0 && r.score >= 0.9 ? "checked" : ""}><span>${esc(r.entity_name)} <span class="muted small">· CIK ${esc(r.cik)} · ${r.classes} classes${r.match ? " · " + esc(r.match) : ""}</span></span></label>`).join("")}`).join("")
    + (groups.length ? '<div class="row mt"><button class="btn" id="sec-load">Load selected</button></div>' : '<p class="muted small">No matches.</p>');
  $("#sec-load")?.addEventListener("click", (ev) => busy(ev.target, async () => {
    const ciks = $$("#sec-results input:checked").map((i) => i.value);
    if (!ciks.length) return toast("Nothing selected");
    const r = await postJSON("/api/universe/sec", { ciks });
    toast(`${r.added} share classes loaded`); $("#sec-results").innerHTML = ""; loadOverview(); refreshWatchCount();
  }));
}
$("#sec-suggest").addEventListener("click", (ev) => busy(ev.target, async () => {
  renderSecResults(await api("/api/universe/sec/suggest"));
}));
async function secInfo() {
  const i = await api("/api/universe/sec/info");
  $("#sec-info").innerHTML = i ? `${icon("check")} Dataset: ${esc(i.name)} <span class="muted">· imported ${fmtDate(i.loaded_at)}</span>` : "No SEC dataset imported yet.";
  $("#sec-suggest").disabled = !i; $("#sec-q").disabled = !i;
}
$("#sec-file").addEventListener("change", async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  const fd = new FormData(); fd.append("file", f);
  $("#sec-info").textContent = "Reading the SEC dataset …";
  try { const r = await api("/api/universe/sec/dataset", { method: "POST", body: fd }); toast(`SEC dataset imported: ${r.rows.toLocaleString("en")} share classes`); }
  catch (e) { toast("Error: " + e.message); }
  ev.target.value = ""; secInfo();
});
$("#sec-q").addEventListener("keydown", (ev) => ev.key === "Enter" && busy(null, async () => {
  const q = $("#sec-q").value.trim(); if (!q) return;
  const r = await api(`/api/universe/sec/search?q=${encodeURIComponent(q)}`);
  renderSecResults([{ query: "", results: r.results }]);
}));
$("#gleif-load").addEventListener("click", (ev) => busy(ev.target, async () => {
  $("#gleif-report").textContent = "Querying GLEIF …";
  const r = await postJSON("/api/universe/gleif", {});
  const found = r.report.filter((x) => x.lei);
  $("#gleif-report").innerHTML = `${r.added} records loaded · LEI found for ${found.length}/${r.report.length} funds · ${found.reduce((a, x) => a + x.isins, 0)} ISINs`;
  loadOverview(); refreshWatchCount();
}));
$("#imp-file").addEventListener("change", async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  const fd = new FormData(); fd.append("file", f);
  try {
    const r = await api(`/api/universe/import?source=${encodeURIComponent("Import: " + f.name)}`, { method: "POST", body: fd });
    $("#imp-msg").innerHTML = `${r.added} new records (${r.rows} rows)` + (r.warnings.length ? `<ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "");
    loadOverview(); refreshWatchCount();
  } catch (e) { $("#imp-msg").textContent = "Error: " + e.message; }
  ev.target.value = "";
});

let ov = null, ovStatus = "";
async function loadOverview() {
  if (!docs.length) await loadDocs();
  const hasDocs = docs.some((d) => d.status === "done");
  $("#ov-need-docs").hidden = hasDocs; $("#ov-body").hidden = !hasDocs;
  if (!hasDocs) return;
  secInfo();
  const [sum, data] = await Promise.all([api("/api/universe"), api("/api/overview")]);
  ov = data;
  $("#uni-summary").innerHTML = sum.length ? `<h2 class="section-title">Loaded data</h2>
    <div class="uni-row head"><span>Source</span><span>Umbrella / registrant</span><span class="num">Funds</span><span class="num">Classes</span><span>Loaded</span><span></span></div>
    ${sum.map((s) => `<div class="uni-row"><span title="${esc(s.source)}">${esc(s.source.replace("Import: ", ""))}</span><span title="${esc(s.umbrella || "")}">${esc(s.umbrella || "–")}</span><span class="num">${s.funds}</span><span class="num">${s.classes}</span><span class="muted small">${fmtTime(s.loaded_at)}</span>
      <button class="icon-btn" title="Remove" data-src="${esc(s.source)}" data-umb="${esc(s.umbrella || "")}">${icon("trash")}</button></div>`).join("")}` : "";
  $$("#uni-summary [data-src]").forEach((b) => b.addEventListener("click", async () => {
    await api(`/api/universe?source=${encodeURIComponent(b.dataset.src)}` + (b.dataset.umb ? `&umbrella=${encodeURIComponent(b.dataset.umb)}` : ""), { method: "DELETE" }); loadOverview(); refreshWatchCount();
  }));
  $("#ov-results").hidden = !sum.length;
  if (sum.length) { renderWaterfall(); renderOverview(); }
}
$$("#ov-status button").forEach((b) => b.addEventListener("click", () => { ovStatus = b.dataset.s; $$("#ov-status button").forEach((x) => x.classList.toggle("on", x === b)); renderOverview(); }));
$("#ov-filter").addEventListener("input", debounce(renderOverview));
$("#ov-nodoc").addEventListener("change", renderOverview);
$("#ov-sort").addEventListener("change", renderOverview);
$("#ov-retro").addEventListener("change", () => { renderWaterfall(); renderOverview(); });

/* ------------------------------ waterfall */
function waterfallData() {
  const retro = $("#ov-retro").checked;
  const inScope = (c) => !retro || c.pays_retro !== false;
  let funds = 0, isins = 0, covered = 0;
  for (const u of ov.umbrellas) for (const f of u.funds) {
    const cls = f.classes.filter(inScope);
    if (cls.length) funds++;
    isins += cls.length;
    covered += cls.filter((c) => c.status === "covered").length;
  }
  const found = coverage.reduce((a, f) => a + f.classes.filter((c) => !retro || c.retro !== false).length, 0);
  return { funds, isins, found, covered, gaps: isins - covered, retro };
}
function renderWaterfall() {
  const d = waterfallData();
  const W = 960, H = 330, padL = 16, padR = 16, top = 34, bottom = 56;
  const bars = [
    { label: "Fund IDs", sub: "funds in public data", v: d.funds, y0: 0, y1: d.funds, kind: "context", tip: "Funds (fund IDs) in the loaded public data" },
    { label: "ISINs", sub: "share classes", v: d.isins, y0: 0, y1: d.isins, kind: "total", tip: "Share classes (ISINs / class IDs) of these funds" + (d.retro ? ", retro-paying or unknown" : "") },
    { label: "Found in agreements", sub: "extracted", v: d.found, y0: 0, y1: d.found, kind: "context", tip: "Share classes extracted from your uploaded agreements" },
    { label: "In agreement", sub: "covered", v: d.covered, y0: d.isins - d.covered, y1: d.isins, kind: "covered", tip: "ISINs matched to an agreement (subtracted)" },
    { label: "Gaps", sub: "not covered", v: d.gaps, y0: 0, y1: d.gaps, kind: "gap", tip: "ISINs without agreement coverage = ISINs − in agreement" },
  ];
  const max = Math.max(1, ...bars.map((b) => b.y1));
  const plotH = H - top - bottom, slot = (W - padL - padR) / bars.length, bw = Math.min(110, slot * 0.56);
  const y = (v) => top + plotH - (v / max) * plotH;
  const color = { context: "var(--context)", total: "var(--accent)", covered: "var(--accent)", gap: "var(--gap)" };
  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`;
  [0.25, 0.5, 0.75, 1].forEach((t) => { svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(max * t)}" y2="${y(max * t)}" stroke="#d9dbe5" stroke-width="1" stroke-dasharray="2 4"/>`; });
  svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" stroke="#b9bdd3"/>`;
  bars.forEach((b, i) => {
    const cx = padL + slot * i + slot / 2, x = cx - bw / 2, y1 = y(b.y1), y0 = y(b.y0), h = Math.max(b.v ? 2 : 0, y0 - y1);
    const r = Math.min(4, h / 2);
    // bar with 4px rounded data-end (top), square base
    svg += `<path d="M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + bw - r} Q${x + bw},${y1} ${x + bw},${y1 + r} V${y0} Z" fill="${color[b.kind]}" ${b.kind === "covered" ? 'fill-opacity=".55"' : ""}/>`;
    if (b.kind === "covered") svg += `<path d="M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + bw - r} Q${x + bw},${y1} ${x + bw},${y1 + r} V${y0} Z" fill="url(#hatch)"/>`;
    svg += `<text x="${cx}" y="${y1 - 9}" text-anchor="middle" font-size="18" fill="#141e55" font-weight="400">${b.kind === "covered" ? "−" : ""}${b.v.toLocaleString("en")}</text>`;
    svg += `<text x="${cx}" y="${H - bottom + 22}" text-anchor="middle" font-size="13.5" fill="#141e55">${esc(b.label)}</text>`;
    svg += `<text x="${cx}" y="${H - bottom + 40}" text-anchor="middle" font-size="12" fill="#6e7395">${esc(b.sub)}</text>`;
    svg += `<rect class="hit" data-i="${i}" x="${cx - slot / 2}" y="${top - 20}" width="${slot}" height="${plotH + 20}" fill="transparent"/>`;
  });
  // connectors ISINs -> covered -> gaps (waterfall steps)
  const cx = (i) => padL + slot * i + slot / 2;
  svg += `<line x1="${cx(1) + bw / 2}" x2="${cx(3) - bw / 2}" y1="${y(d.isins)}" y2="${y(d.isins)}" stroke="#6e7395" stroke-dasharray="3 3"/>`;
  svg += `<line x1="${cx(3) + bw / 2}" x2="${cx(4) - bw / 2}" y1="${y(d.gaps)}" y2="${y(d.gaps)}" stroke="#6e7395" stroke-dasharray="3 3"/>`;
  svg += `<defs><pattern id="hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="6" stroke="#ffffff" stroke-width="1.4" stroke-opacity=".6"/></pattern></defs></svg>`;
  $("#waterfall").innerHTML = svg;
  $("#wf-legend").innerHTML = `<span><i style="background:var(--context)"></i>Context</span><span><i style="background:var(--accent)"></i>ISINs in scope</span><span><i style="background:var(--accent);opacity:.55"></i>Covered (subtracted)</span><span><i style="background:var(--gap)"></i>Gaps</span>${d.retro ? '<span class="muted">· Retro only: clean share classes excluded</span>' : ""}`;
  const tip = $("#wf-tip"), wrap = $(".chart-wrap");
  $$("#waterfall .hit").forEach((h) => {
    h.addEventListener("mousemove", (e) => {
      const b = bars[+h.dataset.i], r = wrap.getBoundingClientRect();
      tip.innerHTML = `<b>${b.v.toLocaleString("en")}</b>${esc(b.label)}<br><span class="muted">${esc(b.tip)}</span>`;
      tip.hidden = false;
      tip.style.left = Math.min(e.clientX - r.left + 14, r.width - 270) + "px"; tip.style.top = (e.clientY - r.top + 14) + "px";
    });
    h.addEventListener("mouseleave", () => (tip.hidden = true));
  });
}

/* ------------------------------ fund tree */
const stBadge = (s) => `<span class="badge ${{ covered: "b-ok", gap: "b-gap", review: "b-warn" }[s] || "b-mute"}">${esc(s)}</span>`;
function renderOverview() {
  if (!ov) return;
  const q = $("#ov-filter").value.toLowerCase(), nodoc = $("#ov-nodoc").checked, onlyRetro = $("#ov-retro").checked, sort = $("#ov-sort").value;
  const sorter = {
    name: (a, b) => a.fund_name.localeCompare(b.fund_name), "name-desc": (a, b) => b.fund_name.localeCompare(a.fund_name),
    id: (a, b) => String(a.fund_id || "").localeCompare(String(b.fund_id || ""), "en", { numeric: true }),
    gaps: (a, b) => b.delta - a.delta || a.fund_name.localeCompare(b.fund_name),
    coverage: (a, b) => a.covered / (a.total || 1) - b.covered / (b.total || 1) || a.fund_name.localeCompare(b.fund_name),
  }[sort];
  const umbs = [...ov.umbrellas].sort((a, b) => a.name.localeCompare(b.name) * (sort === "name-desc" ? -1 : 1));
  let html = "";
  for (const u of umbs) {
    const funds = u.funds.map((f) => ({ ...f, shown: f.classes.filter((c) => (!ovStatus || c.status === ovStatus) && (!onlyRetro || c.pays_retro !== false)
      && (!q || [f.fund_name, f.fund_id, c.class_name, c.isin, c.class_id, c.ticker].join(" ").toLowerCase().includes(q))) }))
      .filter((f) => f.shown.length && (!nodoc || !f.matched_agreements.length)).sort(sorter);
    if (!funds.length) continue;
    html += `<details class="umb" open><summary>${esc(u.name)} <span class="badge b-mute">${funds.length} funds</span></summary><div class="inner">`;
    for (const f of funds) {
      const pc = f.total ? (f.covered / f.total) * 100 : 0, pw = f.total ? (f.check / f.total) * 100 : 0;
      html += `<details ${ovStatus || q ? "open" : ""}><summary>
          <span class="fname">${esc(f.fund_name)}</span><span class="fid">${esc(f.fund_id || "")}</span>
          <span class="bar" title="${f.covered} covered · ${f.check} review · ${f.delta} gaps"><i style="width:${pc}%"></i><b style="width:${pw}%"></b></span>
          <span class="small">${f.covered}/${f.total}</span>
          ${f.delta ? `<span class="badge b-gap">${f.delta} gap${f.delta > 1 ? "s" : ""}</span>` : ""}${f.check ? `<span class="badge b-warn">${f.check} review</span>` : ""}
          ${f.matched_agreements.length ? f.matched_agreement_ids.map((id, i) => `<button class="linkish docs" data-doc="${id}">${icon("ext")} ${esc(short(f.matched_agreements[i]))}</button>`).join(" ") : '<span class="badge b-gap">no agreement</span>'}
        </summary><div class="cls"><table class="data"><thead><tr><th>Class ID</th><th>Share class</th><th>ISIN</th><th>Ticker</th><th>CCY</th><th>Retro</th><th>Status</th><th>Matched via</th></tr></thead><tbody>
        ${f.shown.map((c) => `<tr><td class="mono">${esc(c.class_id || "")}</td><td>${esc(c.class_name || "–")}</td><td class="mono">${esc(c.isin || "")}</td><td class="mono">${esc(c.ticker || "")}</td><td>${esc(c.currency || "")}</td>
          <td>${retroBadge(c.retro, c.retro_basis)} ${c.retro_basis ? `<span class="docs">${esc(c.retro_basis)}</span>` : ""}</td><td>${stBadge(c.status)}</td><td class="small">${esc(c.via || "")}</td></tr>`).join("")}
        </tbody></table></div></details>`;
    }
    html += "</div></details>";
  }
  $("#ov-tree").innerHTML = html || '<p class="empty">No funds for this filter.</p>';
  $$("#ov-tree [data-doc]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); openDoc(+b.dataset.doc, true); }));
  const um = ov.unmatched_agreement_funds;
  $("#unmatched-card").hidden = !um.length;
  $("#unmatched").innerHTML = um.map((x) => `<li><span class="fname">${esc(x.fund_name)}</span><span class="docs">${esc(short(x.doc_name))}</span></li>`).join("");
}

/* ============================================================ 3 WATCHLIST */
let watch = [], wlStatus = "open", selected = new Set();
async function refreshWatchCount() {
  try {
    const w = await api("/api/watchlist");
    const n = w.filter((i) => i.status === "open").length;
    $("#watch-count").hidden = !n; $("#watch-count").textContent = n;
    return w;
  } catch { return []; }
}
async function loadWatchlist() {
  watch = await refreshWatchCount();
  $("#wl-empty").hidden = watch.length > 0; $("#wl-body").hidden = watch.length === 0;
  $("#wl-empty-text").textContent = docs.length ? "No gaps yet. Load public data in the Overview first." : "Upload agreements and load public data first.";
  renderWatchlist();
}
$$("#wl-status button").forEach((b) => b.addEventListener("click", () => { wlStatus = b.dataset.s; $$("#wl-status button").forEach((x) => x.classList.toggle("on", x === b)); selected.clear(); renderWatchlist(); }));
["#wl-retro", "#wl-new"].forEach((s) => $(s).addEventListener("change", renderWatchlist));
$("#wl-filter").addEventListener("input", debounce(renderWatchlist));

function highlight(text, needle) {
  const t = esc(text || "");
  if (!needle) return t;
  const n = esc(needle);
  const i = t.indexOf(n);
  if (i < 0) return t;
  const start = Math.max(0, i - 90), end = Math.min(t.length, i + n.length + 90);
  return (start ? "…" : "") + t.slice(start, i) + `<mark>${n}</mark>` + t.slice(i + n.length, end) + (end < t.length ? "…" : "");
}
const wlBadge = (s) => `<span class="badge ${{ open: "b-gap", confirmed: "b-warn", dismissed: "b-mute", added: "b-ok" }[s]}">${{ open: "open", confirmed: "confirmed", dismissed: "dismissed", added: "added" }[s] || esc(s)}</span>`;
function renderWatchlist() {
  const q = $("#wl-filter").value.toLowerCase(), retro = $("#wl-retro").checked, onlyNew = $("#wl-new").checked;
  const list = sortRows("wl-table", watch.filter((i) => (!wlStatus || i.status === wlStatus) && (!retro || i.pays_retro !== false) && (!onlyNew || i.is_new)
    && (!q || [i.fund_name, i.fund_id, i.isin, i.class_name, i.origin, i.umbrella].join(" ").toLowerCase().includes(q))), "fund_name");
  paintSort("wl-table");
  $("#wl-nomatch").hidden = list.length > 0;
  $("#wl-table tbody").innerHTML = list.map((i) => `
    <tr class="st-${i.status}" data-key="${esc(i.key)}">
      <td class="cb"><input type="checkbox" ${selected.has(i.key) ? "checked" : ""} aria-label="Select"></td>
      <td class="fund-cell"><b>${esc(i.fund_name)}</b><span class="fid">${esc(i.fund_id || "")}</span><div class="docs">${esc(i.umbrella)}</div></td>
      <td class="mono">${esc(i.isin || i.class_id || "–")}<div class="docs">${esc(i.class_name || "")}</div></td>
      <td><div class="tags">${i.features.map((t) => `<span class="tag ${t.kind}">${esc(t.label)}</span>`).join("")}</div>
        <div class="mt">${retroBadge(i.retro, i.retro_basis)}</div></td>
      <td class="snippet">${highlight(i.origin, i.isin || i.class_id)}${i.origin_url ? `<br><a class="origin-url" href="${esc(i.origin_url)}" target="_blank" rel="noopener">${icon("ext")}${esc(i.origin_url.replace(/^https?:\/\//, "").slice(0, 46))}…</a>` : ""}</td>
      <td><div class="stack">${fmtDate(i.first_seen)}${i.is_new ? '<span class="badge b-new">new</span>' : ""}</div></td>
      <td><div class="stack">${wlBadge(i.status)}${i.gap_status === "review" ? '<span class="badge b-warn">review</span>' : ""}</div></td>
      <td><div class="actions">
        ${i.status !== "confirmed" ? `<button class="btn ghost sm ok" data-act="confirmed">${icon("check")}Confirm</button>` : `<button class="btn ghost sm" data-act="open">Re-open</button>`}
        ${i.status !== "dismissed" ? `<button class="btn ghost sm" data-act="dismissed">${icon("x")}Dismiss</button>` : ""}
        ${i.status !== "added" ? `<button class="btn ghost sm" data-act="add">${icon("plus")}Add to agreement</button>` : ""}
        ${(i.agreement_id || i.agreements.length) ? `<button class="btn ghost sm" data-act="view">${icon("ext")}Open agreement</button>` : ""}
      </div></td>
    </tr>`).join("");
  $$("#wl-table tbody tr").forEach((tr) => {
    const key = tr.dataset.key, item = watch.find((w) => w.key === key);
    $("input", tr).addEventListener("change", (e) => { e.target.checked ? selected.add(key) : selected.delete(key); updateSel(); });
    $$("[data-act]", tr).forEach((b) => b.addEventListener("click", () => watchAction(item, b.dataset.act)));
  });
  $("#wl-all").checked = list.length > 0 && list.every((i) => selected.has(i.key));
  updateSel();
}
function updateSel() {
  $("#wl-selcount").textContent = selected.size ? `${selected.size} selected` : "";
  $("#wl-bulk-confirm").disabled = $("#wl-bulk-dismiss").disabled = !selected.size;
}
bindSort("wl-table", renderWatchlist, "fund_name");
$("#wl-all").addEventListener("change", (e) => {
  $$("#wl-table tbody tr").forEach((tr) => e.target.checked ? selected.add(tr.dataset.key) : selected.delete(tr.dataset.key));
  renderWatchlist();
});
async function setStatus(keys, status, doc_id) {
  await postJSON("/api/watchlist/status", { keys, status, doc_id });
  selected.clear(); await loadWatchlist();
}
$("#wl-bulk-confirm").addEventListener("click", () => setStatus([...selected], "confirmed"));
$("#wl-bulk-dismiss").addEventListener("click", () => setStatus([...selected], "dismissed"));

let addItem = null;
function watchAction(item, act) {
  if (act === "view") return openDoc(item.agreement_id || item.agreements[0].id, true);
  if (act === "add") {
    addItem = item;
    $("#add-what").innerHTML = `<b>${esc(item.fund_name)}</b> · ${esc(item.class_name || "")} · <span class="mono">${esc(item.isin || item.class_id || "")}</span>`;
    const pref = new Set(item.agreements.map((a) => a.id));
    const opts = [...docs].filter((d) => d.status === "done").sort((a, b) => (pref.has(b.id) - pref.has(a.id)) || a.filename.localeCompare(b.filename));
    $("#add-doc").innerHTML = opts.map((d) => `<option value="${d.id}">${esc(short(d.filename))}${pref.has(d.id) ? " (related)" : ""}</option>`).join("");
    $("#add-modal").hidden = false;
    return;
  }
  setStatus([item.key], act);
}
$$("[data-close-add]").forEach((b) => b.addEventListener("click", () => ($("#add-modal").hidden = true)));
$("#add-ok").addEventListener("click", async () => {
  if (!addItem) return;
  await setStatus([addItem.key], "added", +$("#add-doc").value);
  $("#add-modal").hidden = true; toast("Added to agreement – counts as covered now");
});

/* ============================================================ 4 E-MAIL */
let provider = null, emScope = "confirmed", emLang = "en", providers = [];
async function loadProviders() {
  providers = await api("/api/email/providers");
  $("#em-empty").hidden = providers.length > 0; $("#em-body").hidden = providers.length === 0;
  if (!providers.length) return;
  if (!providers.find((p) => p.provider === provider)) provider = (providers.find((p) => p.confirmed) || providers[0]).provider;
  renderProviders(); draft();
}
function renderProviders() {
  $("#em-providers").innerHTML = providers.map((p) => `<li><button class="${p.provider === provider ? "on" : ""}" data-p="${esc(p.provider)}">${esc(p.provider)}
    <span class="meta">${p.confirmed ? `<span class="badge b-warn">${p.confirmed} confirmed</span>` : ""}${p.open ? `<span class="badge b-gap">${p.open} open</span>` : ""}${p.retro ? `<span class="badge b-retro">${p.retro} retro</span>` : ""}</span></button></li>`).join("");
  $$("#em-providers button").forEach((b) => b.addEventListener("click", () => { provider = b.dataset.p; renderProviders(); draft(); }));
}
async function draft() {
  if (!provider) return;
  const d = await api(`/api/email/draft?provider=${encodeURIComponent(provider)}&lang=${emLang}&scope=${emScope}&retro_only=${$("#em-retro").checked}`);
  $("#em-subject").value = d.subject; $("#em-body-text").value = d.body;
  $("#em-info").textContent = `${d.count} share class${d.count === 1 ? "" : "es"} listed` + (emScope === "confirmed" && !d.count ? " – confirm items in the watchlist or choose “All open”" : "");
}
$$("#em-scope button").forEach((b) => b.addEventListener("click", () => { emScope = b.dataset.s; $$("#em-scope button").forEach((x) => x.classList.toggle("on", x === b)); draft(); }));
$$("#em-lang button").forEach((b) => b.addEventListener("click", () => { emLang = b.dataset.s; $$("#em-lang button").forEach((x) => x.classList.toggle("on", x === b)); draft(); }));
$("#em-retro").addEventListener("change", draft);
$("#em-eml").addEventListener("click", (ev) => busy(ev.target, async () => {
  await postJSON("/api/email/eml", { to: $("#em-to").value, cc: $("#em-cc").value, subject: $("#em-subject").value, body: $("#em-body-text").value });
  toast("E-mail saved – open the .eml file to send it from Outlook");
}));
$("#em-mailto").addEventListener("click", () => {
  const url = `mailto:${encodeURIComponent($("#em-to").value)}?cc=${encodeURIComponent($("#em-cc").value)}&subject=${encodeURIComponent($("#em-subject").value)}&body=${encodeURIComponent($("#em-body-text").value)}`;
  if (url.length > 1900) toast("Long message – some mail apps cut it. Prefer “Download .eml”.");
  window.location.href = url;
});
$("#em-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(`${$("#em-subject").value}\n\n${$("#em-body-text").value}`); toast("Copied"); }
  catch { $("#em-body-text").select(); document.execCommand("copy"); toast("Copied"); }
});

/* ============================================================ 5 LOG */
const kindIcon = { upload: "upload", extraction: "doc", universe: "db", watchlist: "eye", email: "mail", reset: "trash", delete: "trash", edit: "edit", manual: "info", error: "x" };
async function loadLog() {
  const ev = await api("/api/events");
  $("#log-empty").hidden = ev.length > 0;
  $("#log-list").innerHTML = ev.map((e) => `<li><span class="when">${fmtTime(e.ts)}</span><span class="kind">${icon(kindIcon[e.kind] || "log")}${esc(e.kind)}</span><span class="msg">${esc(e.message)}</span></li>`).join("");
  loadStatus();
}
$("#reset").addEventListener("click", async () => {
  if (!confirm("Delete all agreements, public data, watchlist decisions and the log? This cannot be undone.")) return;
  await api("/api/reset", { method: "POST" });
  docs = []; coverage = []; ov = null; watch = []; selected.clear();
  toast("All data reset"); refreshWatchCount(); goto("agreements");
});

/* ============================================================ manual (editable markdown file) */
function md(src) {
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");
  const lines = src.replace(/\r/g, "").split("\n"); let out = "", i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^#{1,3} /.test(l)) { const n = l.match(/^#+/)[0].length; out += `<h${n}>${inline(l.slice(n + 1))}</h${n}>`; i++; }
    else if (/^---+\s*$/.test(l)) { out += "<hr>"; i++; }
    else if (/^> /.test(l)) { let b = []; while (i < lines.length && /^> ?/.test(lines[i])) b.push(lines[i++].replace(/^> ?/, "")); out += `<blockquote>${inline(b.join(" "))}</blockquote>`; }
    else if (/^\|/.test(l)) {
      const rows = []; while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|\s*$/g, "").split("|").map((c) => c.trim());
      const body = rows.slice(2);
      out += `<table><thead><tr>${cells(rows[0]).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    }
    else if (/^\s*[-*] /.test(l)) { const it = []; while (i < lines.length && /^\s*[-*] /.test(lines[i])) it.push(lines[i++].replace(/^\s*[-*] /, "")); out += `<ul>${it.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`; }
    else if (/^\s*\d+\. /.test(l)) { const it = []; while (i < lines.length && /^\s*\d+\. /.test(lines[i])) it.push(lines[i++].replace(/^\s*\d+\. /, "")); out += `<ol>${it.map((x) => `<li>${inline(x)}</li>`).join("")}</ol>`; }
    else if (!l.trim()) i++;
    else { const p = []; while (i < lines.length && lines[i].trim() && !/^(#|>|\||\s*[-*] |\s*\d+\. |---)/.test(lines[i])) p.push(lines[i++]); out += `<p>${inline(p.join(" "))}</p>`; }
  }
  return out;
}
async function openManual() {
  const m = await api("/api/manual");
  $("#man-view").innerHTML = md(m.content); $("#man-text").value = m.content;
  $("#man-path").textContent = "The manual is stored in this browser. Use “Download .md” to edit it as a file and “Load .md” to bring it back.";
  setManEdit(false); $("#manual").hidden = false;
}
function setManEdit(on) {
  $("#man-view").hidden = on; $("#man-text").hidden = !on; $("#man-save").hidden = !on; $("#man-default").hidden = !on; $("#man-edit").hidden = on;
}
$("#man-edit").addEventListener("click", () => setManEdit(true));
$("#man-save").addEventListener("click", async () => {
  await api("/api/manual", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: $("#man-text").value }) });
  $("#man-view").innerHTML = md($("#man-text").value); setManEdit(false); toast("Manual saved");
});
$("#man-default").addEventListener("click", async () => {
  if (!confirm("Replace your edited manual with the default text?")) return;
  const m = await postJSON("/api/manual/reset", {}); $("#man-text").value = m.content; $("#man-view").innerHTML = md(m.content); setManEdit(false);
});
$("#man-close").addEventListener("click", () => ($("#manual").hidden = true));
$("#manual").addEventListener("click", (e) => { if (e.target.id === "manual") $("#manual").hidden = true; });

/* ============================================================ exports, project file, manual file */
document.addEventListener("click", (e) => {
  const x = e.target.closest("[data-export]");
  if (x) { e.preventDefault(); busy(x, () => api(x.dataset.export)); }
});
$("#proj-save").addEventListener("click", (ev) => busy(ev.currentTarget, async () => { await api("/api/project/export"); toast("Project file saved – keep it next to the HTML file"); }));
$("#proj-file").addEventListener("change", async (ev) => {
  const f = ev.target.files[0]; ev.target.value = ""; if (!f) return;
  if (!confirm("Open this project file? The data currently in the app will be replaced.")) return;
  const fd = new FormData(); fd.append("file", f);
  try { const r = await api("/api/project/import", { method: "POST", body: fd }); toast(`Project opened (${r.docs} agreements)`); docs = []; ov = null; refreshWatchCount(); goto("agreements"); }
  catch (e) { toast("Error: " + e.message); }
});
$("#man-download").addEventListener("click", () => saveBlob("distrimatcher-manual.md", new Blob([$("#man-text").value], { type: "text/markdown" })));
$("#man-load").addEventListener("change", async (ev) => {
  const f = ev.target.files[0]; ev.target.value = ""; if (!f) return;
  $("#man-text").value = await f.text(); setManEdit(true); toast("File loaded – click Save to use it");
});

/* ============================================================ start */
loadStatus();
poll();
