"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = async (url, opts = {}) => {
  const r = await fetch(url, opts);
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch {} throw new Error(m); }
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text();
};
const toast = (msg) => { const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), 3500); };
const debounce = (fn, ms = 200) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };

const retroBadge = (v, basis) => {
  if (v === true || v === "ja") return `<span class="badge b-retro" title="${esc(basis || "")}">Retro</span>`;
  if (v === false || v === "nein") return `<span class="badge b-mute" title="${esc(basis || "")}">clean</span>`;
  if (v) return `<span class="badge b-retro" title="${esc(basis || "")}">${esc(v)}</span>`;
  return '<span class="muted small">?</span>';
};

/* ---------------- Tabs ---------------- */
$$(".tab").forEach((b) => b.addEventListener("click", () => {
  $$(".tab").forEach((x) => x.classList.toggle("active", x === b));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + b.dataset.tab));
  if (b.dataset.tab === "overview") loadOverview();
}));

/* ---------------- Status ---------------- */
async function loadStatus() {
  const s = await api("/api/status");
  $("#status").innerHTML = `v${esc(s.version)}<span class="dot ${s.ocr ? "" : "off"}"></span>OCR<span class="dot ${s.online ? "" : "off"}"></span>Online-Daten`;
  $("#status").title = `Daten: ${s.data_dir}\nTesseract: ${s.tesseract || "nicht gefunden"}`;
}

/* ================= TEIL 1 ================= */
const drop = $("#drop");
["dragenter", "dragover"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (ev) => upload(ev.dataTransfer.files));
$("#file").addEventListener("change", (ev) => { upload(ev.target.files); ev.target.value = ""; });

async function upload(files) {
  if (!files?.length) return;
  const fd = new FormData();
  [...files].forEach((f) => fd.append("files", f));
  $("#upload-msg").textContent = "Lade hoch …";
  try {
    const r = await api(`/api/upload?ocr=${$("#ocr").value}`, { method: "POST", body: fd });
    const n = r.documents.filter((d) => d.id && !d.duplicate).length;
    const dup = r.documents.filter((d) => d.duplicate).length;
    const err = r.documents.filter((d) => d.error);
    $("#upload-msg").textContent = `${n} PDF(s) in Verarbeitung` + (dup ? ` · ${dup} bereits vorhanden` : "") + (err.length ? ` · Fehler: ${err.map((e) => e.error).join("; ")}` : "");
    poll();
  } catch (e) { $("#upload-msg").textContent = "Fehler: " + e.message; }
}

let docs = [];
let pollTimer = null;
async function loadDocs() {
  docs = await api("/api/documents");
  renderDocs();
  loadCoverage();
  return docs;
}
function poll() {
  clearTimeout(pollTimer);
  loadDocs().then((d) => { if (d.some((x) => x.status === "queued" || x.status === "processing")) pollTimer = setTimeout(poll, 1200); });
}
const statusBadge = (s) => ({ done: '<span class="badge b-ok">fertig</span>', error: '<span class="badge b-bad">Fehler</span>', processing: '<span class="badge b-info">liest …</span>', queued: '<span class="badge b-mute">wartet</span>' }[s] || esc(s));

function renderDocs() {
  const q = $("#doc-filter").value.toLowerCase();
  const rows = docs.filter((d) => !q || JSON.stringify(d).toLowerCase().includes(q));
  $("#doc-empty").hidden = docs.length > 0;
  $("#doc-table tbody").innerHTML = rows.map((d) => `
    <tr data-id="${d.id}">
      <td>${esc(d.filename)}${d.ocr_pages ? ` <span class="badge b-info" title="Seiten per OCR gelesen">OCR ${d.ocr_pages}/${d.pages}</span>` : ""}${d.edited ? ' <span class="badge b-mute">bearbeitet</span>' : ""}</td>
      <td>${statusBadge(d.status)}</td>
      <td>${esc(d.document_type || "")}</td><td>${esc(d.agreement_date || "")}</td>
      <td>${esc(d.fund_entity || "")}</td><td>${esc(d.distributor || "")}</td>
      <td class="num">${d.funds}</td><td class="num">${d.classes}</td><td class="num">${d.isins}</td>
      <td class="num">${d.warnings ? `<span class="badge b-warn">${d.warnings}</span>` : ""}${d.error ? `<span class="badge b-bad" title="${esc(d.error)}">!</span>` : ""}</td>
    </tr>`).join("");
  $$("#doc-table tbody tr").forEach((tr) => tr.addEventListener("click", () => openDoc(+tr.dataset.id)));
}
$("#doc-filter").addEventListener("input", debounce(renderDocs));

let coverage = [];
async function loadCoverage() {
  coverage = await api("/api/coverage");
  const nClasses = coverage.reduce((a, f) => a + f.classes.length, 0);
  const nIsin = coverage.reduce((a, f) => a + f.classes.filter((c) => c.isin).length, 0);
  $("#cov-kpis").innerHTML = [
    ["Dokumente", docs.filter((d) => d.status === "done").length], ["Funds", coverage.length],
    ["Share Classes", nClasses], ["mit ISIN", nIsin], ["mit Retro", coverage.reduce((a, f) => a + f.classes.filter((c) => c.retro === true).length, 0)],
  ].map(([l, v]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
  renderCoverage();
}
function renderCoverage() {
  const q = $("#cov-filter").value.toLowerCase();
  const list = coverage.filter((f) => !q || JSON.stringify(f).toLowerCase().includes(q));
  const groups = {};
  list.forEach((f) => (groups[f.umbrella || "(ohne Zuordnung)"] ||= []).push(f));
  $("#cov-tree").innerHTML = Object.entries(groups).map(([u, fs]) => `
    <details class="umb" open><summary>${esc(u)} <span class="badge b-mute">${fs.length} Funds</span></summary><div class="inner">
    ${fs.map((f) => `
      <details><summary><span class="fname">${esc(f.fund_name)}</span>
        ${f.all_classes ? '<span class="badge b-ok">alle Klassen</span>' : `<span class="badge b-mute">${f.classes.length} Klassen</span>`}
        <span class="docs">${esc(f.documents.join(", "))}</span></summary>
        <div class="cls">${f.classes.length ? `<table class="data"><thead><tr><th>Share Class</th><th>ISIN</th><th>Gebühr</th><th>Retro</th><th>Quelle</th></tr></thead><tbody>
          ${f.classes.map((c) => `<tr><td>${esc(c.name || "–")}</td><td class="mono">${esc(c.isin || "")}</td><td>${esc(c.fee || "")}</td><td>${retroBadge(c.retro, "laut Vertrag")}</td><td class="docs">${esc(c.documents.join(", "))}</td></tr>`).join("")}
        </tbody></table>` : '<p class="muted small">Keine einzelnen Klassen genannt.</p>'}</div>
      </details>`).join("")}
    </div></details>`).join("") || '<p class="empty">Noch keine Funds erkannt.</p>';
}
$("#cov-filter").addEventListener("input", debounce(renderCoverage));

/* ---------------- Detailansicht ---------------- */
let current = null;
async function openDoc(id) {
  current = await api(`/api/documents/${id}`);
  const ex = current.extraction || {};
  $("#d-title").textContent = current.filename;
  $("#d-pdf").href = `/api/documents/${id}/pdf`;
  const F = (label, v) => `<dt>${label}</dt><dd>${v ? esc(Array.isArray(v) ? v.join(", ") : v) : '<span class="muted">–</span>'}</dd>`;
  $("#d-body").innerHTML = `
    ${current.error ? `<div class="warn-box">${esc(current.error)}</div>` : ""}
    ${(ex.warnings || []).map((w) => `<div class="warn-box">${esc(w)}</div>`).join("")}
    <dl class="fields">
      ${F("Dokumenttyp", ex.document_type)}${F("Titel", ex.title)}${F("Datum", ex.agreement_date)}${F("Wirksam ab", ex.effective_date)}
      ${F("Fondsgesellschaft / Umbrella", ex.fund_entity)}${F("Distributor", ex.distributor)}${F("Verwaltungsgesellschaft", ex.management_company)}
      ${F("Investment Adviser", ex.investment_adviser)}${F("Anwendbares Recht", ex.governing_law)}${F("Gerichtsstand", ex.jurisdiction)}
      ${F("Territorium", ex.territory)}${F("Exklusivität", ex.exclusivity)}${F("Kündigungsfrist", ex.termination_notice)}${F("Laufzeit", ex.term)}
      ${F("Unterzeichner", ex.signatories)}${F("LEIs", ex.leis)}${F("Seiten / OCR", current.pages != null ? `${current.pages} / ${current.ocr_pages}` : "")}
    </dl>
    <div class="section-title">Vertragsparteien</div>
    ${(ex.parties || []).length ? `<table class="data"><thead><tr><th>Name</th><th>Definiert als</th><th>Rolle</th></tr></thead><tbody>${ex.parties.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.alias || "")}</td><td>${esc(p.role)}</td></tr>`).join("")}</tbody></table>` : '<p class="muted small">Keine erkannt.</p>'}
    <div class="section-title">Funds &amp; Share Classes (${(ex.funds || []).length})</div>
    ${(ex.funds || []).map((f) => `<details open><summary><span class="fname">${esc(f.name)}</span> ${f.umbrella ? `<span class="badge b-mute">${esc(f.umbrella)}</span>` : ""} ${f.all_classes ? '<span class="badge b-ok">alle Klassen</span>' : ""} <span class="docs">Quelle: ${esc(f.source)}</span></summary>
      <div class="cls">${f.share_classes.length ? `<table class="data"><tbody>${f.share_classes.map((c) => `<tr><td>${esc(c.name || "–")}</td><td class="mono">${esc(c.isin || "")}</td><td>${esc(c.currency || "")}</td><td>${esc(c.fee || "")}</td><td>${retroBadge(c.retro, "laut Vertrag")}</td></tr>`).join("")}</tbody></table>` : ""}</div></details>`).join("")}
    <div class="section-title">Retrozession / Trail</div>
    ${(() => { const r = ex.retrocession || {}; return `<dl class="fields">
      <dt>Vereinbart</dt><dd>${r.agreed === true ? "ja" : r.agreed === false ? "nein" : '<span class="muted">nicht erkannt</span>'}</dd>
      <dt>Satz</dt><dd>${esc(r.rate || "–")}</dd>
      <dt>Gilt für Klassen</dt><dd>${esc((r.included_classes || []).join(", ") || "alle (sofern nicht ausgenommen)")}</dd>
      <dt>Ausgenommen</dt><dd>${esc((r.excluded_classes || []).join(", ") || "–")}</dd></dl>
      ${(r.terms || []).length ? `<ul class="small">${r.terms.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}`; })()}
    <div class="section-title">Gebühren / Provisionen</div>
    ${(ex.fees || []).length ? `<ul class="small">${ex.fees.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : '<p class="muted small">Keine erkannt.</p>'}
    <details><summary class="section-title">Extraktion bearbeiten (JSON)</summary>
      <textarea class="json" id="d-json">${esc(JSON.stringify(ex, null, 2))}</textarea>
      <div class="row"><button class="btn" id="d-save">Speichern</button></div></details>
    <details><summary class="section-title">Volltext</summary><pre class="raw">${esc(current.text || "")}</pre></details>`;
  $("#d-save")?.addEventListener("click", async () => {
    try { await api(`/api/documents/${id}/extraction`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: $("#d-json").value }); toast("Gespeichert"); loadDocs(); }
    catch (e) { toast("Fehler: " + e.message); }
  });
  $("#drawer").classList.add("open"); $("#scrim").classList.add("open");
}
const closeDrawer = () => { $("#drawer").classList.remove("open"); $("#scrim").classList.remove("open"); };
$("#d-close").addEventListener("click", closeDrawer);
$("#scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => e.key === "Escape" && closeDrawer());
$("#d-delete").addEventListener("click", async () => {
  if (!current || !confirm(`„${current.filename}“ löschen?`)) return;
  await api(`/api/documents/${current.id}`, { method: "DELETE" }); closeDrawer(); loadDocs();
});
$("#d-reprocess").addEventListener("click", async () => {
  if (!current) return;
  await api(`/api/documents/${current.id}/reprocess?ocr=${$("#ocr").value}`, { method: "POST" }); closeDrawer(); poll();
});

/* ================= TEIL 2 ================= */
const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (e) { toast("Fehler: " + e.message); } finally { btn.disabled = false; } };

function renderSecResults(groups) {
  $("#sec-results").innerHTML = groups.map((g) => `${g.query ? `<div class="q">„${esc(g.query)}“</div>` : ""}
    ${g.results.map((r, i) => `<label><input type="checkbox" value="${esc(r.cik)}" ${i === 0 && r.score >= 0.9 ? "checked" : ""}> ${esc(r.entity_name)} <span class="muted">· CIK ${esc(r.cik)} · ${r.classes} Klassen</span></label>`).join("")}`).join("")
    + (groups.length ? '<div class="row"><button class="btn" id="sec-load">Auswahl laden</button></div>' : '<p class="muted">Keine Treffer.</p>');
  $("#sec-load")?.addEventListener("click", (ev) => busy(ev.target, async () => {
    const ciks = $$("#sec-results input:checked").map((i) => i.value);
    if (!ciks.length) return toast("Nichts ausgewählt");
    const r = await api("/api/universe/sec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ciks }) });
    toast(`${r.added} Share Classes aus ${r.dataset} geladen`); loadOverview();
  }));
}
$("#sec-suggest").addEventListener("click", (ev) => busy(ev.target, async () => {
  $("#sec-results").innerHTML = '<p class="muted">Lade SEC-Datensatz (einmalig ca. 8 MB) …</p>';
  renderSecResults(await api("/api/universe/sec/suggest"));
}));
const secSearch = (btn) => busy(btn, async () => {
  const q = $("#sec-q").value.trim(); if (!q) return;
  const r = await api(`/api/universe/sec/search?q=${encodeURIComponent(q)}`);
  renderSecResults([{ query: "", results: r.results }]);
});
$("#sec-search").addEventListener("click", (ev) => secSearch(ev.target));
$("#sec-q").addEventListener("keydown", (ev) => ev.key === "Enter" && secSearch($("#sec-search")));

$("#gleif-load").addEventListener("click", (ev) => busy(ev.target, async () => {
  $("#gleif-report").textContent = "Frage GLEIF ab …";
  const r = await api("/api/universe/gleif", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const found = r.report.filter((x) => x.lei);
  $("#gleif-report").innerHTML = `${r.added} Einträge geladen · LEI gefunden für ${found.length}/${r.report.length} Funds · ISINs: ${found.reduce((a, x) => a + x.isins, 0)}`
    + `<details><summary>Details</summary><ul>${r.report.map((x) => `<li>${esc(x.fund)} → ${x.lei ? `<span class="mono">${esc(x.lei)}</span> (${x.isins} ISINs)` : `<span class="muted">${esc(x.note)}</span>`}</li>`).join("")}</ul></details>`;
  loadOverview();
}));

$("#imp-file").addEventListener("change", async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  const fd = new FormData(); fd.append("file", f);
  try {
    const r = await api(`/api/universe/import?source=${encodeURIComponent("Import: " + f.name)}`, { method: "POST", body: fd });
    $("#imp-msg").innerHTML = `${r.added} neue Einträge (${r.rows} Zeilen)` + (r.warnings.length ? `<ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "");
    loadOverview();
  } catch (e) { $("#imp-msg").textContent = "Fehler: " + e.message; }
  ev.target.value = "";
});
$("#uni-clear").addEventListener("click", async () => {
  if (!confirm("Gesamtes geladenes Universum entfernen?")) return;
  await api("/api/universe", { method: "DELETE" }); loadOverview();
});

let ov = null, ovStatus = "";
async function loadOverview() {
  const [sum, data] = await Promise.all([api("/api/universe"), api("/api/overview")]);
  ov = data;
  $("#uni-summary").innerHTML = sum.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Quelle</th><th>Umbrella / Registrant</th><th class="num">Funds</th><th class="num">Einträge</th><th>geladen</th><th></th></tr></thead><tbody>
    ${sum.map((s) => `<tr><td>${esc(s.source)}</td><td>${esc(s.umbrella || "–")}</td><td class="num">${s.funds}</td><td class="num">${s.classes}</td><td>${esc(s.loaded_at)}</td>
      <td><button class="btn ghost small-btn" data-src="${esc(s.source)}" data-umb="${esc(s.umbrella || "")}">entfernen</button></td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">Noch nichts geladen.</p>';
  $$("#uni-summary button").forEach((b) => b.addEventListener("click", async () => {
    await api(`/api/universe?source=${encodeURIComponent(b.dataset.src)}` + (b.dataset.umb ? `&umbrella=${encodeURIComponent(b.dataset.umb)}` : ""), { method: "DELETE" }); loadOverview();
  }));
  const t = ov.totals;
  $("#ov-kpis").innerHTML = [
    ["Funds im Universum", t.funds, ""], ["Share Classes", t.classes, ""], ["abgedeckt", t.covered, "ok"],
    ["Delta (nicht abgedeckt)", t.delta, "bad"], ["prüfen", t.check, "warn"], ["Funds ohne Agreement", t.funds_without_agreement, "bad"],
    ["Klassen mit Retro", t.retro_classes, ""], ["Retro-Delta", t.retro_delta, "bad"], ["Retro unbekannt", t.retro_unknown, "warn"],
  ].map(([l, v, c]) => `<div class="kpi ${c}"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
  renderOverview();
}
$$("#ov-status button").forEach((b) => b.addEventListener("click", () => {
  ovStatus = b.dataset.s; $$("#ov-status button").forEach((x) => x.classList.toggle("on", x === b)); renderOverview();
}));
$("#ov-filter").addEventListener("input", debounce(renderOverview));
$("#ov-nodoc").addEventListener("change", renderOverview);
$("#ov-retro").addEventListener("change", renderOverview);

const clsBadge = (c) => ({ "abgedeckt": "b-ok", "nicht abgedeckt": "b-bad", "prüfen": "b-warn" }[c] || "b-mute");
function renderOverview() {
  if (!ov) return;
  const q = $("#ov-filter").value.toLowerCase();
  const nodoc = $("#ov-nodoc").checked;
  const onlyRetro = $("#ov-retro").checked;
  let html = "";
  for (const u of ov.umbrellas) {
    const funds = u.funds.map((f) => ({ ...f, shown: f.classes.filter((c) => (!ovStatus || c.status === ovStatus) && (!onlyRetro || c.pays_retro !== false)
      && (!q || [f.fund_name, f.fund_id, c.class_name, c.isin, c.class_id, c.ticker].join(" ").toLowerCase().includes(q))) }))
      .filter((f) => f.shown.length && (!nodoc || !f.matched_agreements.length));
    if (!funds.length) continue;
    html += `<details class="umb" open><summary>${esc(u.name)} <span class="badge b-mute">${funds.length} Funds</span></summary><div class="inner">`;
    for (const f of funds) {
      const pc = f.total ? (f.covered / f.total) * 100 : 0, pw = f.total ? (f.check / f.total) * 100 : 0;
      html += `<details ${ovStatus || q ? "open" : ""}><summary>
          <span class="fname">${esc(f.fund_name)}</span><span class="fid">${esc(f.fund_id || "")}</span>
          <span class="bar" title="${f.covered} abgedeckt · ${f.check} prüfen · ${f.delta} Delta"><i style="width:${pc}%"></i><b style="width:${pw}%"></b></span>
          <span class="small">${f.covered}/${f.total}</span>
          ${f.delta ? `<span class="badge b-bad">Δ ${f.delta}</span>` : ""}${f.check ? `<span class="badge b-warn">? ${f.check}</span>` : ""}
          ${f.matched_agreements.length ? `<span class="docs" title="Abgleich: ${esc(f.match_how.join(", "))} (${f.match})">${esc(f.matched_agreements.join(", "))}</span>` : '<span class="badge b-bad">kein Agreement</span>'}
        </summary><div class="cls"><table class="data"><thead><tr><th>Class-ID</th><th>Share Class</th><th>ISIN</th><th>Ticker</th><th>Whg.</th><th>Retro</th><th>Status</th><th>Abgleich</th><th>Agreement</th></tr></thead><tbody>
        ${f.shown.map((c) => `<tr><td class="mono">${esc(c.class_id || "")}</td><td>${esc(c.class_name || "–")}</td><td class="mono">${esc(c.isin || "")}</td><td class="mono">${esc(c.ticker || "")}</td><td>${esc(c.currency || "")}</td>
          <td>${retroBadge(c.retro, c.retro_basis)}${c.retro_basis ? ` <span class="docs">${esc(c.retro_basis)}</span>` : ""}</td>
          <td><span class="badge ${clsBadge(c.status)}">${esc(c.status)}</span></td><td class="small">${esc(c.via || "")}</td><td class="docs">${esc(c.documents.join(", "))}</td></tr>`).join("")}
        </tbody></table></div></details>`;
    }
    html += "</div></details>";
  }
  $("#ov-tree").innerHTML = html;
  $("#ov-empty").hidden = ov.umbrellas.length > 0;
  $("#ov-empty").textContent = ov.umbrellas.length ? "" : "Noch kein Universum geladen – oben eine Datenquelle wählen.";
  if (ov.umbrellas.length && !html) $("#ov-tree").innerHTML = '<p class="empty">Keine Treffer für diesen Filter.</p>';
  const um = ov.unmatched_agreement_funds;
  $("#unmatched-card").hidden = !um.length || !ov.umbrellas.length;
  $("#unmatched").innerHTML = `<ul>${um.map((x) => `<li><b>${esc(x.fund_name)}</b> <span class="docs">${esc(x.doc_name)}</span></li>`).join("")}</ul>`;
}

loadStatus();
poll();
