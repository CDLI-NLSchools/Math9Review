#!/usr/bin/env node
/* Brightspace export harness: runs the real exporter from
   index.html in a stub DOM (same pattern as docx_check.js),
   builds a pilot package from a mixed sample set picked from this
   app's own bank (MC, numeric, text, plus a figure-bearing entry), and verifies it locally:
   - XML well-formedness of manifest and quiz files
   - dialect parity of tag/attribute skeletons against the proven models
     (authored U6 checkpoint quiz, English 3201 v4 questiondb, the
     arithmetic questiondb generated from a native sandbox export, and
     the native single-quiz export manifest from org unit 171846)
   - pool/variant counts, draw counts, weightings, answers, feedback,
     tolerance, MathML presence, figure files in the zip
   Run: node bs_check.js */
const fs = require("fs"), vm = require("vm"), path = require("path"), { execFileSync } = require("child_process");
const APP = __dirname;
const katex = require(path.join(APP, "katex", "katex.min.js"));

/* ---------- stub DOM, same pattern as docx_check.js ---------- */
const els = {}, listeners = {};
function parseChks(htmlStr, cls) {
  if (!htmlStr) return [];
  const re = new RegExp('<input[^>]*class="' + cls + '"[^>]*>', "g");
  const out = []; let m;
  while ((m = re.exec(htmlStr))) {
    const tag = m[0];
    out.push({ value: (tag.match(/value="([^"]*)"/) || [])[1], checked: / checked/.test(tag), addEventListener() {} });
  }
  return out;
}
function makeEl(id) {
  const e = { id, children: [], style: {}, dataset: {}, value: "", checked: false, _inner: "", _text: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(t, f) { listeners[id] = { click: f }; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return null; }, querySelectorAll() { return []; } };
  Object.defineProperty(e, "innerHTML", { get() { return this._inner; }, set(v) { this._inner = String(v); } });
  Object.defineProperty(e, "textContent", { get() { return this._text; }, set(v) { this._text = String(v); } });
  return e;
}
["presetMid", "presetFinal", "presetAll", "presetUnit"].forEach(id => {
  const e = makeEl(id); e.dataset.preset = id.replace("preset", "").toLowerCase(); els[id] = e;
});
const documentStub = {
  getElementById(id) { return els[id] || (els[id] = makeEl(id)); },
  querySelectorAll(sel) {
    if (sel === ".preset") return ["presetMid", "presetFinal", "presetAll", "presetUnit"].map(i => els[i]);
    if (sel === ".unitChk") return parseChks(els.unitGrid && els.unitGrid.innerHTML, "unitChk");
    if (sel === ".unitChk:checked") return parseChks(els.unitGrid && els.unitGrid.innerHTML, "unitChk").filter(c => c.checked);
    if (sel === ".indChk") return parseChks(els.indBox && els.indBox.innerHTML, "indChk");
    if (sel === ".indChk:checked") return parseChks(els.indBox && els.indBox.innerHTML, "indChk").filter(c => c.checked);
    return [];
  },
  querySelector() { return null; },
  createElement() { return makeEl("anon"); },
  createTreeWalker() { return { nextNode() { return null; } }; },
  body: makeEl("body"),
};
const sandbox = { console, URLSearchParams, document: documentStub, TextEncoder: require("util").TextEncoder,
  location: { search: "", pathname: "/index.html", origin: "http://test", href: "http://test/index.html" },
  history: { replaceState() {} }, navigator: {}, setTimeout, clearTimeout, print() {}, NodeFilter: { SHOW_TEXT: 4 },
  katex, renderMathInElement: null };
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const html = fs.readFileSync(path.join(APP, "index.html"), "utf8");
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
blocks.forEach((b, i) => vm.runInContext(b, sandbox, { filename: "block" + i }));
const S = sandbox;
const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); };
const note = [];
ok(typeof S.buildBrightspacePackage === "function", "buildBrightspacePackage not defined (exporter missing)");

/* ---------- figure rasterizer for the harness (browser uses canvas) ---------- */
function rasterFn(svg) {
  return Promise.resolve().then(() => {
    const w = parseInt((svg.match(/width="(\d+)"/) || [])[1] || "330", 10);
    const f = "/tmp/bsfig.svg", o = "/tmp/bsfig.png";
    fs.writeFileSync(f, svg);
    execFileSync("python3", ["-m", "cairosvg", f, "-o", o, "-W", String(w * 2)], { stdio: "pipe" });
    return { bytes: fs.readFileSync(o) };
  }).catch(() => null);
}

/* ---------- XML well-formedness (tokenizer + stack) ---------- */
function xmlErrors(xml) {
  const errs = [];
  const VOID = {}; // QTI files here use explicit close or self-close only
  let i = 0; const stack = [];
  const text = (t) => { if (/[<>]/.test(t)) errs.push("raw angle bracket in text"); if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(t)) errs.push("raw & in text near: " + t.slice(0, 40)); };
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) { text(xml.slice(i)); break; }
    if (lt > i) text(xml.slice(i, lt));
    if (xml.startsWith("<!--", lt)) { const e = xml.indexOf("-->", lt); i = e < 0 ? xml.length : e + 3; continue; }
    if (xml.startsWith("<?", lt)) { const e = xml.indexOf("?>", lt); i = e < 0 ? xml.length : e + 2; continue; }
    if (xml.startsWith("<!", lt)) { const e = xml.indexOf(">", lt); i = e < 0 ? xml.length : e + 1; continue; }
    const gt = xml.indexOf(">", lt);
    if (gt < 0) { errs.push("unterminated tag"); break; }
    let tag = xml.slice(lt + 1, gt);
    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      if (stack.pop() !== name) errs.push("mismatched close: " + name);
    } else {
      const selfClose = tag.endsWith("/");
      const name = (tag.match(/^[^\s/>]+/) || [""])[0];
      // attribute sanity: every attr value quoted
      const attrStr = tag.slice(name.length);
      if (/(^|\s)[^\s=/>]+=[^"'\s]/.test(attrStr)) errs.push("unquoted attr in <" + name + ">");
      if (!selfClose && !VOID[name]) stack.push(name);
    }
    i = gt + 1;
  }
  if (stack.length) errs.push("unclosed: " + stack.join(","));
  return errs;
}
function tagSeq(xml, from, to) {
  const seg = xml.slice(xml.indexOf(from), xml.indexOf(to) + to.length);
  return [...seg.matchAll(/<([a-zA-Z][\w:.-]*)[\s/>]/g)].map(m => m[1]);
}
function tagSet(xml) { return [...new Set([...xml.matchAll(/<([a-zA-Z][\w:.-]*)[\s/>]/g)].map(m => m[1]))].sort(); }
function firstItem(xml) { const m = xml.match(/<item .*?<\/item>/s); return m ? m[0] : ""; }
function unesc(s) { return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"); }

/* ---------- build the pilot package ---------- */
/* Sample picked from this app's own bank: first MC entry, first numeric
   entry, first text entry, first figure-bearing entry, first entry of
   any remaining kind, in bank order, duplicates removed. */
function pickSample() {
  const byType = { mc: [], num: [], text: [] };
  let fig = null, any = null;
  for (const e of S.BANK) {
    let q = null;
    try { q = e.gen(); } catch (err) { continue; }
    if (!q) continue;
    if (!any) any = e.id;
    if (q.figure && !fig) fig = e.id;
    if (byType[q.type] && !byType[q.type].includes(e.id)) byType[q.type].push(e.id);
    if (byType.mc.length >= 2 && byType.num.length >= 2 && byType.text.length >= 1 && fig) break;
  }
  const ids = [...new Set([byType.mc[0], byType.num[0], byType.text[0], fig, byType.mc[1] || byType.num[1], any].filter(Boolean))].slice(0, 5);
  if (!byType.text.length) note.push("bank scan found no text-type entry; Long Answer coverage comes from any non-numeric answers in the numeric pools");
  return ids;
}
const SAMPLE = pickSample();
const items = SAMPLE.map(id => {
  const e = S.BANK.find(x => x.id === id);
  if (!e) { fails.push("sample entry missing: " + id); return null; }
  const q = e.gen(); q._entry = e; return q;
}).filter(Boolean);
note.push("sample types: " + items.map(q => q._entry.id + "=" + q.type + (q.figure ? "+fig" : "")).join(", "));

S.buildBrightspacePackage(items, 10, rasterFn).then(res => {
  const outDir = path.join(APP, "brightspace-pilot");
  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, "Math-9-Brightspace-Pilot.zip");
  fs.writeFileSync(zipPath, Buffer.from(res.bytes));
  fs.writeFileSync(path.join(outDir, "quiz_d2l_M9BS.xml"), res.quizXml);
  fs.writeFileSync(path.join(outDir, "imsmanifest.xml"), res.manifestXml);
  const st = res.stats, quiz = res.quizXml, man = res.manifestXml;
  note.push("stats: " + JSON.stringify(st));

  /* well-formedness */
  ok(xmlErrors(quiz).length === 0, "quiz XML errors: " + xmlErrors(quiz).join(" | "));
  ok(xmlErrors(man).length === 0, "manifest XML errors: " + xmlErrors(man).join(" | "));
  /* quiz description: native dialect puts the Description in the
     assessment rubric mattext as text/html; intro_message stays empty */
  ok(quiz.includes('<mattext d2l_2p0:isdisplayed="yes" texttype="text/html">&lt;p&gt;This quiz mirrors a practice set built in the Math 9 Review app.'), "quiz description missing from the rubric mattext slot");
  ok(quiz.includes('<d2l_2p0:intro_message d2l_2p0:isdisplayed="no" texttype="text/plain" />'), "intro_message not in the proven empty form");
  ok(!quiz.includes("question&#39;s"), "double-escaped apostrophe still present in quiz header");

  /* dialect parity: assessment header children sequence vs authored U6CP1 */
  const REF = "/tmp/d2lref";
  const u6 = fs.readFileSync(path.join(REF, "u6auth/quiz_d2l_U6CP1.xml"), "utf8");
  const eng = fs.readFileSync("/home/hatch/workspace/english-3201/package/staging-v4/eng3201/questiondb.xml", "utf8");
  const arith = fs.readFileSync(path.join(REF, "questiondb.xml"), "utf8");
  const nat = fs.readFileSync(path.join(REF, "sandbox/quiz_d2l_97420.xml"), "utf8");
  const natMan = fs.readFileSync(path.join(REF, "sandbox/imsmanifest.xml"), "utf8");
  const hdrMine = tagSeq(quiz, "<assessment", "</assessfeedback>");
  const hdrRef = tagSeq(u6, "<assessment", "</assessfeedback>");
  ok(JSON.stringify(hdrMine) === JSON.stringify(hdrRef), "assessment header tag sequence differs from U6CP1 model");
  /* RAND section skeleton vs authored */
  const randMine = quiz.slice(quiz.indexOf("<section title=\"Question"), quiz.indexOf("<item "));
  const randRef = u6.slice(u6.indexOf("<section title=\"Q1\""), u6.indexOf("<item "));
  ok(tagSet(randMine).join() === tagSet(randRef).join(), "RAND section tag set differs: " + tagSet(randMine) + " vs " + tagSet(randRef));
  /* item skeletons */
  const itemsXml = [...quiz.matchAll(/<item .*?<\/item>/gs)].map(m => m[0]);
  const byType = t => itemsXml.find(x => x.includes("<fieldentry>" + t + "</fieldentry>"));
  const mcTags = tagSet(byType("Multiple Choice") || ""), mcRef = tagSet(firstItem(u6));
  if (!byType("Multiple Choice")) note.push("no MC item in sample package; MC parity skipped"); else ok(mcTags.join() === mcRef.join(), "MC item tag set differs from U6CP1: extra=" + mcTags.filter(t => !mcRef.includes(t)) + " missing=" + mcRef.filter(t => !mcTags.includes(t)));
  const laTags = tagSet(byType("Long Answer") || "");
  const laRefItem = [...eng.matchAll(/<item .*?<\/item>/gs)].map(m => m[0]).find(x => x.includes("Long Answer"));
  const laRef = tagSet(laRefItem);
  if (!byType("Long Answer")) note.push("no Long Answer item in sample package; LA parity skipped"); else ok(laTags.join() === laRef.join(), "LA item tag set differs from English 3201: extra=" + laTags.filter(t => !laRef.includes(t)) + " missing=" + laRef.filter(t => !laTags.includes(t)));
  const arTags = tagSet(byType("Arithmetic") || "");
  const arRef = tagSet(firstItem(arith)).filter(t => !["hint", "hintmaterial", "flow_mat"].includes(t));
  if (!byType("Arithmetic")) note.push("no Arithmetic item in sample package; Arithmetic parity skipped"); else ok(arTags.join() === arRef.join(), "Arithmetic item tag set differs from model (hint excluded by design): extra=" + arTags.filter(t => !arRef.includes(t)) + " missing=" + arRef.filter(t => !arTags.includes(t)));
  /* manifest resource attributes vs native export */
  const resMine = (man.match(/<resource [^>]*>/) || [""])[0], resRef = (natMan.match(/<resource [^>]*d2lquiz[^>]*>/) || [""])[0];
  const attrs = s => [...s.matchAll(/([\w:.-]+)=/g)].map(m => m[1]).sort();
  ok(attrs(resMine).join() === attrs(resRef).join(), "manifest quiz resource attributes differ from native export: " + attrs(resMine) + " vs " + attrs(resRef));

  /* counts and content */
  const pools = [...quiz.matchAll(/<section title="Question \d+"[^>]*ident="RAND_BS_\d+"/g)];
  ok(pools.length === items.length, "pool count " + pools.length + " != set size " + items.length);
  ok(st.pools === items.length && st.variants >= items.length, "stats pools/variants wrong");
  const noi = [...quiz.matchAll(/qmd_numberofitems<\/fieldlabel><fieldentry>(\d+)/g)].map(m => m[1]);
  ok(noi.length === items.length && noi.every(v => v === "1"), "numberofitems not all 1: " + noi.join());
  const poolItems = [...quiz.matchAll(/ident="RAND_BS_(\d+)"[\s\S]*?(?=<section title="Question| <\/section><\/section>)/g)];
  /* per-pool variant counts */
  const chunks = quiz.split(/<section title="Question \d+"/).slice(1);
  const counts = chunks.map(c => (c.match(/<item /g) || []).length);
  note.push("variants per pool: " + counts.join(", "));
  ok(counts.every(c => c >= 1 && c <= 10), "a pool has out-of-range variant count: " + counts.join());
  /* MC: exactly one 100 setvar per item, feedback count = options + 1 (general) */
  itemsXml.filter(x => x.includes("Multiple Choice")).forEach((x, i) => {
    ok((x.match(/<setvar action="Set">100\.000000000<\/setvar>/g) || []).length === 1, "MC item " + i + " does not have exactly one 100 setvar");
    const fb = (x.match(/<itemfeedback /g) || []).length, opts = (x.match(/<response_label /g) || []).length;
    ok(fb === opts + 1, "MC item " + i + " feedback blocks " + fb + " != options+1 " + (opts + 1));
  });
  /* arithmetic tolerance and formula match the dealt questions */
  items.filter(q => q.type === "num").forEach(q => {
    const tol = String(q.tol), ans = String(q.answer).replace(/[$,\s]/g, "");
    ok(quiz.includes('<tolerance type="units">' + tol + "</tolerance>"), "tolerance " + tol + " missing for " + q._entry.id);
    ok(quiz.includes("<formula>" + ans + "</formula>"), "formula " + ans + " missing for " + q._entry.id);
  });
  /* worked solutions present: the dealt variant's general feedback must
     carry exactly what the exporter's own bsHtml produces for its
     solution (MathML and all) */
  ok(typeof S.bsHtml === "function", "bsHtml not exposed for solution probe");
  if (typeof S.bsHtml === "function") {
    const probe = unesc(quiz);
    items.forEach(q => {
      const expected = S.bsHtml(q.solution || "", { degraded: 0 });
      ok(probe.includes(expected), "worked solution HTML not found verbatim for " + q._entry.id);
    });
  }
  /* MathML present */
  const mml = (quiz.match(/&lt;math[\s>]/g) || []).length;
  note.push("MathML segments in quiz (escaped): " + mml + "; degraded segments: " + st.degraded);
  ok(mml > 20, "suspiciously few MathML segments: " + mml);
  /* figures: files in zip + referenced */
  if (items.some(q => q.figure)) ok(st.figures >= 1, "no figure rasterized"); else note.push("sample has no figure-bearing entry; figure checks skipped");
  const { execFileSync: ex } = require("child_process");
  const listing = ex("unzip", ["-l", zipPath]).toString();
  const pngs = (listing.match(/M9Fig_\d+_\d+\.png/g) || []);
  ok(pngs.length === st.figures, "zip PNG count " + pngs.length + " != stats " + st.figures);
  const quizU = unesc(quiz);
  pngs.forEach(p => ok(quizU.includes('src="' + p + '"'), "figure not referenced in quiz: " + p));
  ok(listing.includes("imsmanifest.xml") && listing.includes("quiz_d2l_M9BS.xml"), "zip missing core files");
  const tzip = ex("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip())", zipPath]).toString().trim();
  ok(tzip === "None", "zip CRC check: " + tzip);

  console.log(note.join("\n"));
  console.log(fails.length ? "FAIL: " + fails.join(" | ") : "PASS — Brightspace pilot package built and verified: " + zipPath);
  process.exit(fails.length ? 1 : 0);
}).catch(e => { console.log("FAIL (exception): " + e.stack); process.exit(1); });
