/* Distrimatcher core – identifiers, extraction, matching, universe helpers.
 * Pure JavaScript, runs in the browser (single HTML file) and in Node.js (tests).
 * Port of the Python package `distrimatcher` (extract.py, identifiers.py, delta.py, universe.py).
 */
(function (root) {
  "use strict";

  /* ================================================================ helpers */
  const L = "\\p{L}\\p{N}_"; // unicode word chars (Python's \w)
  const uniq = (arr) => [...new Set(arr)];
  const sortStr = (arr) => [...arr].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const words = (s) => String(s).split(/\s+/).filter(Boolean);
  const round3 = (x) => Math.round(x * 1000) / 1000;
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const titleCase = (s) => s.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

  function clean(s) {
    s = String(s ?? "").replace(/ /g, " ").replace(/[“”]/g, '"').replace(/’/g, "'");
    return s.replace(/\s+/g, " ").trim();
  }

  /* difflib.SequenceMatcher(None, a, b).ratio() – faithful port (no junk heuristic needed for short strings) */
  function seqRatio(a, b) {
    if (!a.length && !b.length) return 1;
    const b2j = new Map();
    for (let j = 0; j < b.length; j++) { const c = b[j]; if (!b2j.has(c)) b2j.set(c, []); b2j.get(c).push(j); }
    if (b.length >= 200) { // autojunk like Python
      const n = Math.floor(b.length / 100) + 1;
      for (const [c, idx] of [...b2j]) if (idx.length > n) b2j.delete(c);
    }
    const longest = (alo, ahi, blo, bhi) => {
      let besti = alo, bestj = blo, bestsize = 0, j2len = new Map();
      for (let i = alo; i < ahi; i++) {
        const newj2len = new Map();
        for (const j of b2j.get(a[i]) || []) {
          if (j < blo) continue;
          if (j >= bhi) break;
          const k = (j2len.get(j - 1) || 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
        }
        j2len = newj2len;
      }
      return [besti, bestj, bestsize];
    };
    let matches = 0;
    const queue = [[0, a.length, 0, b.length]];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop();
      const [i, j, k] = longest(alo, ahi, blo, bhi);
      if (k) {
        matches += k;
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    return (2 * matches) / (a.length + b.length);
  }

  /* ================================================================ identifiers */
  const charVal = (c) => (/\d/.test(c) ? c : String(c.charCodeAt(0) - 55));
  function isinCheckDigit(body11) {
    const digits = [...body11.toUpperCase()].map(charVal).join("");
    let total = 0;
    [...digits].reverse().forEach((ch, i) => { let n = +ch; if (i % 2 === 0) { n *= 2; if (n > 9) n -= 9; } total += n; });
    return (10 - (total % 10)) % 10;
  }
  function isValidIsin(code) {
    code = String(code || "").trim().toUpperCase();
    if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(code)) return false;
    return isinCheckDigit(code.slice(0, 11)) === +code[11];
  }
  function isValidLei(code) {
    code = String(code || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{18}[0-9]{2}$/.test(code)) return false;
    return BigInt([...code].map(charVal).join("")) % 97n === 1n;
  }
  const findIsins = (text) => uniq([...String(text).toUpperCase().matchAll(/\b([A-Z]{2}[A-Z0-9]{9}[0-9])\b/g)].map((m) => m[1]).filter(isValidIsin));
  const findLeis = (text) => uniq([...String(text).toUpperCase().matchAll(/\b([A-Z0-9]{18}[0-9]{2})\b/g)].map((m) => m[1]).filter((c) => isValidLei(c) && !isValidIsin(c)));

  const DIGIT_FOR = { O: "0", D: "0", Q: "0", I: "1", L: "1", "!": "1", "|": "1", Z: "2", S: "5", G: "6", B: "8", T: "7" };
  const FUND_ISIN_COUNTRIES = new Set("LU IE DE CH AT FR GB US NL BE IT ES LI JE GG KY DK SE NO FI XS PT GR CA AU SG HK JP".split(" "));
  // characters OCR typically confuses with each letter of a country code
  const CONFUSABLE = { I: "1l|!7", E: "5368F", L: "1I|", U: "V0O", S: "5", G: "6C", B: "8", O: "0D", D: "0O", C: "(G", H: "N", K: "X", Y: "V", N: "H", T: "7", A: "4", R: "K", P: "F", F: "EP", J: "1" };
  const similar = (got, want) => got === want || (CONFUSABLE[want] || "").includes(got);
  function repairIsin(token) {
    const t = token.toUpperCase();
    if (isValidIsin(t)) return t;
    if (t.length !== 12) return null;
    const tail = DIGIT_FOR[t[11]] || t[11];
    const mids = uniq([t.slice(2, 11), [...t.slice(2, 11)].map((c) => DIGIT_FOR[c] || c).join("")]);
    const heads = [...FUND_ISIN_COUNTRIES].filter((cc) => similar(t[0], cc[0]) && similar(t[1], cc[1]));
    const valid = uniq(heads.flatMap((h) => mids.map((m) => h + m + tail)).filter(isValidIsin));
    return valid.length === 1 ? valid[0] : null;
  }
  function repairIsinsInText(text) {
    const fixes = [];
    const out = text.replace(/(?<![A-Z0-9])([A-Z0-9!|]{12})(?![A-Z0-9])/g, (tok) => {
      if (isValidIsin(tok) || !/\d{6}/.test(tok)) return tok;
      const f = repairIsin(tok);
      if (f && f !== tok) { fixes.push([tok, f]); return f; }
      return tok;
    });
    return [out, fixes];
  }
  const CCY = "EUR|USD|CHF|GBP|JPY|SEK|NOK|DKK|AUD|CAD|SGD|HKD";
  function ocrCleanup(text) {
    text = text.replace(/\bClass[!|l1](?=\s|$)/g, "Class I").replace(/\bClass\s+[!|l1](?=\s)/g, "Class I");
    text = text.replace(new RegExp(`\\b(Class|Klasse)\\s+([A-Z])(${CCY})\\b`, "g"), "$1 $2 $3");
    return repairIsinsInText(text);
  }

  /* ================================================================ extraction patterns */
  const MONTHS_EN = "January|February|March|April|May|June|July|August|September|October|November|December";
  const MONTHS_DE = "Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember";
  const DATE_RE = `(?:(?:${MONTHS_EN})\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:day of\\s+)?(?:${MONTHS_EN}),?\\s+\\d{4}|\\d{1,2}\\.\\s*(?:${MONTHS_DE})\\s+\\d{4}|\\d{1,2}\\.\\d{1,2}\\.\\d{4}|\\d{4}-\\d{2}-\\d{2})`;
  const NUMBER_WORDS = { fifteen: 15, thirty: 30, "forty-five": 45, "forty five": 45, sixty: 60, ninety: 90, "one hundred twenty": 120, dreissig: 30, "dreißig": 30, sechzig: 60, neunzig: 90, three: 3, six: 6, twelve: 12, drei: 3, sechs: 6 };
  const COUNTRIES = ["Austria", "Belgium", "Denmark", "Finland", "France", "Germany", "Greece", "Ireland", "Italy", "Liechtenstein", "Luxembourg", "Netherlands", "Norway", "Portugal", "Spain", "Sweden", "Switzerland", "United Kingdom", "Singapore", "Hong Kong", "United States", "Chile", "Peru", "Österreich", "Deutschland", "Schweiz", "Frankreich", "Italien", "Spanien", "Luxemburg", "Niederlande", "Belgien", "Schweden", "Norwegen", "Dänemark", "Finnland", "Irland", "Vereinigtes Königreich", "Portugal"];
  const COUNTRY_NORMAL = { "Österreich": "Austria", Deutschland: "Germany", Schweiz: "Switzerland", Frankreich: "France", Italien: "Italy", Spanien: "Spain", Luxemburg: "Luxembourg", Niederlande: "Netherlands", Belgien: "Belgium", Schweden: "Sweden", Norwegen: "Norway", "Dänemark": "Denmark", Finnland: "Finland", Irland: "Ireland", "Vereinigtes Königreich": "United Kingdom" };

  const CLASS_PATTERNS = [
    `(?:Share\\s+)?(?:Class|Klasse|Anteilsklasse|Anteilklasse)\\s+[A-Z][A-Za-z0-9]*(?:-\\d+)?(?:\\s+(?:${CCY}))?(?:\\s+(?:hedged|H|acc|dis|inc|thes|aussch))*`,
    `(?:Investor|Institutional|Advisor|Retail|Service|Administrative|Admin|Premier|Select|Investor\\s+A|Investor\\s+C|Ultra|Y)\\s+(?:Shares|Class)`,
    `\\b[A-Z]{1,3}\\d?\\s+(?:${CCY})(?:\\s+(?:hedged|H|acc|dis|inc|thes|aussch))+`,
  ];
  const CLASS_SRC = CLASS_PATTERNS.map((p) => `(?:${p})`).join("|");
  const CLASS_RE = () => new RegExp(CLASS_SRC, "g");
  const CLASS_LIST_RE = () => /Class(?:es)?\s+((?:[A-Z][A-Z0-9-]{0,4})(?:\s*,\s*[A-Z][A-Z0-9-]{0,4})*\s*(?:,?\s*(?:and|und|&)\s*[A-Z][A-Z0-9-]{0,4}))\b/g;
  const ALL_CLASSES_RE = /all\s+(?:share\s+)?classes|sämtliche\s+anteilsklassen|alle\s+anteilsklassen/i;

  const FW = `[A-Z][${L}’'&./-]*`;
  const FUND_WORD = `(?:${FW}|of|and|the|&|SM|\\d{4})`;
  const FUND_NAME_SRC = `(?<![${L}])((?:${FUND_WORD}\\s+){0,9}?(?:${FW}\\s+)(?:Fund|Portfolio|Allocation|ETF|Teilfonds|Sub-Fund)(?:\\s+(?:I{1,3}|II|IV))?)(?![${L}])(?!\\s+(?:Portfolios|Funds|Series|Trust|Inc|Distributors?|Services|Solutions|Management|Company|LLC|Administration)(?![${L}]))`;
  const FUND_NAME_RE = () => new RegExp(FUND_NAME_SRC, "gu");
  const FUND_GENERIC = new Set(["the fund", "each fund", "such fund", "a fund", "any fund", "the funds", "fund", "series fund", "the portfolio", "each portfolio", "money market fund", "investment fund", "the sub-fund", "each sub-fund", "other fund", "new fund", "underlying fund", "acquiring fund"]);
  const FUND_LEAD_STRIP = /^(?:The|Each|All|Any|Such|Of|And|For|To|Add|Shares of|Including|Under|With|In)\s+/i;

  const HEADER_FUND = /fund|portfolio|series|teilfonds|sub-?fund|compartment|fonds/i;
  const HEADER_CLASS = /class|klasse|share/i;
  const HEADER_ISIN = /isin/i;
  const HEADER_FEE = /fee|provision|commission|gebühr|retro|%|\brate\b|per annum|bestandespflege/i;
  const CLASS_TITLE = /^(?:share\s+)?class|^klasse|^anteilsklasse/i;

  /* ================================================================ normalisation */
  function normFund(name) {
    let s = clean(name).toLowerCase().replace(/&/g, " and ");
    s = s.replace(/\bsm\b|®|™/g, " ");
    s = s.replace(/[^a-z0-9äöüß ]+/g, " ");
    const stop = new Set(["fund", "the", "portfolio", "inc", "sicav", "plc", "icav", "sub", "teilfonds", "a", "of", "funds"]);
    return words(s).filter((t) => !stop.has(t)).join(" ");
  }
  function normClass(name) {
    let s = clean(name).toLowerCase();
    s = s.replace(/\b(share|shares|class|klasse|anteilsklasse|anteilklasse|anteile|of)\b/g, " ");
    s = s.replace(/-/g, "").replace(/[^a-z0-9 ]+/g, " ");
    return words(s).join(" ");
  }
  function classCurrency(name) {
    if (!name) return null;
    const m = new RegExp(`\\b(${CCY})\\b`).exec(name);
    return m ? m[1] : null;
  }
  const first = (re, text) => { const m = re.exec(text); return m && m[1] != null ? clean(m[1]) : null; };

  /* ================================================================ parties */
  function partyRole(name, alias) {
    const a = (alias || "").toLowerCase();
    const probe = `${name} ${alias || ""}`.toLowerCase();
    if (/distribut|vertrieb|underwriter|placement|jnld/.test(a)) return "distributor";
    if (/management company|verwaltungsgesellschaft|fondsleitung|manco|kvg|aifm/.test(a)) return "management_company";
    if (/advis|berater|investment manager/.test(a)) return "investment_adviser";
    if (/trust|fund|fonds|company|gesellschaft|sicav|icav|issuer|registrant|corporation/.test(a)) return "fund_entity";
    if (/distribut|vertrieb|underwriter|placement agent/.test(probe)) return "distributor";
    if (/management company|verwaltungsgesellschaft|fondsleitung|asset management|capital management|kapitalverwaltung/.test(probe)) return "management_company";
    if (/advis|berater/.test(probe)) return "investment_adviser";
    if (/trust|fund|sicav|icav|fonds|series|portfolio/.test(probe)) return "fund_entity";
    if (/bank|ag\b|gmbh|llc|s\.a\./.test(probe)) return "distributor";
    return "party";
  }
  const DEFINITION_RE = () => /\((?:the\s+|die\s+|der\s+|das\s+|im\s+Folgenden\s+|nachfolgend\s+|hereinafter\s+)?["“„]([^"”“]{2,40})["”“]\)/g;
  const LEGAL_FORM = "(?:LLC|L\\.L\\.C\\.|Inc\\.?|Ltd\\.?|Limited|S\\.A\\.|S\\.à\\s?r\\.l\\.|GmbH|AG|SICAV|ICAV|plc|LP|L\\.P\\.|N\\.V\\.|B\\.V\\.|KGaA|SE|Trust|Funds?(?:\\s+[IVX]+)?|Corporation|Company)";
  const ENTITY_SUFFIX = () => new RegExp(`(?<![${L}])${LEGAL_FORM}(?![${L}])`, "gu");
  const SKIP_ALIASES = new Set(["agreement", "1940 act", "1933 act", "act", "sec", "finra", "exchange act", "vertrag", "vereinbarung", "shares", "prospectus", "territory", "registration statement", "distribution plan", "board of trustees", "board", "eligible separate accounts", "participating insurance companies", "investment company act", "portfolios", "anteile", "vertriebsgebiet", "plan", "contracts", "nachtrag"]);
  const PARTY_CUT = /,\s+(?:a|an|ein|eine|einem|einer)\s|,\s+(?:organized|incorporated|established|with\s+its|LEI|having|mit\s+Sitz)|\s+LEI\s|,\s+\d|,\s+[A-Z][a-z]+strasse|,\s+[A-Z][a-z]+ (?:Street|Avenue|Road)|\s+(?:acting|vertreten|represented)\b|,\s+[A-Z][\w.äöü ]{2,20},\s|\s+als\s/i;

  function entityName(segment) {
    let seg = clean(segment);
    const parts = seg.split(/\b(?:by\s+and\s+between|between|zwischen|and|und|durch|through)\s+(?=[A-Z])|;|\)\s*,/);
    seg = parts[parts.length - 1];
    seg = seg.split(PARTY_CUT)[0].split("(")[0];
    seg = seg.replace(/^[\s,;:("“]+|[\s,;:("“]+$/g, "");
    seg = seg.replace(/^(?:the|die|der|das|its|ihre|seine|sowie)\s+/i, "");
    seg = seg.replace(/^(?:management company|Verwaltungsgesellschaft)\s+/i, "");
    const ms = [...seg.matchAll(ENTITY_SUFFIX())];
    if (!ms.length) return null;
    const last = ms[ms.length - 1];
    const name = seg.slice(0, last.index + last[0].length).replace(/^[\s,]+|[\s,]+$/g, "");
    if (name.length < 4 || name.length > 110 || !/^[A-Z0-9]/.test(name)) return null;
    if (/\b(?:shall|amended|registration|hereby|separate accounts|whereas)\b|^the\s/i.test(name)) return null;
    return name;
  }

  function extractParties(text) {
    const head = clean(text.slice(0, 6000));
    const parties = [], seen = new Set();
    const add = (name, alias, role) => {
      if (!name) return;
      const key = name.toLowerCase();
      if (seen.has(key)) { for (const p of parties) if (p.name.toLowerCase() === key && alias && !p.alias) p.alias = alias; return; }
      seen.add(key);
      parties.push({ name, alias: alias || null, role: role || partyRole(name, alias) });
    };
    const h = head.slice(0, 4500);
    let lastEnd = 0;
    for (const m of h.matchAll(DEFINITION_RE())) {
      const alias = clean(m[1]);
      const segment = head.slice(Math.max(lastEnd, m.index - 260), m.index);
      lastEnd = m.index + m[0].length;
      if (SKIP_ALIASES.has(alias.toLowerCase())) continue;
      add(entityName(segment), alias);
    }
    const reAct = new RegExp(`(?:acting\\s+through|represented\\s+by|vertreten\\s+durch)\\s+(?:its|ihre|seine|die|the)?\\s*(?:management\\s+company|Verwaltungsgesellschaft)?\\s*([A-Z][^,;()]{2,90}?${LEGAL_FORM})`, "g");
    for (const m of h.matchAll(reAct)) add(entityName(m[1]), null, "management_company");
    if (parties.length < 2) {
      const m = /(?:by\s+and\s+between|between|zwischen)\s+(.{3,160}?)\s+(?:and|und)\s+(.{3,160}?)(?:[;.(]|\s+dated|\s+vom|$)/i.exec(head);
      if (m) { add(entityName(m[1]), null); add(entityName(m[2]), null); }
    }
    return parties.slice(0, 6);
  }

  /* ================================================================ fees & retrocession */
  function extractFees(text) {
    const fees = [];
    for (const line of text.split("\n")) {
      const l = clean(line);
      if (/\d+(?:[.,]\d+)?\s?%|\bbps\b|basis points|Basispunkte/.test(l) && /fee|commission|retrocession|trail|provision|vergütung|gebühr|12b-1|distribution|service|kickback|rebate|entgelt|bestandspflege/i.test(l)) {
        if (!fees.includes(l)) fees.push(l.slice(0, 300));
      }
    }
    return fees.slice(0, 40);
  }
  const RETRO_KW = "retro(?:cession|zession)s?|trail(?:\\s+(?:fee|commission))?|bestande?s?(?:pflege)?(?:kommission|provision)|vertriebs(?:entsch(?:ä|ae)digung|provision|verg(?:ü|ue)tung)|kickback|rebate|distribution\\s+(?:and\\s+service\\s+)?fee|12b-1|service\\s+fee|commission\\s+de\\s+distribution";
  const RETRO_RE = new RegExp(RETRO_KW, "i");
  const RETRO_NEG_RE = () => new RegExp(`(?:no|keine?|not\\s+entitled\\s+to\\s+any|ohne)\\s+(?:${RETRO_KW})[^.]{0,80}?(?:on|for|für|auf|in)\\s+((?:Class(?:es)?\\s+[A-Z0-9-]+(?:\\s*(?:,|and|und)\\s*[A-Z0-9-]+)*)|[A-Z]{1,2}-?(?:Klassen|classes|shares|Anteile[n]?))`, "gi");
  const CLASS_REF_RE = () => /\bClass(?:es)?\s+([A-Z][A-Z0-9]?(?:-\d)?)\b|\b([A-Z]{1,2})-(?:Klassen|Klasse|classes|Anteile[n]?|shares)\b|\b([A-Z]{1,2})-(?=\s+(?:und|and|&|or|oder)\s+[A-Z]{1,2}-(?:Klassen|classes|Anteile))/g;
  const RETRO_NEG_REV_RE = () => new RegExp(`(?:für|for|on|auf)\\s+((?:Class(?:es)?\\s+[A-Z0-9-]+)|[A-Z]{1,2}-?(?:Klassen|classes|shares|Anteile[n]?))[^.]{0,40}?(?:keine?|no)\\s+(?:${RETRO_KW})`, "gi");
  const classRefs = (s) => [...s.matchAll(CLASS_REF_RE())].map((m) => (m[1] || m[2] || m[3]).toUpperCase());

  function extractRetrocession(text) {
    const t = clean(text);
    const sentences = t.split(/(?<=[.;])\s+(?=[A-ZÄÖÜ§0-9])/);
    const terms = sentences.filter((s) => RETRO_RE.test(s) && /\d+(?:[.,]\d+)?\s?%|basis points|bps|Basispunkte|management fee|Verwaltungs/i.test(s)).map((s) => s.slice(0, 400));
    let rate = null;
    for (const s of terms) {
      const m = new RegExp(`(\\d+(?:[.,]\\d+)?\\s?%(?:\\s*(?:p\\.?\\s?a\\.?|per annum))?(?:\\s+(?:of|der|des)\\s+(?:the\\s+)?(?:management\\s+fee|Verwaltungs[${L}]+|mgmt\\.?\\s+fee|average\\s+daily\\s+net\\s+assets))?)`, "iu").exec(s);
      if (m) {
        const tok = words(m[1])[0];
        const probe = tok.includes("%") ? tok : tok + "%";
        if (!/^0+(?:[.,]0+)?\s?%$/.test(probe)) { rate = clean(m[1]); break; }
      }
    }
    let excluded = [];
    // sentences that deny a retrocession exclude every class they mention
    const negRe = new RegExp(`(?:\\bno\\b|keine?|not\\s+entitled|ohne)\\s+(?:[${L}]+\\s+){0,2}(?:${RETRO_KW})|(?:${RETRO_KW})[^.]{0,40}\\b(?:is|are)\\s+not\\s+payable`, "iu");
    for (const s of sentences) if (negRe.test(s)) excluded.push(...classRefs(s));
    for (const m of [...t.matchAll(RETRO_NEG_RE()), ...t.matchAll(RETRO_NEG_REV_RE())]) {
      const grp = m[1];
      const lm = /^([A-Z]{1,2})-?(?:Klassen|classes|shares|Anteile)/i.exec(grp);
      if (lm) excluded.push(lm[1].toUpperCase());
      else excluded.push(...grp.replace(/Class(?:es)?\s+/g, "").split(/,|and|und/).map((c) => c.trim().toUpperCase()).filter(Boolean));
    }
    excluded = sortStr(uniq(excluded));
    const included = sortStr(uniq(terms.flatMap(classRefs)).filter((c) => !excluded.includes(c)));
    const noRetro = /(?:no|keine?)\s+(?:retrocessions?|Retrozessionen?|trail commissions?)\s+(?:shall\s+be|will\s+be|werden|wird|is|are)\s+(?:paid|gezahlt|bezahlt|payable|geschuldet)/i.test(t) && !rate;
    const agreed = rate ? true : noRetro ? false : null;
    return { agreed, rate, included_classes: included, excluded_classes: excluded, terms: terms.slice(0, 10) };
  }
  function feeIsZero(fee) {
    if (!fee) return null;
    const f = fee.trim().toLowerCase();
    if (/^(?:none|keine?|nil|n\/?a|-|–|0+(?:[.,]0+)?\s?%?)$/.test(f)) return true;
    if (/[1-9]/.test(f) && (f.includes("%") || f.includes("bp") || f.includes("fee"))) return false;
    return null;
  }
  function assignClassRetro(ex) {
    const r = ex.retrocession || {};
    const excluded = new Set(r.excluded_classes || []), included = new Set(r.included_classes || []);
    const hit = (base, g) => !!base && (g.has(base) || (base.length <= 3 && g.has(base[0])));
    for (const f of ex.funds) for (const sc of f.share_classes) {
      const zero = feeIsZero(sc.fee);
      const base = (words(normClass(sc.name || ""))[0] || "").toUpperCase();
      if (zero === true) sc.retro = false;
      else if (zero === false) sc.retro = true;
      else if (hit(base, excluded)) sc.retro = false;
      else if (included.size) sc.retro = hit(base, included) ? true : null;
      else if (r.agreed === true) sc.retro = true;
      else if (r.agreed === false) sc.retro = false;
    }
  }

  /* ================================================================ other key terms */
  function extractNotice(text) {
    const t = clean(text);
    const re = new RegExp(`(?:(\\d{1,3})|(${Object.keys(NUMBER_WORDS).join("|")}))\\s*(?:\\((\\d{1,3})\\))?\\s*(days?|months?|Tage[n]?|Monate[n]?)['’]?\\s*(?:prior\\s+)?(?:written\\s+)?(?:notice|Kündigungsfrist|schriftlich)`, "i");
    let m = re.exec(t);
    if (m) {
      const n = m[1] || m[3] || String(NUMBER_WORDS[m[2].toLowerCase()] ?? m[2]);
      const unit = /^(day|tag)/i.test(m[4]) ? "days" : "months";
      return `${n} ${unit}`;
    }
    m = /Kündigungsfrist\s+(?:von\s+)?(\d+)\s+(Tage|Monate|Monaten|Tagen)/i.exec(t);
    if (m) return `${m[1]} ${/^tag/i.test(m[2]) ? "days" : "months"}`;
    return null;
  }
  function extractTerritory(text) {
    let t = clean(text);
    t = t.split(/(?<=[.;])\s+/).filter((s) => !/\b(?:law|laws|Recht|Gerichtsstand|courts?|jurisdiction|incorporated|registriert|Sitz|organized)\b/i.test(s)).join(" ");
    const windows = [...t.matchAll(/territor|countries|jurisdictions|Vertriebsl[äa]nd|Vertriebsgebiet|L[äa]nder/gi)].map((m) => m.index);
    const found = [];
    for (const c of COUNTRIES) {
      const re = new RegExp(`(?<![${L}])${escRe(c)}(?![${L}])`, "u");
      for (const pos of windows) {
        if (re.test(t.slice(Math.max(0, pos - 100), pos + 700))) { const n = COUNTRY_NORMAL[c] || c; if (!found.includes(n)) found.push(n); break; }
      }
    }
    return found;
  }
  function extractSignatories(text) {
    const names = [];
    for (const m of text.matchAll(/\/s\/\s*([A-Z][A-Za-z.' -]{2,40}?)(?=\s{2,}|\n|\s+(?:Name|Title|By|[A-Z]{3,})|$)/g)) { const n = clean(m[1]); if (!names.includes(n)) names.push(n); }
    for (const m of text.matchAll(/(?:Name|Name\/Funktion)\s*:\s*([A-Z][A-Za-z.'\- ]{2,40}?)(?=\s+(?:Title|Funktion|Name)\s*:|\n|$)/g)) { const n = clean(m[1]); if (!names.includes(n) && words(n).length <= 5) names.push(n); }
    return names.slice(0, 12);
  }
  const GERMAN_LAW = { luxemburg: "Luxembourg", irisch: "Irish", deutsch: "German", schweizer: "Swiss", "österreich": "Austrian", liechtenstein: "Liechtenstein", englisch: "English", "französisch": "French", "niederländisch": "Dutch" };
  function germanLaw(w) {
    const lw = w.toLowerCase();
    for (const [k, v] of Object.entries(GERMAN_LAW)) if (lw.startsWith(k)) return `${v} law`;
    return `${w} Recht`;
  }

  function extractHeaderFields(text, ex) {
    const t = clean(text), head = t.slice(0, 3000);
    if (/amended\s+schedule|revised\s+schedule|schedule\s+a\b.{0,40}amended|amendment|nachtrag|änderungsvereinbarung/i.test(head)) ex.document_type = "Amendment / Schedule";
    else if (/distribution\s+agreement|vertriebsvertrag|vertriebsvereinbarung|placement agreement|distribution and services agreement/i.test(head)) ex.document_type = "Distribution Agreement";
    else if (/schedule\s+a/i.test(head)) ex.document_type = "Schedule";
    const mt = /((?:[A-Z0-9&.,'-]+\s+){0,10}(?:DISTRIBUTION|DISTRIBUTOR|VERTRIEBS|PLACEMENT|SUB-DISTRIBUTION)\s*(?:AND\s+[A-Z]+\s+)?(?:AGREEMENT|VERTRAG|VEREINBARUNG))/.exec(text);
    ex.title = mt ? clean(mt[1]).slice(0, 200) : null;
    ex.agreement_date = first(new RegExp(`(?:dated\\s+(?:as\\s+of\\s+)?|made\\s+(?:as\\s+of\\s+)?(?:this\\s+)?|vom\\s+|Datum:?\\s*|Date:\\s*|as\\s+of\\s+)(${DATE_RE})`, "is"), t);
    ex.effective_date = first(new RegExp(`(?:effective\\s+(?:as\\s+of\\s+|date[:\\s]+)?|in\\s+kraft\\s+(?:ab|am|per)\\s+|wirksam\\s+ab\\s+)(${DATE_RE})`, "is"), t);
    if (!ex.agreement_date) { const d = new RegExp(DATE_RE).exec(head); ex.agreement_date = d ? d[0] : null; }
    const gl = first(/(?:governed\s+by|construed\s+in\s+accordance\s+with|subject\s+to)\s+(?:and\s+construed\s+in\s+accordance\s+with\s+)?the\s+(?:internal\s+)?laws?\s+of\s+(?:the\s+)?((?:State|Commonwealth|Grand\s+Duchy)\s+of\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/s, t);
    const glDe = first(new RegExp(`unterliegt\\s+(?:dem\\s+)?([${L}]+(?:em|en|es))\\s+Recht`, "isu"), t);
    ex.governing_law = gl || (glDe ? germanLaw(glDe) : null) || first(new RegExp(`([${L}]+(?:isches|sches))\\s+Recht\\s+(?:anwendbar|Anwendung)`, "isu"), t);
    ex.jurisdiction = first(new RegExp(`(?:courts?\\s+of|Gerichtsstand\\s+(?:ist\\s+)?)\\s*(?:the\\s+)?([A-Z][${L}-]+(?:\\s+[A-Z][${L}-]+)?)`, "u"), t);
    if (/non-?exclusive|nicht\s+exklusiv|nicht-exklusiv/i.test(t)) ex.exclusivity = "non-exclusive";
    else if (/\bexclusive\b|exklusiv/i.test(t)) ex.exclusivity = "exclusive";
    ex.termination_notice = extractNotice(text);
    ex.term = first(/((?:shall\s+(?:continue|remain)\s+in\s+(?:full\s+)?(?:force|effect)|initial\s+term|unbestimmte\s+Zeit|auf\s+unbestimmte\s+Dauer)[^.]{0,200}\.)/is, t);
    ex.parties = extractParties(text);
    for (const p of ex.parties) if (["fund_entity", "distributor", "management_company", "investment_adviser"].includes(p.role) && !ex[p.role]) ex[p.role] = p.name;
    ex.fees = extractFees(text);
    ex.retrocession = extractRetrocession(text);
    ex.territory = extractTerritory(text);
    ex.signatories = extractSignatories(text);
    ex.isins = findIsins(text);
    ex.leis = findLeis(text);
    ex.sec_series_ids = sortStr(uniq([...text.matchAll(/\b(S0000\d{5})\b/g)].map((m) => m[1])));
    ex.sec_class_ids = sortStr(uniq([...text.matchAll(/\b(C0000\d{5}|C000\d{6})\b/g)].map((m) => m[1])));
  }

  /* ================================================================ funds & share classes */
  function newFund(name, extra = {}) { return { name, umbrella: null, all_classes: false, share_classes: [], source: "text", ...extra }; }
  const sc = (name, isin, currency, fee) => ({ name: name ?? null, isin: isin ?? null, currency: currency ?? null, fee: fee ?? null, retro: null });
  function addClass(f, c) {
    for (const e of f.share_classes) {
      if (c.isin && e.isin === c.isin) { e.name = e.name || c.name; e.fee = e.fee || c.fee; return; }
      if (!c.isin && !e.isin && c.name && normClass(e.name || "") === normClass(c.name)) { e.fee = e.fee || c.fee; return; }
    }
    f.share_classes.push(c);
  }
  function findClasses(s) {
    const out = [];
    for (const m of s.matchAll(CLASS_LIST_RE())) for (let c of m[1].split(/\s*(?:,|\band\b|\bund\b|&)\s*/)) { c = c.trim(); if (c && !out.includes(`Class ${c}`)) out.push(`Class ${c}`); }
    for (const m of s.matchAll(CLASS_RE())) {
      let c = clean(m[0]).replace(/^Share\s+/, "");
      if (["class of", "class shares"].includes(c.toLowerCase()) || /^(?:Class|Klasse)\s+(?:Of|The|Shares|Und|And)$/i.test(c)) continue;
      if (!out.includes(c) && !out.some((o) => normClass(o) === normClass(c))) out.push(c);
    }
    return out;
  }
  function fundNameOk(name) {
    const n = clean(name), low = n.toLowerCase();
    if (FUND_GENERIC.has(low) || n.length < 6 || n.length > 120) return false;
    if (words(n).length < 2) return false;
    if (/\b(?:shall|will|may|must|agreement|act|investment company|hereto|hereby|herein|pursuant|each|such|shares|class)\b/.test(low)) return false;
    if (/[.;:]\s+[A-Z]/.test(n)) return false; // spans a sentence boundary ("Documents. The Fund")
    return true;
  }
  function stripFundLead(name) {
    let prev = null; name = clean(name);
    const re2 = new RegExp(`^(?:\\d+[,.]?|${MONTHS_EN}|${MONTHS_DE})\\s+`);
    while (prev !== name) { prev = name; name = name.replace(FUND_LEAD_STRIP, ""); name = name.replace(re2, ""); }
    return name;
  }
  function merge(funds, entry) {
    const key = normFund(entry.name);
    if (!key) return entry;
    if (funds.has(key)) {
      const f = funds.get(key);
      f.all_classes = f.all_classes || entry.all_classes;
      for (const c of entry.share_classes) addClass(f, c);
      if (entry.source === "table") f.source = "table";
      return f;
    }
    funds.set(key, entry);
    return entry;
  }
  const cell = (row, idx) => (idx == null || idx >= row.length || row[idx] == null ? "" : String(row[idx]).replace(/-\n(?=[A-Z])/g, "-"));

  /* tables: array of tables, each [headerRow, ...rows], cells are strings with "\n" for line breaks */
  function fundsFromTables(tables, funds) {
    let header = null;
    for (const table of tables) {
      if (!table.length || Math.max(...table.map((r) => r.length)) < 2) continue;
      const firstRow = table[0].map((c) => clean(String(c || "")));
      const idx = (pred) => { const i = firstRow.findIndex(pred); return i < 0 ? null : i; };
      const cand = {
        fund: idx((c) => HEADER_FUND.test(c) && !HEADER_CLASS.test(c)),
        class: idx((c) => HEADER_CLASS.test(c)),
        isin: idx((c) => HEADER_ISIN.test(c)),
        fee: idx((c) => HEADER_FEE.test(c) && !CLASS_TITLE.test(c)),
      };
      let body = table;
      if (cand.fund != null && (cand.class != null || cand.isin != null)) { header = cand; body = table.slice(1); }
      if (!header) continue;
      let lastFund = null;
      for (const row of body) {
        const fname = clean(cell(row, header.fund));
        const classesRaw = cell(row, header.class), isinRaw = cell(row, header.isin), feeRaw = clean(cell(row, header.fee)) || null;
        if (fname && !new RegExp(`^(?:${HEADER_FUND.source})$`, "i").test(fname)) lastFund = merge(funds, newFund(fname, { source: "table" }));
        if (!lastFund) continue;
        let isins = findIsins(isinRaw); if (!isins.length) isins = findIsins(row.map((c) => String(c || "")).join(" "));
        let classLines = classesRaw.split("\n").map(clean).filter(Boolean);
        if (ALL_CLASSES_RE.test(classesRaw)) { lastFund.all_classes = true; classLines = []; }
        if (isins.length) {
          isins.forEach((isin, i) => { const cname = i < classLines.length ? classLines[i] : classLines.length === 1 ? classLines[0] : null; addClass(lastFund, sc(cname, isin, classCurrency(cname), feeRaw)); });
        } else {
          const feeLines = feeRaw && classLines.length > 1 ? feeRaw.split(" ") : [feeRaw];
          classLines.forEach((cname, i) => addClass(lastFund, sc(cname, null, classCurrency(cname), i < feeLines.length ? feeLines[i] : null)));
        }
      }
    }
  }

  function fundsFromText(text, funds) {
    const known = new Set([...funds.values()].flatMap((f) => f.share_classes.map((c) => c.isin).filter(Boolean)));
    const lines = text.split("\n").map(clean);
    let inSchedule = false, allMode = false, umbrella = null, current = null, group = [];
    const umbRe = /^([A-Z][\p{L}\p{N}_&.' -]{2,60}?(?:Funds?\s+[IVX]+|SICAV|ICAV|Trust|FCP|plc))\s*[:–-]?$/u;
    const fundFull = new RegExp(`^(?:${FUND_NAME_SRC})$`, "u");
    for (const line of lines) {
      if (!line || line.startsWith("[[Page") || line.startsWith("[[Seite")) continue;
      if (/\b(?:schedule|anhang|appendix|annex|exhibit)\s+[A-Z1-9]\b/i.test(line)) inSchedule = true;
      if (ALL_CLASSES_RE.test(line)) allMode = true;
      const um = umbRe.exec(line);
      if (um && !fundFull.test(line)) { umbrella = clean(um[1]); current = null; group = []; continue; }
      const allIsins = findIsins(line), isins = allIsins.filter((i) => !known.has(i));
      if (allIsins.length && !isins.length) { current = null; group = []; continue; }
      const classes = findClasses(line);
      let names = [];
      if (isins.length) {
        let before = line.split(isins[0])[0];
        if (classes.length) { const cpos = before.indexOf(classes[0]); before = cpos > 0 ? before.slice(0, cpos) : before; }
        before = before.replace(/\s+\d+(?:[.,]\d+)?\s?%.*$/, "").replace(/^[\s|;:\-–]+|[\s|;:\-–]+$/g, "");
        if (before.length >= 6 && /[A-Za-z]{3}/.test(before) && !new RegExp(`^(?:${CLASS_SRC})$`).test(before)) names = [before];
      }
      if (!names.length) for (const m of line.matchAll(FUND_NAME_RE())) { const nm = stripFundLead(m[1]); if (fundNameOk(nm)) names.push(nm); }
      if (names.length) {
        group = [];
        for (const nm of names) {
          if (/\b(?:agreement|act|trust)\b/i.test(nm) && !/fund|portfolio|teilfonds/i.test(nm)) continue;
          current = merge(funds, newFund(nm, { umbrella, all_classes: allMode }));
          group.push(current);
        }
        if (group.length > 3) { group = []; current = null; }
      }
      const prose = /\b(?:authori[sz]ed|approved|shall|pursuant|may|will|soll|darf|wird)\b/i.test(line);
      if (isins.length && current) group = [current];
      if (group.length && !isins.length && classes.length && !prose && (inSchedule || line.length < 120)) {
        const fm = /(\d+(?:[.,]\d+)?\s?%)/.exec(line);
        for (const f of group) for (const cname of classes) addClass(f, sc(cname, null, classCurrency(cname), fm ? fm[1] : null));
        continue;
      }
      if (current && isins.length) {
        const fm = /(\d+(?:[.,]\d+)?\s?%)/.exec(line);
        isins.forEach((isin, i) => { const cname = i < classes.length ? classes[i] : null; addClass(current, sc(cname, isin, classCurrency(cname), fm ? fm[1] : null)); });
      }
    }
  }

  function extractDocument(text, tables = []) {
    const ex = { document_type: null, title: null, agreement_date: null, effective_date: null, parties: [], fund_entity: null, distributor: null, management_company: null, investment_adviser: null, governing_law: null, jurisdiction: null, territory: [], exclusivity: null, termination_notice: null, term: null, fees: [], retrocession: {}, signatories: [], isins: [], leis: [], sec_series_ids: [], sec_class_ids: [], funds: [], warnings: [] };
    extractHeaderFields(text, ex);
    const funds = new Map();
    try { fundsFromTables(tables, funds); } catch (e) { ex.warnings.push(`Table detection failed: ${e.message}`); }
    fundsFromText(text, funds);
    // merge funds whose name is the tail of a longer table name
    for (const k of [...funds.keys()].sort((a, b) => b.length - a.length)) {
      const f = funds.get(k); if (!f) continue;
      for (const other of [...funds.keys()]) {
        if (other !== k && funds.has(other) && other.length < k.length && new RegExp(`(?:^| )${escRe(other)}$`).test(k) && !funds.get(other).share_classes.length && f.source === "table") {
          f.all_classes = f.all_classes || funds.get(other).all_classes; funds.delete(other);
        }
      }
    }
    // line-wrap fragments ("Mid Cap Value Fund") -> full name from the joined text
    for (const m of clean(text).matchAll(FUND_NAME_RE())) {
      const full = stripFundLead(m[1]), fk = normFund(full);
      if (fundNameOk(full) && !funds.has(fk)) {
        const frag = [...funds.keys()].find((k) => fk.endsWith(" " + k));
        if (frag && funds.get(frag).source === "text") { const old = funds.get(frag); funds.delete(frag); old.name = full; funds.set(fk, old); }
      }
    }
    for (const k of [...funds.keys()].sort((a, b) => a.length - b.length)) {
      if (!funds.has(k)) continue;
      const longer = [...funds.keys()].filter((o) => o !== k && o.length > k.length && o.endsWith(" " + k));
      if (longer.length && funds.get(k).source === "text") {
        const target = funds.get(longer[0]);
        if (!target.share_classes.length) for (const c of funds.get(k).share_classes) addClass(target, c);
        target.all_classes = target.all_classes || funds.get(k).all_classes;
        funds.delete(k);
      }
    }
    const docClasses = uniq([...text.slice(0, 3000).matchAll(/\bCLASS\s+([A-Z0-9-]{1,4})\s+SHARES\b/g)].map((m) => m[1]));
    if (docClasses.length) for (const f of funds.values()) if (!f.share_classes.length && !f.all_classes) for (const c of docClasses) addClass(f, sc(`Class ${c}`));
    for (const f of funds.values()) {
      const named = new Set(f.share_classes.filter((c) => c.isin && c.name).map((c) => normClass(c.name)));
      f.share_classes = f.share_classes.filter((c) => c.isin || !c.name || !named.has(normClass(c.name)));
    }
    ex.funds = [...funds.values()];
    assignClassRetro(ex);
    if (!ex.fund_entity) {
      const m = /^\s*([A-Z][A-Z0-9 .&,'-]{3,60}?\s(?:TRUST|FUNDS?(?:\s+[IVX]+)?|SICAV|ICAV|PLC))\s*\d?\s*$/m.exec(text);
      const umbs = sortStr(uniq(ex.funds.map((f) => f.umbrella).filter(Boolean)));
      if (m) ex.fund_entity = m[1] === m[1].toUpperCase() ? titleCase(clean(m[1])) : clean(m[1]);
      else if (umbs.length) ex.fund_entity = umbs.join(", ");
    }
    const assigned = new Set(ex.funds.flatMap((f) => f.share_classes.map((c) => c.isin).filter(Boolean)));
    const orphan = ex.isins.filter((i) => !assigned.has(i));
    if (orphan.length) ex.warnings.push(`${orphan.length} ISIN(s) without fund assignment: ${orphan.slice(0, 10).join(", ")}`);
    if (!ex.funds.length) ex.warnings.push("No funds detected – please review the document manually.");
    if (!ex.parties.length) ex.warnings.push("Contract parties not detected (possibly a schedule/annex only).");
    return ex;
  }

  /* ================================================================ universe helpers */
  function parseRetro(value) {
    if (value == null) return null;
    const v = String(value).trim().toLowerCase();
    if (!v) return null;
    if (["ja", "yes", "y", "j", "true", "wahr", "1", "x", "✓"].includes(v)) return "yes";
    if (["nein", "no", "n", "false", "falsch", "0", "-", "none", "keine", "clean", "0%", "0.00%", "0,00%"].includes(v)) return "no";
    const m = /(\d+(?:[.,]\d+)?)\s*(%|bp|bps)?/.exec(v);
    if (m) {
      if (parseFloat(m[1].replace(",", ".")) === 0) return "no";
      return `${m[1]}${(m[2] || "%") === "%" ? "%" : " bp"}`;
    }
    return String(value).trim();
  }
  const NO_RETRO_HINTS = /\b(?:clean|no\s*retro|nr|institutional|inst|ohne\s+retro)\b/i;
  const NO_RETRO_LETTERS = new Set(["I", "IA", "IB", "Z", "Q", "N", "X", "S", "J", "UB", "EB", "M", "F", "K", "R6", "Y"]);
  const RETRO_LETTERS = new Set(["A", "B", "C", "P", "R", "RA", "RB", "INV", "INVESTOR", "RETAIL", "T", "AA", "AD"]);
  function classBase(name) {
    let s = String(name).trim().replace(/^.*\(((?:Share\s+)?Class[^)]*)\)\s*$/, "$1");
    s = s.replace(/\b(?:Share|Shares|Class|Klasse|Anteilsklasse)\b/gi, " ");
    return (words(s.replace(/-/g, ""))[0] || "").toUpperCase();
  }
  function guessRetro(className) {
    if (!className) return null;
    if (NO_RETRO_HINTS.test(className)) return "no";
    const tok = classBase(className);
    if (NO_RETRO_LETTERS.has(tok)) return "no";
    if (RETRO_LETTERS.has(tok)) return "yes";
    return null;
  }
  function classFeatures(className, currency, retro) {
    const n = className || "", low = n.toLowerCase(), tags = [];
    let base = String(n).replace(/^.*\(([^)]*)\)\s*$/, "$1").replace(/\b(?:share|shares|class|klasse|anteilsklasse)\b/gi, " ");
    base = (words(base.replace(/-/g, ""))[0] || "").toUpperCase();
    if (/\bclean\b|no\s*retro|ohne\s+retro/.test(low) || (retro === "no" && !NO_RETRO_LETTERS.has(base))) tags.push({ label: "Clean share", kind: "warn" });
    if (/institutional|\binst\b/.test(low) || ["I", "IA", "IB", "J", "Z", "S", "X", "INST"].includes(base)) tags.push({ label: "Institutional", kind: "" });
    else if (["A", "B", "C", "P", "R", "RA", "RB", "INV", "INVESTOR", "RETAIL", "T"].includes(base)) tags.push({ label: "Retail", kind: "" });
    if (/hedged|\bh\b|hdg|gesichert/.test(low)) tags.push({ label: "Currency hedged", kind: "" });
    const ccy = currency || classCurrency(n);
    if (ccy) tags.push({ label: ccy, kind: "" });
    if (/\bdis\b|distribut|aussch/.test(low)) tags.push({ label: "Distributing", kind: "" });
    else if (/\bacc\b|accumul|thes/.test(low)) tags.push({ label: "Accumulating", kind: "" });
    return tags;
  }

  /* CSV with delimiter sniffing (, ; tab) and quotes */
  function parseCsv(text) {
    text = text.replace(/^﻿/, "");
    const sample = text.slice(0, 4096).split("\n").slice(0, 5).join("\n");
    const counts = { ",": 0, ";": 0, "\t": 0 };
    for (const ch of sample) if (ch in counts) counts[ch]++;
    const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ",";
    const rows = []; let row = [], field = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
      else if (c === '"') q = true;
      else if (c === delim) { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim()));
  }
  const COLUMN_ALIASES = {
    umbrella: ["umbrella", "dachfonds", "sicav", "registrant", "entity", "entity name", "fondsgesellschaft", "trust"],
    fund_id: ["fund_id", "fund id", "fonds-id", "fondsid", "series id", "lei", "fund lei", "teilfonds-id", "subfund id"],
    fund_name: ["fund_name", "fund name", "fund", "fonds", "fondsname", "teilfonds", "sub-fund", "subfund", "series name", "compartment"],
    class_id: ["class_id", "class id", "share class id"],
    class_name: ["share_class", "share class", "class name", "class", "anteilsklasse", "anteilklasse", "klasse"],
    isin: ["isin", "isin code"],
    ticker: ["ticker", "class ticker", "bloomberg ticker"],
    currency: ["currency", "ccy", "währung", "waehrung", "class currency"],
    retro: ["retro", "retrocession", "retrocessions", "retrozession", "retrozessionen", "retro (ja/nein)", "trail", "trail fee", "trail commission", "bestandespflegekommission", "bestandespflege", "bestandsprovision", "vertriebsentschädigung", "distribution fee", "kickback"],
  };
  function mapColumns(header) {
    const norm = header.map((h) => String(h).trim().toLowerCase().replace(/_/g, " "));
    const m = {};
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) for (const a of aliases) { const i = norm.indexOf(a.replace(/_/g, " ")); if (i >= 0) { m[field] = i; break; } }
    return m;
  }
  const isSecDataset = (header) => { const h = header.map((x) => String(x).trim().toLowerCase()); return h.includes("series id") && h.includes("class id") && h.includes("cik number"); };
  function importRows(filename, rows, source = "Import") {
    rows = rows.map((r) => r.map((c) => (c == null ? "" : String(c)))).filter((r) => r.some((c) => c.trim()));
    if (!rows.length) return { records: [], warnings: ["File is empty"] };
    const m = mapColumns(rows[0]);
    if (m.fund_name == null && m.isin == null) return { records: [], warnings: [`Columns not recognised. Need at least 'Fund Name' or 'ISIN'. Found: ${rows[0].join(", ")}`] };
    const g = (r, f) => { const i = m[f]; return i != null && i < r.length && r[i].trim() ? r[i].trim() : null; };
    const warnings = [], records = [];
    rows.slice(1).forEach((r, k) => {
      const n = k + 2;
      const isin = (g(r, "isin") || "").toUpperCase() || null;
      if (isin && !isValidIsin(isin)) warnings.push(`Row ${n}: invalid ISIN ${isin}`);
      const fund = g(r, "fund_name") || g(r, "umbrella") || isin || "?";
      const cname = g(r, "class_name"), fid = g(r, "fund_id");
      records.push({ source, umbrella: g(r, "umbrella"), fund_id: fid, fund_name: fund, class_id: g(r, "class_id"), class_name: cname, isin, ticker: g(r, "ticker"),
        lei: fid && /^[A-Z0-9]{20}$/.test(fid) ? fid : null, currency: g(r, "currency") || classCurrency(cname), retro: parseRetro(g(r, "retro")),
        origin: `${filename}, row ${n}: ` + r.map((c) => c.trim()).filter(Boolean).join(" | ").slice(0, 300), origin_url: null });
    });
    return { records, warnings: warnings.slice(0, 50) };
  }

  /* SEC "Investment Company Series and Class" dataset (imported as CSV in the browser) */
  function secIndex(rows) {
    const h = rows[0].map((x) => String(x).trim().toLowerCase().replace(/^﻿/, ""));
    const ix = (n) => h.indexOf(n);
    const I = { cik: ix("cik number"), ent: ix("entity name"), sid: ix("series id"), sname: ix("series name"), cid: ix("class id"), cname: ix("class name"), tick: ix("class ticker") };
    return rows.slice(1).map((r) => ({ cik: (r[I.cik] || "").padStart(10, "0"), entity: r[I.ent] || "", sid: r[I.sid] || "", sname: r[I.sname] || "", cid: r[I.cid] || "", cname: r[I.cname] || "", ticker: r[I.tick] || "",
      _n: normFund(r[I.ent] || ""), _s: normFund(r[I.sname] || "") }));
  }
  function secSearch(index, query, limit = 15) {
    const q = normFund(query);
    if (!q) return [];
    const found = new Map(), fuzzy = new Map();
    for (const row of index) {
      let e = found.get(row.cik);
      if (e) e.classes++;
      const n = row._n, s = row._s;
      let score, how;
      if (q === n) { score = 1; how = "Registrant"; }
      else if (q === s) { score = 0.97; how = `Fund: ${row.sname}`; }
      else if (` ${n} `.includes(` ${q} `)) { score = 0.9; how = "Registrant"; }
      else if (words(q).length >= 2 && ` ${s} `.includes(` ${q} `)) { score = 0.85; how = `Fund: ${row.sname}`; }
      else { if (!fuzzy.has(n)) fuzzy.set(n, seqRatio(q, n)); score = fuzzy.get(n); how = "similar name"; if (score < 0.75) continue; }
      if (!e) { e = { cik: row.cik, entity_name: row.entity, score: 0, classes: 1, match: how }; found.set(row.cik, e); }
      if (score > e.score) { e.score = round3(score); e.match = how; }
    }
    return [...found.values()].sort((a, b) => b.score - a.score || (a.entity_name < b.entity_name ? -1 : 1)).slice(0, limit);
  }
  function secLoad(index, cik, datasetName = "SEC dataset") {
    cik = String(cik).padStart(10, "0");
    return index.filter((r) => r.cik === cik).map((r) => ({ source: "SEC", umbrella: r.entity, fund_id: r.sid, fund_name: r.sname || r.entity, class_id: r.cid, class_name: r.cname, isin: null, ticker: r.ticker || null, lei: null, currency: "USD", retro: null,
      origin: `${datasetName} · ${r.entity} · ${r.sid} ${r.sname} · ${r.cid} ${r.cname}`, origin_url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=485&dateb=&owner=include&count=40` }));
  }

  /* ================================================================ matching (delta) */
  const COVERED = "covered", NOT_COVERED = "gap", CHECK = "review", MATCH_THRESHOLD = 0.86;
  function nameScore(a, b) {
    const na = normFund(a), nb = normFund(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    const ta = new Set(words(na)), tb = new Set(words(nb));
    const inter = [...ta].filter((x) => tb.has(x)).length, union = new Set([...ta, ...tb]).size;
    const jacc = inter / union;
    const seq = seqRatio(sortStr([...ta]).join(" "), sortStr([...tb]).join(" "));
    const contain = (` ${nb} `.includes(` ${na} `) || ` ${na} `.includes(` ${nb} `)) && Math.min(ta.size, tb.size) >= 2 ? 0.93 : 0;
    return round3(Math.max(seq * 0.6 + jacc * 0.4, contain));
  }
  const CLASS_SYNONYMS = { institutional: "i", inst: "i", retail: "r", investor: "inv", advisor: "adv", adviser: "adv", thesaurierend: "acc", accumulating: "acc", "ausschüttend": "dis", distributing: "dis", hdg: "hedged", h: "hedged" };
  const CCYS = new Set(CCY.split("|"));
  function canonicalClass(name) {
    let s = clean(name);
    const m = /\(((?:Share\s+)?Class[^)]*|[^)]*Shares?)\)\s*$/.exec(s);
    if (m) s = m[1];
    if (/\b(?:Fund|Portfolio|ETF)\b.+/.test(s)) s = s.replace(/^.*?\b(?:Fund|Portfolio|ETF)\b\s*[-–:]?\s*/, "");
    return words(normClass(s)).map((t) => CLASS_SYNONYMS[t] || t).join(" ");
  }
  function classMatches(u, c) {
    if (!u || !c) return false;
    const a = canonicalClass(u), b = canonicalClass(c);
    if (a === b) return true;
    const ta = words(a), tb = words(b);
    if (!ta.length || !tb.length || ta[0] !== tb[0]) return false;
    const attrs = (t) => ({ ccy: t.find((x) => CCYS.has(x.toUpperCase())) || null, hedged: t.includes("hedged"), use: t.find((x) => ["acc", "dis", "inc"].includes(x)) || null,
      other: sortStr(t.slice(1).filter((x) => !CCYS.has(x.toUpperCase()) && !["hedged", "acc", "dis", "inc"].includes(x))).join(" ") });
    const x = attrs(ta), y = attrs(tb);
    if (x.hedged !== y.hedged || x.other !== y.other) return false;
    if (x.ccy && y.ccy && x.ccy !== y.ccy) return false;
    if (x.use && y.use && x.use !== y.use) return false;
    return true;
  }
  function retroStatus(cl, contractRetro) {
    if (cl.retro) return [cl.retro, "data"];
    if (contractRetro.length) return [contractRetro.some(Boolean) ? "yes" : "no", "agreement"];
    const g = guessRetro(cl.class_name);
    return g ? [g, "assumed"] : [null, null];
  }
  function coverageFromDocuments(docs) {
    const out = [];
    for (const d of docs) {
      const ex = d.extraction || {};
      for (const f of ex.funds || []) out.push({ doc_id: d.id, doc_name: d.filename, agreement_date: ex.agreement_date, distributor: ex.distributor, fund_entity: ex.fund_entity,
        fund_name: f.name, umbrella: f.umbrella, all_classes: !!f.all_classes, share_classes: f.share_classes || [] });
    }
    return out;
  }
  const classKey = (fund, cl) => cl.isin || cl.class_id || `${fund.fund_id || fund.fund_name}|${cl.class_name || ""}`;

  function buildOverview(universe, docs, manual = {}) {
    const docIds = Object.fromEntries(docs.map((d) => [d.filename, d.id]));
    const coverage = coverageFromDocuments(docs);
    const textNorm = Object.fromEntries(docs.map((d) => [d.id, " " + normFund(d.text || "") + " "]));
    const isinCov = new Map();
    for (const c of coverage) for (const s of c.share_classes) if (s.isin) { if (!isinCov.has(s.isin)) isinCov.set(s.isin, []); isinCov.get(s.isin).push(c); }
    const funds = new Map();
    for (const r of universe) {
      const key = JSON.stringify([r.umbrella || "", r.fund_id || r.fund_name]);
      if (!funds.has(key)) funds.set(key, { umbrella: r.umbrella || null, fund_id: r.fund_id || null, fund_name: r.fund_name, sources: new Set(), classes: [], _u: r.umbrella || "" });
      const f = funds.get(key);
      f.sources.add(r.source);
      if (r.class_name || r.isin || r.class_id) f.classes.push(r);
    }
    const used = new Set(), resultFunds = [];
    const ordered = [...funds.values()].sort((a, b) => (a._u < b._u ? -1 : a._u > b._u ? 1 : a.fund_name < b.fund_name ? -1 : a.fund_name > b.fund_name ? 1 : 0));
    for (const f of ordered) {
      const matches = new Map();
      for (const cl of f.classes) for (const c of isinCov.get(cl.isin || "") || []) matches.set(c, { cov: c, score: 1, how: "ISIN" });
      for (const c of coverage) { if (matches.has(c)) continue; const s = nameScore(f.fund_name, c.fund_name); if (s >= MATCH_THRESHOLD) matches.set(c, { cov: c, score: s, how: "name" }); }
      let fulltext = [];
      if (!matches.size) { const n = normFund(f.fund_name); if (words(n).length >= 2) fulltext = docs.filter((d) => textNorm[d.id].includes(` ${n} `)); }
      for (const c of matches.keys()) used.add(c);
      const classesOut = [];
      for (const cl of f.classes.length ? f.classes : [{ class_name: null, isin: null }]) {
        let status = NOT_COVERED, via = null, docsHit = [];
        const contractRetro = [];
        for (const m of matches.values()) {
          const c = m.cov;
          let hit = null, scHit = c.share_classes.find((s) => cl.isin && s.isin === cl.isin) || null;
          if (scHit) hit = "ISIN";
          else if (c.all_classes) hit = "all classes";
          else { scHit = c.share_classes.find((s) => classMatches(cl.class_name, s.name) && !(s.isin && cl.isin && s.isin !== cl.isin)) || null; hit = scHit ? "class name" : null; }
          if (hit) { status = COVERED; via = hit; docsHit.push(c.doc_name); if (scHit && scHit.retro != null) contractRetro.push(scHit.retro); }
        }
        if (status !== COVERED && ([...matches.values()].some((m) => !m.cov.share_classes.length && !m.cov.all_classes) || fulltext.length)) {
          status = CHECK; via = matches.size ? "fund named, classes not specified" : "fund found in full text only";
          docsHit = matches.size ? [...matches.values()].map((m) => m.cov.doc_name) : fulltext.map((d) => d.filename);
        }
        const key = classKey(f, cl);
        if (status !== COVERED && manual[key]) { status = COVERED; via = "added manually"; if (manual[key].doc_name) docsHit = [manual[key].doc_name]; }
        const [retro, basis] = retroStatus(cl, contractRetro);
        const dh = sortStr(uniq(docsHit.filter(Boolean)));
        classesOut.push({ class_name: cl.class_name ?? null, class_id: cl.class_id ?? null, isin: cl.isin ?? null, ticker: cl.ticker ?? null, currency: cl.currency ?? null, source: cl.source ?? null,
          status, via, documents: dh, document_ids: uniq(dh.filter((d) => d in docIds).map((d) => docIds[d])).sort((a, b) => a - b),
          key, origin: cl.origin ?? null, origin_url: cl.origin_url ?? null, lei: cl.lei ?? null, retro, retro_basis: basis, pays_retro: retro == null ? null : retro !== "no" });
      }
      const mv = [...matches.values()];
      const names = sortStr(uniq([...mv.map((m) => m.cov.doc_name), ...fulltext.map((d) => d.filename)]));
      const ids = uniq([...mv.map((m) => m.cov.doc_id), ...fulltext.map((d) => d.id)]).sort((a, b) => a - b);
      resultFunds.push({ umbrella: f.umbrella, fund_id: f.fund_id, fund_name: f.fund_name, sources: sortStr([...f.sources]),
        matched_agreements: names, matched_agreement_ids: names.map((n) => docIds[n] ?? ids[0]),
        match: mv.length ? Math.max(...mv.map((m) => m.score)) : fulltext.length ? 0.8 : 0,
        match_how: mv.length ? sortStr(uniq(mv.map((m) => m.how))) : fulltext.length ? ["full text"] : [],
        classes: classesOut, covered: classesOut.filter((c) => c.status === COVERED).length, total: classesOut.length,
        delta: classesOut.filter((c) => c.status === NOT_COVERED).length, check: classesOut.filter((c) => c.status === CHECK).length });
    }
    const unmatched = coverage.filter((c) => !used.has(c)).map((c) => ({ fund_name: c.fund_name, doc_name: c.doc_name, share_classes: c.share_classes, all_classes: c.all_classes }));
    const allC = resultFunds.flatMap((f) => f.classes);
    const totals = { funds: resultFunds.length, classes: allC.length, covered: allC.filter((c) => c.status === COVERED).length, delta: allC.filter((c) => c.status === NOT_COVERED).length,
      check: allC.filter((c) => c.status === CHECK).length, funds_without_agreement: resultFunds.filter((f) => !f.matched_agreements.length).length, agreement_funds_not_in_universe: unmatched.length,
      retro_classes: allC.filter((c) => c.pays_retro).length, retro_delta: allC.filter((c) => c.pays_retro && c.status === NOT_COVERED).length, retro_unknown: allC.filter((c) => c.pays_retro == null).length };
    const umb = new Map();
    for (const f of resultFunds) { const k = f.umbrella || "(no umbrella)"; if (!umb.has(k)) umb.set(k, []); umb.get(k).push(f); }
    return { totals, umbrellas: [...umb].map(([name, fs]) => ({ name, funds: fs })), unmatched_agreement_funds: unmatched };
  }

  function coverageOnlyOverview(docs) {
    const agg = new Map();
    for (const c of coverageFromDocuments(docs)) {
      const k = normFund(c.fund_name);
      if (!agg.has(k)) agg.set(k, { fund_name: c.fund_name, umbrella: c.umbrella || c.fund_entity, all_classes: false, classes: new Map(), documents: new Set() });
      const f = agg.get(k);
      f.all_classes = f.all_classes || !!c.all_classes;
      f.documents.add(c.doc_name);
      for (const s of c.share_classes) {
        const ck = s.isin || normClass(s.name || "");
        if (!f.classes.has(ck)) f.classes.set(ck, { name: s.name, isin: s.isin, fee: s.fee, retro: s.retro, documents: new Set() });
        f.classes.get(ck).documents.add(c.doc_name);
      }
    }
    return [...agg.values()].sort((a, b) => ((a.umbrella || "") + "\u0000" + a.fund_name < (b.umbrella || "") + "\u0000" + b.fund_name ? -1 : 1))
      .map((f) => ({ ...f, documents: sortStr([...f.documents]), classes: [...f.classes.values()].map((v) => ({ ...v, documents: sortStr([...v.documents]) })) }));
  }

  /* ================================================================ provider e-mail */
  const EMAIL_TEXT = {
    en: { subject: "Distribution agreement {provider} – share classes not covered", greeting: "Dear Sir or Madam,",
      intro: "As part of our periodic review of the distribution agreement{s} with {provider}{refs}, we have identified the following share classes that are available but are currently not covered by the agreement{s}:",
      retro_note: "Share classes marked with * pay retrocessions / trail commissions according to the available data.",
      ask: "Could you please confirm whether these share classes can be added to our agreement (e.g. by an amendment to the schedule of funds and share classes), including the applicable retrocession / trail commission terms? If individual share classes are not intended for distribution through us, a short note would be appreciated.",
      closing: "Thank you in advance for your support.\n\nKind regards", ref: " (agreement{s}: {list})", none: "(no share classes selected)" },
    de: { subject: "Vertriebsvereinbarung {provider} – nicht abgedeckte Anteilsklassen", greeting: "Sehr geehrte Damen und Herren",
      intro: "Im Rahmen unserer periodischen Überprüfung der Vertriebsvereinbarung{s} mit {provider}{refs} haben wir folgende Anteilsklassen identifiziert, die verfügbar, aber derzeit nicht von der Vereinbarung abgedeckt sind:",
      retro_note: "Mit * markierte Anteilsklassen zahlen gemäss den vorliegenden Daten Retrozessionen / Bestandespflegekommissionen.",
      ask: "Können Sie uns bitte bestätigen, ob diese Anteilsklassen in unsere Vereinbarung aufgenommen werden können (z. B. durch einen Nachtrag zum Anhang der Fonds und Anteilsklassen), inklusive der anwendbaren Retrozessions- bzw. Bestandespflegekonditionen? Falls einzelne Klassen nicht für den Vertrieb über uns vorgesehen sind, freuen wir uns über einen kurzen Hinweis.",
      closing: "Besten Dank für Ihre Unterstützung.\n\nFreundliche Grüsse", ref: " (Vereinbarung{s}: {list})", none: "(keine Anteilsklassen ausgewählt)" },
  };
  function emailDraft(provider, items, lang = "en") {
    const t = EMAIL_TEXT[lang] || EMAIL_TEXT.en;
    items = [...items].sort((a, b) => ((a.fund_name || "") + (a.class_name || "") < (b.fund_name || "") + (b.class_name || "") ? -1 : 1));
    const agreements = sortStr(uniq(items.flatMap((i) => (i.agreements || []).map((a) => String(a.name).split("/").pop()))));
    const plural = agreements.length > 1 ? (lang === "de" ? "en" : "s") : "";
    const refs = agreements.length ? t.ref.replace("{s}", plural).replace("{list}", agreements.join(", ")) : "";
    const pretty = (provider === provider.toUpperCase() ? titleCase(provider) : provider).replace(/\s+/g, " ");
    const lines = items.map((i) => `- ${i.fund_name} | ${(i.class_name || i.class_id || "–") + (i.pays_retro ? " *" : "")} | ISIN ${i.isin || i.class_id || "n/a"}`);
    const body = [t.greeting, t.intro.replace(/\{s\}/g, plural).replace("{provider}", pretty).replace("{refs}", refs), lines.length ? lines.join("\n") : t.none,
      ...(items.some((i) => i.pays_retro) ? [t.retro_note] : []), t.ask, t.closing].join("\n\n");
    return { to: "", subject: t.subject.replace("{provider}", pretty), body, count: items.length, keys: items.map((i) => i.key) };
  }
  function emlFile({ to = "", cc = "", subject = "", body = "" }) {
    const enc = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(utf8(s))}?=`);
    const lines = [`To: ${to}`, ...(cc ? [`Cc: ${cc}`] : []), `Subject: ${enc(subject)}`, "X-Unsent: 1", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(utf8(body)).replace(/(.{76})/g, "$1\r\n")];
    return lines.join("\r\n");
  }
  const utf8 = (s) => (typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s) : Buffer.from(s, "utf8"));
  function b64(bytes) {
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
    let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  const api = {
    clean, seqRatio, isValidIsin, isValidLei, isinCheckDigit, findIsins, findLeis, repairIsin, repairIsinsInText, ocrCleanup,
    normFund, normClass, classCurrency, extractParties, extractRetrocession, extractNotice, extractTerritory, extractDocument,
    findClasses, HEADER_FUND, HEADER_CLASS, HEADER_ISIN, parseRetro, guessRetro, classFeatures, parseCsv, importRows, isSecDataset,
    secIndex, secSearch, secLoad, nameScore, canonicalClass, classMatches, buildOverview, coverageOnlyOverview, classKey, emailDraft, emlFile,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.DMCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
