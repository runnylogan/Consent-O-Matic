import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import Ajv from "ajv";

// Minimal CSS.escape (jsdom lacks it; real browsers have it).
globalThis.CSS = { escape: (s) => String(s).replace(/([^a-zA-Z0-9_\u00A0-\uFFFF-])/g, "\\$1").replace(/^(\d)/, "\\3$1 ") };

const { discover, classifyButtons, classifyToggles } = await import("../Extension/Discovery.js");
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
