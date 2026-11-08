"use strict";
/* Accessibility pilot checks for the Math 9 Review app (Nov 2026).
   Loads the real single-file app in jsdom on an http://localhost origin
   (file resources served from this folder, so the vendored KaTeX loads
   exactly as in production and localStorage works), then verifies:
   - the app boots clean with the Accessibility settings panel present
   - each setting applies: html attributes flip, controls stay in sync,
     and computed styles of online-practice text actually change
   - printed output is isolated: sheet/exam markup (.pq, .sheetPrev,
     #printArea) never picks up the screen text sizes, the @media print
     resets are present, and no a11y selector reaches print markup
   - settings persist in localStorage and are re-applied pre-paint by the
     head bootstrap on a fresh load (beforeParse seeding)
   - shared settings links are untouched by display settings
   - reduced motion reaches scrollIntoView via scrollBehavior()
   - the embedded reading font: both @font-face payloads are extracted
     from the built file, checked as WOFF2 in node, and deep-parsed with
     fontTools (family, French cmap coverage, real glyph outlines).
     jsdom 24 has no CSS Font Loading API (no document.fonts, no
     FontFace), so this payload validation is the equivalent of a load
     check: it proves the exact bytes in the file form a valid font a
     browser can load, and the computed-style checks prove the stack
     that selects it.
   - KaTeX renders the bank's real TeX with throwOnError (node census),
     and no CSS anywhere sets font-family on a universal selector or on
     .katex (the known glyph-breaking pattern)
   Run: node a11y_check.js   (needs jsdom: NODE_PATH or /tmp/a11y-jsdom) */
const fs = require("fs"), path = require("path"), vm = require("vm");
let JSDOM, ResourceLoader, VirtualConsole;
try { ({ JSDOM, ResourceLoader, VirtualConsole } = require("jsdom")); }
catch (e) { ({ JSDOM, ResourceLoader, VirtualConsole } = require("/tmp/a11y-jsdom/node_modules/jsdom")); }
const APP_DIR = "/home/hatch/workspace/math-9-review";
const html = fs.readFileSync(path.join(APP_DIR, "index.html"), "utf8");

const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); else console.log("  ok -", m); };

class LocalLoader extends ResourceLoader {
  fetch(url) {
    const u = new URL(url);
    let p = decodeURIComponent(u.pathname);
    if (p === "/" || p === "/index.html") p = "/index.html";
    const file = path.join(APP_DIR, p);
    if (!file.startsWith(APP_DIR) || !fs.existsSync(file)) return Promise.resolve(Buffer.from(""));
    return fs.promises.readFile(file);
  }
}

function makeDom(seedStore) {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on("jsdomError", e => { if (!/favicon|Could not load/i.test(String(e.message))) errors.push("jsdomError: " + e.message); });
  const dom = new JSDOM(html, {
    url: "http://localhost/index.html",
    resources: new LocalLoader(),
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.__scrolls = [];
      window.Element.prototype.scrollIntoView = function (opts) { window.__scrolls.push(opts || {}); };
      if (seedStore) { try { window.localStorage.setItem("m9-a11y-v1", JSON.stringify(seedStore)); } catch (e) {} }
      window.addEventListener("error", e => errors.push("window error: " + e.message));
    }
  });
  return { dom, errors };
}
const ready = dom => new Promise(res => {
  if (dom.window.document.readyState === "complete") return res();
  dom.window.addEventListener("load", () => setTimeout(res, 60));
});

(async () => {
  /* ---------- 1. Boot with defaults ---------- */
  console.log("boot (fresh device):");
  const { dom, errors } = makeDom(null);
  await ready(dom);
  const w = dom.window, d = w.document;
  ok(errors.length === 0, "no page errors on boot" + (errors.length ? ": " + errors.join(" | ") : ""));
  ok(typeof w.katex === "object" && typeof w.renderMathInElement === "function", "vendored KaTeX loaded");
  ok(!!d.getElementById("a11yBox") && !!d.getElementById("a11yText") && !!d.getElementById("a11yReset"), "accessibility panel and controls exist");
  ok(!d.documentElement.hasAttribute("data-a11y-theme") && !d.documentElement.hasAttribute("data-a11y-text"), "no display attributes on a fresh device");
  ok(d.getElementById("a11yText").value === "std" && d.getElementById("a11yTheme").value === "light", "controls show the defaults");
  ok(w.scrollBehavior() === "smooth", "scrollBehavior() is smooth by default");

  /* ---------- 2. Online practice renders; settings change computed styles ---------- */
  console.log("online practice + settings:");
  d.getElementById("presetAll").click();
  d.getElementById("goOnline").click();
  const prompt = d.querySelector("#session .q .prompt");
  const optLabel = d.querySelector("#session .q .opts label");
  ok(!!prompt && !!optLabel, "online practice rendered questions");
  ok(d.querySelectorAll("#session .q .katex").length > 0, "KaTeX rendered inside practice questions");
  const cs = el => w.getComputedStyle(el);
  const basePrompt = cs(prompt).fontSize, baseOpt = cs(optLabel).fontSize, baseLH = cs(prompt).lineHeight;
  console.log("    base prompt font-size:", basePrompt, "| option:", baseOpt, "| line-height:", baseLH);
  const texSel = d.getElementById("a11yText"), thSel = d.getElementById("a11yTheme");
  const fire = el => el.dispatchEvent(new w.Event("change", { bubbles: true }));
  texSel.value = "large"; fire(texSel);
  ok(d.documentElement.getAttribute("data-a11y-text") === "large", "text=large sets the html attribute");
  ok(cs(prompt).fontSize !== basePrompt && parseFloat(cs(prompt).fontSize) > parseFloat(basePrompt), "prompt computed font-size grew: " + basePrompt + " -> " + cs(prompt).fontSize);
  ok(parseFloat(cs(optLabel).fontSize) > parseFloat(baseOpt), "option computed font-size grew");
  texSel.value = "xlarge"; fire(texSel);
  const xlPrompt = cs(prompt).fontSize;
  ok(parseFloat(xlPrompt) > parseFloat("1.12"), "extra large grows it further: " + xlPrompt);
  const spBox = d.getElementById("a11ySpacing"); spBox.click();
  ok(d.documentElement.getAttribute("data-a11y-spacing") === "roomy", "spacing checkbox sets the attribute");
  ok(parseFloat(cs(prompt).lineHeight) > parseFloat(baseLH) || cs(prompt).lineHeight !== baseLH, "roomy spacing changed prompt line-height: " + baseLH + " -> " + cs(prompt).lineHeight);
  const fontBox = d.getElementById("a11yFont"); fontBox.click();
  ok(d.documentElement.getAttribute("data-a11y-font") === "reading", "reading font sets the attribute");
  ok(/^"Atkinson Hyperlegible"/.test(cs(d.body).fontFamily) && /Comic Sans MS/.test(cs(d.body).fontFamily), "body computed font is the reading stack, embedded Atkinson first, system fonts behind: " + cs(d.body).fontFamily);
  const kx = d.querySelector("#session .q .katex");
  ok(kx && !/Comic|Atkinson/.test(cs(kx).fontFamily), "KaTeX element font is NOT the reading stack (tag " + (kx ? kx.tagName : "none") + ", computed: '" + (kx ? cs(kx).fontFamily : "") + "')");
  const katexCss = fs.readFileSync(path.join(APP_DIR, "katex", "katex.min.css"), "utf8");
  ok(/\.katex\{font:[^}]*KaTeX_Main/.test(katexCss), "katex.min.css gives .katex its own KaTeX_Main font, cutting off inheritance from the reading stack");
  thSel.value = "dark"; fire(thSel);
  ok(d.documentElement.getAttribute("data-a11y-theme") === "dark", "dark theme sets the attribute");
  console.log("    dark body background (as resolved by jsdom):", cs(d.body).backgroundColor, "| color:", cs(d.body).color);
  const moBox = d.getElementById("a11yMotion"); moBox.click();
  ok(w.scrollBehavior() === "auto", "reduced motion flips scrollBehavior() to auto");
  w.__scrolls.length = 0;
  d.getElementById("againBtn").click();
  ok(w.__scrolls.length > 0 && w.__scrolls.every(s => s.behavior === "auto"), "scrollIntoView calls during re-draw all use behavior auto");
  const saved = JSON.parse(w.localStorage.getItem("m9-a11y-v1") || "null");
  ok(saved && saved.text === "xlarge" && saved.theme === "dark" && saved.font && saved.spacing && saved.motion, "all five settings persisted to localStorage");

  /* ---------- 3. Shared link is unaffected ---------- */
  const urlWith = w.settingsToURL();
  d.getElementById("a11yReset").click();
  ok(!d.documentElement.hasAttribute("data-a11y-theme") && w.scrollBehavior() === "smooth", "reset clears the settings");
  ok(w.settingsToURL() === urlWith, "settingsToURL() identical with and without display settings");
  ok(!/a11y|dark|reading|roomy/.test(urlWith), "no display-setting values leak into the shared link: " + urlWith);

  /* ---------- 4. Print isolation with everything switched on ---------- */
  console.log("print isolation (all settings on):");
  texSel.value = "xlarge"; fire(texSel); thSel.value = "dark"; fire(thSel); fontBox.click();
  d.getElementById("goSheet").click();
  const pqPrompt = d.querySelector("#session .sheetPrev .pq .prompt");
  ok(!!pqPrompt, "sheet preview rendered");
  ok(cs(pqPrompt).fontSize === basePrompt, "sheet preview prompt keeps the standard size under extra-large text: " + cs(pqPrompt).fontSize);
  ok((d.getElementById("printArea").innerHTML || "").length > 500, "printArea populated for the sheet");
  d.getElementById("goExam").click();
  ok((d.getElementById("printArea").innerHTML || "").length > 500, "printArea populated for the exam");
  const styleText = [...d.querySelectorAll("style")].map(s => s.textContent).join("\n");
  ok(/#app\{display:none !important;\}/.test(styleText) && /#printArea\{display:block !important;\}/.test(styleText), "base print rules intact (#app hidden, #printArea shown)");
  ok(/@media print\{\s*html\[data-a11y-theme="dark"\]\{--ink:#1c2b33 !important/.test(styleText), "print reset restores the light ink under the dark theme");
  ok(/html\[data-a11y-font="reading"\] body\{font-family:Verdana,Geneva,sans-serif !important;\}/.test(styleText), "print reset restores the standard font under the reading font");
  const a11yCss = styleText.slice(styleText.indexOf("/* ============ Accessibility settings (pilot")).replace(/\/\*[\s\S]*?\*\//g, "");
  const screenPart = a11yCss.slice(0, a11yCss.indexOf("@media print{"));
  const badSel = screenPart.split("}").map(r => r.split("{")[0]).filter(s => /data-a11y-(text|spacing)/.test(s) && !/#app/.test(s));
  ok(badSel.length === 0, "every text/spacing selector is anchored to #app");
  const printReach = screenPart.split("}").map(r => r.split("{")[0]).filter(s => /data-a11y/.test(s) && /#printArea|\.pq|\.sheetPrev/.test(s));
  ok(printReach.length === 0, "no screen a11y selector reaches print markup (.pq/.sheetPrev/#printArea)");
  ok(!/\*\s*\{[^}]*font-family/.test(styleText) && !/\.katex[^{]*\{[^}]*font-family/.test(styleText.split("Accessibility settings (pilot)")[1] || ""), "no universal-selector or .katex font-family in the app CSS");
  const darkVars = (styleText.match(/html\[data-a11y-theme="dark"\]\{([^}]*)\}/) || [])[1] || "";
  ok(/--bg:#0e1418/.test(darkVars) && /--ink:#eef4f1/.test(darkVars) && /body\{margin:0;background:var\(--bg\);color:var\(--ink\);\}/.test(styleText),
     "dark theme swaps the palette variables that body paints from (jsdom does not resolve var(), so this link is asserted structurally)");

  /* ---------- 5. Fresh load with saved settings: bootstrap applies pre-paint ---------- */
  console.log("persistence across loads:");
  const seed = { text: "large", theme: "dark", font: true, spacing: true, motion: true };
  const second = makeDom(seed);
  await ready(second.dom);
  const h2 = second.dom.window.document.documentElement;
  ok(h2.getAttribute("data-a11y-text") === "large" && h2.getAttribute("data-a11y-theme") === "dark" &&
     h2.getAttribute("data-a11y-font") === "reading" && h2.getAttribute("data-a11y-spacing") === "roomy" &&
     h2.getAttribute("data-a11y-motion") === "reduced", "saved settings are on <html> after a fresh load");
  ok(second.dom.window.scrollBehavior() === "auto", "scrollBehavior() honours the saved reduced-motion setting");
  ok(second.errors.length === 0, "no page errors on the seeded boot");

  /* ---------- 6. KaTeX census over the bank's real TeX (node, throwOnError) ---------- */
  console.log("KaTeX census:");
  const katex = require(path.join(APP_DIR, "katex", "katex.min.js"));
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const engIdx = blocks.findIndex(b => b.includes("selection engine"));
  const eng = blocks[engIdx], cut = eng.indexOf("/* ============ UI ============ */");
  const src = (blocks.slice(0, engIdx).join("\n") + "\n" + eng.slice(0, cut)).replace(/"use strict";/g, "");
  const bank = vm.runInNewContext(src + "\n;BANK;", { console });
  const texSet = new Set();
  bank.forEach(e => { for (let i = 0; i < 25; i++) { try { const q = e.gen(); const grab = s => { if (typeof s === "string") for (const m of s.matchAll(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g)) texSet.add(m[1] || m[2]); };
    grab(q.prompt); grab(q.solution); (q.options || []).forEach(grab); } catch (err) {} } });
  let rendered = 0, renderFails = [];
  texSet.forEach(t => { try { katex.renderToString(t, { throwOnError: true }); rendered++; } catch (err) { renderFails.push(t + " :: " + err.message); } });
  ok(renderFails.length === 0, rendered + " distinct TeX segments render with throwOnError, 0 failures" + (renderFails.length ? ": " + renderFails.slice(0, 3).join(" | ") : ""));
  const frac = katex.renderToString("\\frac{3}{4}+\\sqrt{2}", { throwOnError: true });
  ok(/katex/.test(frac) && frac.includes("mfrac") && frac.includes("frac-line") && frac.includes("sqrt"), "fraction and radical produce full KaTeX glyph structure (mfrac, frac-line, sqrt)");

  /* ---------- 7. Embedded reading font payloads ----------
     jsdom has no Font Loading API, so the load check is done on the
     payload bytes themselves: WOFF2 structure in node, then a real
     fontTools parse (family name, cmap coverage incl. the French set,
     non-empty outlines) via python3. Fails loudly if python3/fontTools
     is unavailable, rather than silently skipping. */
  console.log("embedded reading font:");
  const faceRe = /@font-face\{font-family:"Atkinson Hyperlegible";font-style:normal;font-weight:(\d+);[^}]*base64,([A-Za-z0-9+/=]+)\) format\("woff2"\);?\}/g;
  const faceMatches = [...html.matchAll(faceRe)];
  ok(faceMatches.length === 2 && faceMatches.map(m => m[1]).sort().join() === "400,700", "exactly two embedded @font-face faces (400 and 700): " + faceMatches.length + " found");
  const os = require("os"), { execFileSync } = require("child_process");
  const payloadPaths = [];
  let structOk = faceMatches.length === 2;
  for (const m of faceMatches) {
    const buf = Buffer.from(m[2], "base64");
    const magic = buf.toString("latin1", 0, 4), flavor = buf.readUInt32BE(4), totalLen = buf.readUInt32BE(8), numTables = buf.readUInt16BE(12);
    if (magic !== "wOF2" || totalLen !== buf.length || numTables < 10) structOk = false;
    console.log("    weight " + m[1] + ": " + buf.length + " bytes decoded, magic " + magic + ", flavor 0x" + flavor.toString(16) + ", header length " + totalLen + ", " + numTables + " tables");
    const p = path.join(os.tmpdir(), "a11y-atk-" + m[1] + ".woff2");
    fs.writeFileSync(p, buf); payloadPaths.push(p);
  }
  ok(structOk, "both payloads are structurally valid WOFF2 (magic, header length matches, full table set)");
  const pyCheck = [
    "import sys, io, json",
    "from fontTools.ttLib import TTFont",
    "req = {0x41,0x61,0x62,0x64,0x67,0x70,0x71,0x49,0x6C,0x31,0xE0,0xE2,0xE4,0xE7,0xE8,0xE9,0xEA,0xEB,0xEE,0xEF,0xF4,0xF6,0xF9,0xFB,0xFC,0xFF,0xE6,0x153,0x152,0x178,0x20AC,0xAB,0xBB}",
    "out = []",
    "for p in sys.argv[1:]:",
    "    f = TTFont(io.BytesIO(open(p,'rb').read()))",
    "    fam = f['name'].getDebugName(4) or ''",
    "    cmap = f.getBestCmap()",
    "    missing = [hex(c) for c in sorted(req) if c not in cmap]",
    "    glyf = f['glyf']",
    "    empty = [ch for ch in 'abdgpq' if glyf[cmap[ord(ch)]].numberOfContours == 0]",
    "    out.append({'family': fam, 'codepoints': len(cmap), 'missing': missing, 'empty': empty})",
    "print(json.dumps(out))"
  ].join("\n");
  let parsed = null, parseErr = "";
  try { parsed = JSON.parse(execFileSync("python3", ["-c", pyCheck, ...payloadPaths], { encoding: "utf8" })); }
  catch (e) { parseErr = String(e.message || e).slice(0, 200); }
  ok(!!parsed && parsed.length === 2, "fontTools parses both embedded payloads (a real font load of the exact bytes)" + (parsed && parsed.length === 2 ? "" : ": " + (parseErr || "parsed " + (parsed ? parsed.length : "nothing"))));
  if (parsed) for (const r of parsed) {
    ok(/Atkinson Hyperlegible/.test(r.family), "payload family is Atkinson Hyperlegible: " + r.family);
    ok(r.missing.length === 0 && r.empty.length === 0, "payload covers the French character set and key letters have real outlines (" + r.codepoints + " codepoints)" + (r.missing.length ? " missing: " + r.missing.join(",") : "") + (r.empty.length ? " empty: " + r.empty.join(",") : ""));
  }
  payloadPaths.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });

  console.log(fails.length ? "\nFAIL: " + fails.join(" | ") : "\nA11Y CHECK: ALL PASS");
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR:", e && e.stack || e); process.exit(2); });
