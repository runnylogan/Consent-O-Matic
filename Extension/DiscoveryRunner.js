import ConsentEngine from "./ConsentEngine.js";
import CMP from "./CMP.js";
import Tools from "./Tools.js";
import { discover } from "./Discovery.js";
import { showReview, teachMode } from "./DiscoveryUI.js";

let started = false;

const DISMISS_KEY = "discoveryDismissed";
const DISMISS_MS = 7 * 24 * 3600 * 1000;

function getDismissed() {
    return new Promise((resolve) => chrome.storage.local.get({ [DISMISS_KEY]: {} }, (r) => resolve(r[DISMISS_KEY])));
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
            result = taught; dry = dryRun(result.rule);
            continue;
        }
        applyTypes(result, decision.types);
        break;
    }

    await chrome.runtime.sendMessage("AddCustomRule|" + JSON.stringify(result.rule));

    // Run it straight away so the user sees it work rather than reloading.
    ConsentEngine.singleton = new ConsentEngine(result.rule, consentTypes, onHandled);
}

/** Manual teach mode, started from the popup. */
export async function startTeach(ctx) {
    const result = await teachMode(ctx.host);
    if (!result) return;
    await reviewAndSave(ctx, result, dryRun(result.rule));
}

/** Automatic discovery after the engine found nothing. Stays silent when the page has no banner. */
export async function runDiscovery(ctx) {
    const { host, generalSettings } = ctx;
    if (started) return;
    if (generalSettings && generalSettings.discoveryEnabled === false) return;

    const dismissed = (await getDismissed())[host];
    if (dismissed && Date.now() - dismissed < DISMISS_MS) return;

    started = true;
    let result = await waitForCandidate();
    if (!result) return; // no banner on this page: say nothing

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

// Small prompt when heuristics found nothing usable.
function showFallbackPrompt(nothingFound) {
    return new Promise((resolve) => {
        const host = document.createElement("div");
        host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;";
        const shadow = host.attachShadow({ mode: "closed" });
        shadow.innerHTML = `
          <style>
            *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
            .card{width:320px;padding:14px 16px;border-radius:16px;background:#fff;color:#1b1f27;font-size:13px;line-height:1.45;
                  box-shadow:0 12px 40px rgba(16,24,40,.28),0 0 0 1px rgba(16,24,40,.08)}
            @media (prefers-color-scheme:dark){.card{background:#1d2129;color:#e8ebf2}button.ghost{background:#272c37;color:#e8ebf2;border-color:#394052}}
            h1{font-size:14px;margin:0 0 4px}p{margin:0 0 12px;color:#667085}
            button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:8px 12px;cursor:pointer;background:#4f46e5;color:#fff;margin-right:8px}
            button.ghost{background:#fff;color:#344054;border:1px solid #d0d5dd}
            button:focus-visible{outline:3px solid #9db4ff;outline-offset:2px}
          </style>
          <div class="card" role="dialog" aria-label="Consent-O-Matic">
            <h1>Cookie banner not recognised</h1>
            <p>${nothingFound ? "I couldn’t find a banner I understand." : "I found a banner but couldn’t verify a rule for it."} Show me which buttons to use?</p>
            <button id="t">Teach it</button><button id="n" class="ghost">Not now</button>
          </div>`;
        document.documentElement.appendChild(host);
        const finish = (v) => { host.remove(); resolve(v); };
        shadow.getElementById("t").addEventListener("click", () => finish("teach"));
        shadow.getElementById("n").addEventListener("click", () => finish("no"));
        shadow.getElementById("t").focus();
    });
}
