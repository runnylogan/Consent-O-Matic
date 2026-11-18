import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import Ajv from "ajv";

// Minimal CSS.escape (jsdom lacks it; real browsers have it).
globalThis.CSS = { escape: (s) => String(s).replace(/([^a-zA-Z0-9_\u00A0-\uFFFF-])/g, "\\$1").replace(/^(\d)/, "\\3$1 ") };

const { discover, classifyButtons, classifyToggles, exploreOptions, openerRule, generateRuleFromPicks, uniqueSelector, categoryFor, containerOf, displayLabel } = await import("../Extension/Discovery.js");
const schema = JSON.parse(fs.readFileSync(new URL("../rules.schema.json", import.meta.url)));
const ajv = new Ajv({ strict: false, allErrors: true });
const validate = ajv.compile(schema);

function load(html) {
    const dom = new JSDOM(`<!doctype html><body><main><h1>Site</h1><p>Lots of page content here.</p></main>${html}</body>`,
        { pretendToBeVisual: true });
    globalThis.window = dom.window;
    return dom.window.document;
}

function resolveAll(doc, node, out = []) {
    // Collect every {parent,target} selector pair and confirm each resolves.
    if (Array.isArray(node)) node.forEach(n => resolveAll(doc, n, out));
    else if (node && typeof node === "object") {
        if (node.target && node.target.selector) out.push({ parent: node.parent?.selector, target: node.target.selector });
        Object.values(node).forEach(v => resolveAll(doc, v, out));
    }
    return out;
}

function assertRuleResolves(doc, rule) {
    for (const { parent, target } of resolveAll(doc, rule)) {
        const root = parent ? doc.querySelector(parent) : doc;
        assert.ok(root, `parent selector resolves: ${parent}`);
        assert.ok(root.querySelector(target), `target selector resolves: ${target}`);
    }
}

const BINARY = `
<div id="cookie-notice" style="position:fixed;bottom:0;z-index:999">
  <p>We use cookies to improve your experience and for advertising. See our privacy policy.</p>
  <button class="btn-a">Accept all</button>
  <button class="btn-r">Reject all</button>
</div>`;

const GRANULAR = `
<div class="xk3-consent-wrap" role="dialog" aria-modal="true" style="position:fixed">
  <h2>Cookie preferences</h2>
  <p>Choose which cookies we may use for consent purposes.</p>
  <ul>
    <li><label><input type="checkbox" checked disabled> Strictly necessary</label></li>
    <li><label><input type="checkbox" id="c-an"> Analytics and statistics</label></li>
    <li><label><input type="checkbox" id="c-mk"> Marketing and advertising</label></li>
    <li><label><input type="checkbox" id="c-fn"> Functional preferences</label></li>
  </ul>
  <button class="save">Save settings</button>
  <button class="all">Accept all</button>
</div>`;

const HIDDEN_OPTIONS = `
<div id="privacy-banner" style="position:fixed">
  <p>This site uses cookies and tracking. Manage your consent below.</p>
  <button id="more">Cookie settings</button>
  <button id="ok">Accept</button>
  <div class="panel" style="display:none">
    <label><input type="checkbox" id="p1"> Performance analytics</label>
    <label><input type="checkbox" id="p2"> Advertising partners</label>
    <button id="confirm">Confirm choices</button>
  </div>
</div>`;

test("binary banner -> ifallowall/accept vs reject", () => {
    const doc = load(BINARY);
    const found = discover(doc, "example.test");
    assert.ok(found, "banner discovered");
    assert.equal(found.analysis.accept, "Accept all");
    assert.equal(found.analysis.reject, "Reject all");
    assert.ok(validate(found.rule), JSON.stringify(validate.errors));
    assertRuleResolves(doc, found.rule);
    const save = found.rule[found.name].methods.find(m => m.name === "SAVE_CONSENT");
    assert.equal(save.action.actions[0].type, "ifallowall");
});

test("granular banner -> one consent per non-necessary toggle, correct categories", () => {
    const doc = load(GRANULAR);
    const found = discover(doc, "example.test");
    assert.ok(found);
    const consent = found.rule[found.name].methods.find(m => m.name === "DO_CONSENT").action.consents;
    assert.deepEqual(consent.map(c => c.type).sort(), ["A", "B", "F"]);
    assert.ok(validate(found.rule), JSON.stringify(validate.errors));
    assertRuleResolves(doc, found.rule);
    const save = found.rule[found.name].methods.find(m => m.name === "SAVE_CONSENT");
    assert.ok(save, "has save step");
    assert.equal(found.analysis.save, "Save settings");
    assert.equal(found.analysis.manage, undefined, "'Save settings' must not be taken for an options button");
});

test("hidden options -> OPEN_OPTIONS click added", () => {
    const doc = load(HIDDEN_OPTIONS);
    const found = discover(doc, "example.test");
    assert.ok(found);
    const names = found.rule[found.name].methods.map(m => m.name);
    assert.ok(names.includes("OPEN_OPTIONS"), names.join());
    assert.ok(validate(found.rule), JSON.stringify(validate.errors));
    assertRuleResolves(doc, found.rule);
});

test("non-banner page -> nothing discovered", () => {
    const doc = load(`<div class="card"><p>Subscribe to our newsletter for updates.</p><button>Subscribe</button></div>`);
    assert.equal(discover(doc, "example.test"), null);
});

test("'Accept only necessary' is classified as reject, not accept", () => {
    const doc = load(`<div id="c"><button>Accept only necessary</button><button>Accept all cookies</button></div>`);
    const b = classifyButtons(doc.getElementById("c"));
    assert.equal(b.rejectAll.length, 1);
    assert.equal(b.acceptAll.length, 1);
});

test("'Cookie settings' is an options button, 'Save settings' is save", () => {
    const doc = load(`<div id="c"><button>Cookie settings</button><button>Save settings</button><button>Accept and save</button></div>`);
    const b = classifyButtons(doc.getElementById("c"));
    assert.deepEqual(b.manage.map(x => x.text), ["Cookie settings"]);
    assert.deepEqual(b.save.map(x => x.text), ["Save settings"]);
    assert.deepEqual(b.acceptAll.map(x => x.text), ["Accept and save"]);
});

// Each button is the first (and only) <button> inside its own wrapper, so a leaf :nth-of-type(1) matches both.
const YOUTUBE_LIKE = `
<div id="dialog" style="position:fixed;z-index:999">
  <p>Before you continue, we use cookies and data to deliver and maintain our services.</p>
  <div class="eom-buttons"><div class="eom-button-row">
    <ytd-button-renderer class="r"><yt-button-shape><button class="filled">Reject all</button></yt-button-shape></ytd-button-renderer>
    <ytd-button-renderer class="r"><yt-button-shape><button class="filled">Accept all</button></yt-button-shape></ytd-button-renderer>
  </div></div>
</div>`;

test("accept and reject get different selectors, each resolving to its own button", () => {
    const doc = load(YOUTUBE_LIKE);
    const found = discover(doc, "video.test");
    assert.ok(found);
    const action = found.rule[found.name].methods.find(m => m.name === "SAVE_CONSENT").action.actions[0];
    const parent = doc.querySelector(action.trueAction.parent.selector);
    const pick = (a) => parent.querySelectorAll(a.target.selector);
    assert.notEqual(action.trueAction.target.selector, action.falseAction.target.selector);
    assert.equal(pick(action.trueAction).length, 1);
    assert.equal(pick(action.falseAction).length, 1);
    assert.equal(pick(action.trueAction)[0].textContent, "Accept all");
    assert.equal(pick(action.falseAction)[0].textContent, "Reject all");
});

test("a generic banner selector (#dialog) is narrowed with a text filter", () => {
    const doc = load(YOUTUBE_LIKE);
    const found = discover(doc, "video.test");
    const det = found.rule[found.name].detectors[0];
    const css = det.presentMatcher.find(m => m.type === "css");
    assert.equal(css.target.selector, "#dialog");
    assert.equal(css.target.textFilter, "cookies");
    assert.equal(det.showingMatcher[0].target.textFilter, "cookies");
    assert.ok(validate(found.rule), JSON.stringify(validate.errors));
});

const MORE_OPTIONS = `
<div id="dialog" style="position:fixed;z-index:999">
  <p>We use cookies and data to deliver our services.</p>
  <button class="r">Reject all</button><button class="a">Accept all</button><button class="m">More options</button>
</div>`;

const PANEL = `
  <div class="panel">
    <h2>Cookie choices</h2>
    <label><input type="checkbox" id="x1"> Analytics and statistics</label>
    <label><input type="checkbox" id="x2"> Personalised advertising</label>
    <button class="s">Confirm choices</button>
  </div>`;

test("banner with 'More options' and no toggles asks to open it", () => {
    const doc = load(MORE_OPTIONS);
    const found = discover(doc, "video.test");
    assert.equal(found.needsOptions, true);
    assert.equal(found.manageEl.textContent, "More options");
});

test("exploreOptions opens the control and builds OPEN_OPTIONS + DO_CONSENT + SAVE_CONSENT", async () => {
    const doc = load(MORE_OPTIONS);
    const found = discover(doc, "video.test");
    found.manageEl.addEventListener("click", () => doc.querySelector("#dialog").insertAdjacentHTML("beforeend", PANEL));
    const opened = await exploreOptions(found, doc, "video.test", { timeout: 800, interval: 20 });
    assert.ok(opened, "options read");
    const methods = opened.rule[opened.name].methods;
    assert.deepEqual(methods.map(m => m.name).sort(), ["DO_CONSENT", "HIDE_CMP", "OPEN_OPTIONS", "SAVE_CONSENT"]);
    assert.deepEqual(methods.find(m => m.name === "DO_CONSENT").action.consents.map(c => c.type).sort(), ["B", "F"]);
    assert.equal(opened.analysis.manage, "More options");
    assert.ok(validate(opened.rule), JSON.stringify(validate.errors));
    // OPEN_OPTIONS must resolve against the page as it was before the click (button now still present here).
    const open = methods.find(m => m.name === "OPEN_OPTIONS").action;
    assert.equal(doc.querySelector(open.parent.selector).querySelectorAll(open.target.selector)[0].textContent, "More options");
});

test("exploreOptions returns null when nothing readable appears", async () => {
    const doc = load(MORE_OPTIONS);
    const found = discover(doc, "video.test");
    assert.equal(await exploreOptions(found, doc, "video.test", { timeout: 150, interval: 20 }), null);
});

test("openerRule only opens the options, with empty consent and save steps", () => {
    const doc = load(MORE_OPTIONS);
    const found = discover(doc, "video.test");
    const op = openerRule(found);
    assert.deepEqual(op.rule[op.name].methods.map(m => m.name), ["OPEN_OPTIONS", "DO_CONSENT", "SAVE_CONSENT"]);
    assert.ok(validate(op.rule), JSON.stringify(validate.errors));
});

test("bundled custom-rules.json is schema-valid and overrides google_cwiz with a hide step", () => {
    const bundled = JSON.parse(fs.readFileSync(new URL("../Extension/custom-rules.json", import.meta.url)));
    const { $schema, ...rules } = bundled; // the schema itself does not allow its own $schema key
    assert.ok(validate(rules), JSON.stringify(validate.errors));
    const upstream = JSON.parse(fs.readFileSync(new URL("../rules/google_cwiz.json", import.meta.url))).google_cwiz;
    const mine = bundled.google_cwiz;
    const hide = mine.methods.find(m => m.name === "HIDE_CMP");
    assert.equal(hide.action.type, "hide");
    assert.deepEqual(mine.detectors, upstream.detectors, "same detector as upstream");
    const strip = (r) => JSON.stringify(r.methods.filter(m => m.name !== "HIDE_CMP"));
    assert.equal(strip(mine), strip(upstream), "everything except the hide step is identical to upstream");
});

test("generated rules are scoped to the site they were made for", () => {
    const doc = load(BINARY);
    const found = discover(doc, "www.example.co.uk");
    const url = found.rule[found.name].detectors[0].presentMatcher.find(m => m.type === "url");
    assert.ok(url && url.regexp === true, "has a url matcher");
    const re = new RegExp(url.url[0]);
    assert.ok(re.test("https://www.example.co.uk/page?x=1"));
    assert.ok(re.test("https://www.example.co.uk:8443/"));
    assert.ok(!re.test("https://www.example.co.uk.evil.test/"));
    assert.ok(!re.test("https://evil.test/?u=https://www.example.co.uk/"));
    assert.ok(!re.test("https://wwwXexample.co.uk/"), "dots are escaped");
    assert.ok(validate(found.rule), JSON.stringify(validate.errors));
});

test("rule names cannot carry message separators or markup from page class names", () => {
    const doc = load(`<div class="a|b<c>" style="position:fixed"><p>We use cookies for analytics today.</p><button>Accept all</button><button>Reject all</button></div>`);
    const found = discover(doc, "x.test");
    assert.match(found.name, /^auto:x\.test:[A-Za-z0-9_-]+$/);
});

test("taught rule: toggles in a separate panel opened by the manage button are scoped to that panel", () => {
    const doc = load(`
        <div id="cmpbanner" style="position:fixed"><p>We use cookies</p><button id="show">Show purposes</button></div>
        <div id="prefpanel" role="dialog"><label>Ads <input type="checkbox" id="ads"></label>
            <label>Stats <input type="checkbox" id="stats"></label><button id="savebtn">Save choices</button></div>`);
    const q = (s) => doc.querySelector(s);
    const picks = { banner: q("#cmpbanner"), toggles: [], info: new Map() };
    picks.bannerSelector = uniqueSelector(picks.banner);
    picks.manage = q("#show"); picks.info.set(picks.manage, { where: "banner", selector: uniqueSelector(picks.manage, picks.banner) });
    picks.panel = q("#prefpanel"); picks.panelSelector = uniqueSelector(picks.panel);
    for (const id of ["#ads", "#stats"]) {
        picks.info.set(q(id), { where: "panel", selector: uniqueSelector(q(id), picks.panel) });
        picks.toggles.push({ el: q(id), type: id === "#ads" ? "F" : "B" });
    }
    picks.save = q("#savebtn"); picks.info.set(picks.save, { where: "panel", selector: uniqueSelector(picks.save, picks.panel) });
    const out = generateRuleFromPicks(picks, "shop.test");
    const methods = out.rule[out.name].methods;
    assert.ok(validate(out.rule), JSON.stringify(validate.errors));
    const open = methods.find(m => m.name === "OPEN_OPTIONS").action;
    assert.equal(open.actions[0].parent.selector, "#cmpbanner");
    assert.deepEqual(open.actions[1], { type: "waitcss", parent: { selector: "#prefpanel" }, target: { selector: "#ads" }, retries: 20, waitTime: 150 });
    const consent = methods.find(m => m.name === "DO_CONSENT").action.consents[0];
    assert.equal(consent.toggleAction.parent.selector, "#prefpanel");
    assert.equal(methods.find(m => m.name === "SAVE_CONSENT").action.parent.selector, "#prefpanel");
    assert.deepEqual(methods.find(m => m.name === "HIDE_CMP").action.actions.map(a => a.target.selector), ["#cmpbanner", "#prefpanel"]);
    // Selectors were recorded up front, so the rule still resolves once the banner has been removed by the page.
    q("#cmpbanner").remove();
    const rule = JSON.parse(JSON.stringify(out.rule));
    assertRuleResolves(doc, { ...rule, [out.name]: { methods: rule[out.name].methods.filter(m => m.name !== "OPEN_OPTIONS" && m.name !== "HIDE_CMP") } });
});

test("categoryFor guesses from the label, then from the description beside the toggle", () => {
    const doc = load(`
        <ul>
          <li><label><input type="checkbox" id="a"> Remember my settings</label></li>
          <li><label><input type="checkbox" id="b"> Personalised advertising</label></li>
          <li><label><input type="checkbox" id="c"> Performance cookies</label></li>
          <li><input type="checkbox" id="d" aria-label="Group 4"><p>Measures how visitors use the site, with analytics and statistics.</p></li>
          <li><input type="checkbox" id="e" aria-label="Group 5"><p>Nothing helpful here.</p></li>
        </ul>`);
    const got = ["a", "b", "c", "d", "e"].map(id => categoryFor(doc.getElementById(id)));
    assert.deepEqual(got, ["A", "F", "B", "B", "X"]);
});

test("taught toggles with no type set are categorised from their text; an explicit type is kept", () => {
    const doc = load(`<div id="b" style="position:fixed"><p>Cookies</p>
        <label><input type="checkbox" id="x1"> Personalised advertising</label>
        <label><input type="checkbox" id="x2"> Analytics</label></div>`);
    const out = generateRuleFromPicks({ banner: doc.getElementById("b"), toggles: [
        { el: doc.getElementById("x1"), type: "X" }, { el: doc.getElementById("x2"), type: "E" }] }, "shop.test");
    assert.deepEqual(out.analysis.toggles.map(t => t.type), ["F", "E"]);
    assert.deepEqual(out.rule[out.name].methods.find(m => m.name === "DO_CONSENT").action.consents.map(c => c.type), ["F", "E"]);
});

test("containerOf finds a non-fixed panel without selecting the whole page", () => {
    const doc = load(`<div id="wrap"><section id="panel"><h2>Your choices</h2>
        <label><input type="checkbox" id="t1"> Experience cookies</label><button id="sv">Confirm</button></section></div>`);
    assert.equal(containerOf(doc.getElementById("t1")).id, "wrap");
    const fixed = load(`<div id="f" style="position:fixed"><div><button id="b1">Go</button></div></div>`);
    assert.equal(containerOf(fixed.getElementById("b1")).id, "f");
});

test("taught rule replays expanded sections and waits for the last nested toggle", () => {
    const doc = load(`<div id="cmp" style="position:fixed"><button id="show">Show purposes</button>
        <section id="grp"><button id="plus" aria-expanded="false">+</button><label>Experience <input type="checkbox" id="g1"></label>
        <div><label>Store and/or access information on a device <input type="checkbox" id="n1"></label></div></section>
        <button id="sv">Confirm my choices</button></div>`);
    const q = (x) => doc.querySelector(x), cmp = q("#cmp");
    const info = new Map(); const rec = (el) => info.set(el, { where: "banner", selector: uniqueSelector(el, cmp) });
    ["#show", "#plus", "#g1", "#n1", "#sv"].forEach(x => rec(q(x)));
    const out = generateRuleFromPicks({ banner: cmp, bannerSelector: "#cmp", info, manage: q("#show"), reveals: [{ el: q("#plus") }],
        toggles: [{ el: q("#g1"), type: "X" }, { el: q("#n1"), type: "X" }], save: q("#sv") }, "shop.test");
    assert.ok(validate(out.rule), JSON.stringify(validate.errors));
    const open = out.rule[out.name].methods.find(m => m.name === "OPEN_OPTIONS").action.actions;
    assert.deepEqual(open.map(a => a.type), ["click", "waitcss", "click", "waitcss"]);
    assert.equal(open[2].target.selector, "#plus");
    assert.equal(open[3].target.selector, "#n1");
    assert.deepEqual(out.analysis.toggles.map(t => t.type), ["X", "D"]);
});

test("revealed toggles take their group's category and get a readable label", () => {
    const doc = load(`<div id="cmp" style="position:fixed">
        <section><label>Personalised advertising <input type="checkbox" id="g1"></label>
            <div><div><span>Store and/or access information on a device</span> <input type="checkbox" id="n1" aria-label="Switch Label"></div>
                 <div><span>Measure ad performance</span> <input type="checkbox" id="n2" aria-label="Switch Label"></div></div></section>
        <section><label>Experience cookies <input type="checkbox" id="g2"></label>
            <div><div><span>Create profiles for personalised content</span> <input type="checkbox" id="n3" aria-label="Switch Label"></div></div></section></div>`);
    const q = (x) => doc.querySelector(x);
    const t = (id, child = false) => ({ el: q(id), type: "X", child });
    // Picked out of order on purpose: grouping follows page order, not pick order.
    const toggles = [t("#n3", true), t("#g1"), t("#n1", true), t("#g2"), t("#n2", true)];
    const out = generateRuleFromPicks({ banner: q("#cmp"), toggles }, "shop.test");
    const byId = Object.fromEntries(out.analysis.toggles.map((x, i) => [toggles[i].el.id, x]));
    assert.equal(byId.g1.type, "F");
    assert.equal(byId.n1.type, "F");
    assert.equal(byId.n2.type, "F");
    assert.equal(byId.g2.type, "X");
    assert.equal(byId.n3.type, "X");
    assert.equal(out.analysis.toggles[toggles.findIndex(x => x.el.id === "n1")].parent, toggles.findIndex(x => x.el.id === "g1"));
    assert.equal(displayLabel(q("#n1")), "Store and/or access information on a device");
});

test("a vendor list button is not treated as a 'more options' control", () => {
    const doc = load(`<div id="b" role="dialog" style="position:fixed"><p>We use cookies and similar technologies</p>
        <button>Accept all</button><button>Reject all</button><button>List of vendors</button></div>`);
    const found = discover(doc, "shop.test");
    assert.ok(found);
    assert.equal(found.needsOptions, undefined);
    assert.equal(found.analysis.manage, undefined);
});

test("OneTrust-style accordion: real names from aria-label, group category from the controlled description", () => {
    const doc = load(`<div class="item"><button aria-expanded="false" aria-controls="d1" aria-labelledby="h1"></button>
        <div class="hdr"><h4 id="h1">Experience cookies</h4><div class="tgl"><input type="checkbox" id="g1" aria-labelledby="h1">
            <label for="g1"><span>Experience cookies</span></label></div></div>
        <div class="grp"><p id="d1">These cookies allow us to count visits and traffic sources so we can measure the performance of our site.</p>
          <ul><li><h5>Store and/or access information on a device</h5><div class="tgl"><input type="checkbox" id="s1" aria-label="Store and/or access information on a device">
            <label for="s1"><span>Switch Label</span></label></div></li></ul></div></div>`);
    assert.equal(categoryFor(doc.getElementById("g1")), "B");
    assert.equal(displayLabel(doc.getElementById("s1")), "Store and/or access information on a device");
    assert.equal(categoryFor(doc.getElementById("s1")), "D");
});
