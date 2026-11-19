import ConsentEngine from "./ConsentEngine.js";
import CMP from "./CMP.js";
import Tools from "./Tools.js";
import { discover, exploreOptions, openerRule } from "./Discovery.js";
import { showReview, teachMode } from "./DiscoveryUI.js";

let started = false;

const DISMISS_KEY = "discoveryDismissed";
const DISMISS_MS = 7 * 24 * 3600 * 1000;

// A "Not now" lasts a week, but a new extension version starts fresh so a fix is not hidden behind an old dismissal.
function getDismissed() {
    const version = chrome.runtime.getManifest().version;
    return new Promise((resolve) => chrome.storage.local.get({ [DISMISS_KEY]: {}, discoveryDismissedFor: version }, (r) => {
        if (r.discoveryDismissedFor !== version) {
            chrome.storage.local.set({ [DISMISS_KEY]: {}, discoveryDismissedFor: version }, () => resolve({}));
        } else resolve(r[DISMISS_KEY]);
    }));
}

async function forgetDismissal(host) {
    const d = await getDismissed();
    if (d[host]) { delete d[host]; await new Promise((resolve) => chrome.storage.local.set({ [DISMISS_KEY]: d }, resolve)); }
}

async function dismissHost(host) {
    const d = await getDismissed();
    d[host] = Date.now();
    await new Promise((resolve) => chrome.storage.local.set({ [DISMISS_KEY]: d }, resolve));
}

/** Every {parent,target} selector pair in a rule must resolve on the live page. */
function collectTargets(node, out = []) {
    if (Array.isArray(node)) node.forEach((n) => collectTargets(n, out));
    else if (node && typeof node === "object") {
        if (node.target && node.target.selector) out.push({ parent: node.parent, target: node.target });
        Object.values(node).forEach((v) => collectTargets(v, out));
    }
    return out;
}

/** Any if-allow-all action whose two branches click the same element is a broken rule. */
function sameButtonBranches(node) {
    if (Array.isArray(node)) { for (const n of node) { const r = sameButtonBranches(n); if (r) return r; } return null; }
    if (!node || typeof node !== "object") return null;
    if (node.trueAction && node.falseAction && node.trueAction.target && node.falseAction.target) {
        const a = Tools.find(node.trueAction).target, b = Tools.find(node.falseAction).target;
        if (a && b && a === b) return node.trueAction.target.selector;
    }
    for (const v of Object.values(node)) { const r = sameButtonBranches(v); if (r) return r; }
    return null;
}

/** Non-destructive check: instantiate the rule with the real engine classes, never click. */
export function dryRun(rule) {
    const name = Object.keys(rule)[0];
    try {
        const cmp = new CMP(name, rule[name]);
        if (!cmp.detect()) return { ok: false, detail: "Detector does not match the banner" };
        if (!cmp.isShowing()) return { ok: false, detail: "Banner is not showing" };
        for (const { parent, target } of collectTargets(rule[name].methods)) {
            const r = Tools.find({ parent, target });
            if (r.target == null) return { ok: false, detail: "Could not resolve " + target.selector };
        }
        const same = sameButtonBranches(rule[name].methods);
        if (same) return { ok: false, detail: "Accept and reject resolve to the same element (" + same + ")" };
        return { ok: true, detail: "All selectors resolved" };
    } catch (e) {
        return { ok: false, detail: String(e) };
    }
}

function applyTypes(result, types) {
    const name = result.name;
    const method = result.rule[name].methods.find((m) => m.name === "DO_CONSENT");
    if (method && method.action.type === "consent" && types) {
        method.action.consents.forEach((c, i) => { if (types[i]) c.type = types[i]; });
    }
}

const PENDING_KEY = "discoveryPending";
const PENDING_MS = 2 * 60 * 1000;

async function setPending(p) {
    await new Promise((resolve) => chrome.storage.local.set({ [PENDING_KEY]: p }, resolve));
}
async function takePending() {
    const r = await new Promise((resolve) => chrome.storage.local.get({ [PENDING_KEY]: null }, resolve));
    await new Promise((resolve) => chrome.storage.local.remove(PENDING_KEY, resolve));
    const p = r[PENDING_KEY];
    if (!p || Date.now() - p.ts >= PENDING_MS) return null;
    // Only when we arrived from the page that opened it: another tab must not pick up this opener rule.
    try { if (new URL(document.referrer).origin !== p.fromOrigin) return null; } catch (e) { return null; }
    return p;
}

async function waitForCandidate(tries = 12, interval = 750) {
    for (let i = 0; i < tries; i++) {
        if (document.body) {
            const found = discover(document, location.hostname);
            if (found) return found;
        }
        await new Promise((r) => setTimeout(r, interval));
    }
    return null;
}

async function reviewAndSave(ctx, result, dry) {
    const { host, consentTypes, onHandled } = ctx;
    for (;;) {
        const decision = await showReview(result, dry);
        if (decision.action === "dismiss") { await dismissHost(host); return; }
        if (decision.action === "teach") {
            const taught = await teachMode(host);
            if (!taught) continue;
            result = taught; dry = taught.dryRun || dryRun(result.rule);
            continue;
        }
        applyTypes(result, decision.types);
        break;
    }

    await chrome.runtime.sendMessage("AddCustomRule|" + JSON.stringify(result.rule));
    if (result.openerRule) await chrome.runtime.sendMessage("AddCustomRule|" + JSON.stringify(result.openerRule));

    started = true; // the page is now mid-way through the new rule: do not discover again on what is left of it
    if (result.reloadAfterSave) { location.reload(); return; }

    // Run it straight away so the user sees it work rather than reloading.
    ConsentEngine.singleton = new ConsentEngine(result.rule, consentTypes, onHandled);
}

/** Manual teach mode, started from the popup. */
export async function startTeach(ctx) {
    await forgetDismissal(ctx.host);
    const result = await teachMode(ctx.host);
    if (!result) return;
    await reviewAndSave(ctx, result, result.dryRun || dryRun(result.rule));
}

/** Automatic discovery after the engine found nothing. Stays silent when the page has no banner. */
export async function runDiscovery(ctx) {
    const { host, generalSettings } = ctx;
    if (started) return;
    if (generalSettings && generalSettings.discoveryEnabled === false) { console.info("Consent-O-Matic discovery: switched off in settings"); return; }

    const dismissed = (await getDismissed())[host];
    if (dismissed && Date.now() - dismissed < DISMISS_MS) {
        console.info("Consent-O-Matic discovery: you dismissed " + host + " " + Math.round((Date.now() - dismissed) / 3600000) + "h ago; staying quiet until " + new Date(dismissed + DISMISS_MS).toLocaleString());
        return;
    }

    started = true;
    console.info("Consent-O-Matic discovery: started on " + host + (ctx.engineSawCMP ? " (a known rule ran first)" : ""));
    // A known rule ran first: give it time to clear its banner, then look for one that is still showing.
    if (ctx.engineSawCMP) await new Promise((r) => setTimeout(r, 4000));
    let result = await waitForCandidate();
    if (!result) { console.info("Consent-O-Matic discovery: no banner showing, nothing to do"); return; } // say nothing on the page
    console.info("Consent-O-Matic discovery: banner found" + (result.needsOptions ? " with a more-options control" : ""));

    // Came here from a "more options" link on another page: save that page's opener rule together with this one.
    const pending = await takePending();
    if (pending && !result.needsOptions && result.rule[result.name].methods.some((m) => m.name === "DO_CONSENT" && m.action && m.action.type === "consent")) {
        result.openerRule = pending.openerRule;
    }

    if (result.needsOptions) {
        const choice = await showChoicePrompt("This banner has more options",
            "It has a “" + result.analysis.manage + "” control. Open it so I can set your preferences there instead of just accepting or rejecting?",
            [["open", "Open it", true], ["binary", "Just accept/reject", false], ["no", "Not now", false]]);
        if (choice === "no") { await dismissHost(host); return; }
        if (choice === "open") {
            const opener = openerRule(result);
            await setPending({ ts: Date.now(), fromOrigin: location.origin, openerRule: opener.rule }); // survives if the control navigates to another page
            const opened = await exploreOptions(result);
            await new Promise((resolve) => chrome.storage.local.remove(PENDING_KEY, resolve));
            if (opened) {
                opened.reloadAfterSave = true;
                await reviewAndSave(ctx, opened, { ok: true, detail: "Opened the options and read " + opened.analysis.toggles.length + " choices" });
                return;
            }
            // Nothing appeared in place: either it navigated (pending was kept for the next page) or it opens nothing readable.
            const choice2 = await showChoicePrompt("Couldn’t read the options",
                "Nothing I can read appeared. Show me which buttons to use?", [["teach", "Teach it", true], ["no", "Not now", false]]);
            if (choice2 !== "teach") { await dismissHost(host); return; }
            const taught = await teachMode(host);
            if (taught) await reviewAndSave(ctx, taught, taught.dryRun || dryRun(taught.rule));
            return;
        }
    }

    let dry = dryRun(result.rule);
    if (!dry.ok) {
        // Found a banner, but the generated rule does not hold up: fall back to teach mode.
        const choice = await showFallbackPrompt(false);
        if (choice !== "teach") { await dismissHost(host); return; }
        result = await teachMode(host);
        if (!result) return;
        dry = dryRun(result.rule);
    }

    await reviewAndSave(ctx, result, dry);
}

// Small prompt card. buttons = [[id, label, primary]]; resolves with the chosen id.
function showChoicePrompt(title, text, buttons) {
    return new Promise((resolve) => {
        const host = document.createElement("div");
        host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;";
        const shadow = host.attachShadow({ mode: "closed" });
        const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
        shadow.innerHTML = `
          <style>
            *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
            .card{width:320px;padding:14px 16px;border-radius:16px;background:#fff;color:#1b1f27;font-size:13px;line-height:1.45;
                  box-shadow:0 12px 40px rgba(16,24,40,.28),0 0 0 1px rgba(16,24,40,.08)}
            @media (prefers-color-scheme:dark){.card{background:#1d2129;color:#e8ebf2}button.ghost{background:#272c37;color:#e8ebf2;border-color:#394052}}
            h1{font-size:14px;margin:0 0 4px}p{margin:0 0 12px;color:#667085}
            button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:8px 12px;cursor:pointer;background:#4f46e5;color:#fff;margin:0 8px 6px 0}
            button.ghost{background:#fff;color:#344054;border:1px solid #d0d5dd}
            button:focus-visible{outline:3px solid #9db4ff;outline-offset:2px}
          </style>
          <div class="card" role="dialog" aria-label="Consent-O-Matic">
            <h1>${esc(title)}</h1>
            <p>${esc(text)}</p>
            ${buttons.map(([id, label, primary]) => `<button data-id="${esc(id)}" class="${primary ? "" : "ghost"}">${esc(label)}</button>`).join("")}
          </div>`;
        document.documentElement.appendChild(host);
        const finish = (v) => { host.remove(); resolve(v); };
        shadow.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => finish(b.dataset.id)));
        shadow.querySelector("button").focus();
    });
}

function showFallbackPrompt(nothingFound) {
    return showChoicePrompt("Cookie banner not recognised",
        (nothingFound ? "I couldn’t find a banner I understand." : "I found a banner but couldn’t verify a rule for it.") + " Show me which buttons to use?",
        [["teach", "Teach it", true], ["no", "Not now", false]]);
}
