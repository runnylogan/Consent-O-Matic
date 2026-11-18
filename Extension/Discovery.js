// Heuristic discovery of cookie banners that no rule covers.
//
// Pure DOM analysis, no network access. Produces a rule in the same JSON format the
// engine already consumes, so a generated rule can be dry-run through CMP/Detector
// and then stored with the other custom rules.

const BANNER_WORDS = /\b(cookie|cookies|consent|gdpr|privacy|tracking|ccpa|cmp)\b/i;
const BUTTON_SELECTOR = "button, [role='button'], a[href], input[type='button'], input[type='submit'], summary";
const TOGGLE_SELECTOR = "input[type='checkbox'], input[type='radio'], [role='switch'], [role='checkbox']";

const TEXT = {
    acceptAll: /\b(accept|allow|agree|consent to|got it|ok(ay)?|i understand|yes,? i)\b.*\b(all|everything)?\b|\b(accept|agree|allow all|alles akzeptieren|tout accepter|accepter|accetta|aceptar|akzeptieren|zustimmen)\b/i,
    rejectAll: /\b(reject|decline|deny|refuse|disagree|no,? thanks|only (necessary|essential)|necessary only|essential only|continue without|ablehnen|refuser|tout refuser|rifiuta|rechazar|nur (notwendige|erforderliche))\b/i,
    save: /\b(save|confirm|apply|submit|update|speichern|auswahl|enregistrer|confirmer|salva|guardar)\b/i,
    manage: /\b(manage|customi[sz]e|settings|preferences|options|more (info|options)|choices|configure|purposes|einstellungen|paramétrer|personnaliser|impostazioni|configurar|vendors?|partners?)\b/i,
    necessary: /\b(necessary|essential|strictly|required|notwendig|erforderlich|nécessaire|necessari|necesari|technically)\b/i
};

// Order matters for ties. Letters are the engine's consent types.
const CATEGORY_RULES = [
    ["F", /\b(advertis|advert\b|marketing|targeting|targeted|retarget|interest-based|personali[sz]ed ads?|ads?\b|sponsored|werbung|publicité|pubblicit|publicidad)/i],
    ["B", /\b(analytic|statistic|performance|measurement|measure|metrics|usage|how (you|visitors|people) use|traffic|audience|statistik|statistique|analisi|estadístic)/i],
    ["A", /\b(preference|functional|functionality|personali[sz]ation|customi[sz]ation|remember|settings|language|präferenz|préférence|funzional)/i],
    ["E", /\b(content|social media|social|video|embedded|media|recommend|inhalte|contenu)/i],
    ["D", /\b(storage|stor(e|ing)( and\/or access)?|access(ing)? (to )?information|information (on|stored on) (a|your) device|on your device|device information|geolocation|information storage|speicher)/i]
];

/**
 * The banner or panel a click landed in: nearest fixed/sticky/dialog ancestor, else the largest ancestor that is still
 * just a small block of text (so we never select the whole page).
 */
export function containerOf(el) {
    const doc = el.ownerDocument, view = doc.defaultView;
    let small = el;
    for (let n = el; n && n !== doc.body && n !== doc.documentElement; n = n.parentElement) {
        if (/fixed|sticky/.test(view.getComputedStyle(n).position) || n.matches("dialog,[role='dialog'],[aria-modal='true']")) return n;
    }
    for (let n = el.parentElement; n && n !== doc.body && n !== doc.documentElement; n = n.parentElement) {
        if (cleanText(n).length > 1500 || n.querySelector("main,header,nav,footer")) break;
        small = n;
    }
    return small;
}

export function visible(el) {
    if (!el || !el.isConnected) return false;
    const view = el.ownerDocument.defaultView;
    // display:none is not inherited, so check every ancestor (works without layout, e.g. jsdom).
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
        const style = view.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (node === el && style.opacity === "0") return false;
    }
    // Real browsers: zero-size boxes are not visible. jsdom has no layout, so skip there.
    if (view.navigator.userAgent.indexOf("jsdom") === -1 &&
        el.offsetHeight === 0 && el.getClientRects().length === 0) return false;
    return true;
}

function cleanText(el) {
    return (el.textContent || el.value || el.getAttribute("aria-label") || el.title || "")
        .replace(/\s+/g, " ").trim();
}

function labelFor(el) {
    const doc = el.ownerDocument;
    let text = "";
    if (el.id) {
        const l = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) text = cleanText(l);
    }
    if (!text && el.closest("label")) text = cleanText(el.closest("label"));
    if (!text && el.getAttribute("aria-labelledby")) {
        text = el.getAttribute("aria-labelledby").split(/\s+/)
            .map(id => doc.getElementById(id)).filter(Boolean).map(cleanText).join(" ");
    }
    if (!text) text = el.getAttribute("aria-label") || el.getAttribute("name") || "";
    if (!text) {
        // Nearest row-ish container text, trimmed
        const row = el.closest("li, tr, [class*='row'], [class*='item'], [class*='category'], div");
        if (row) text = cleanText(row).slice(0, 120);
    }
    return text;
}

// ---------- Selector generation ----------

const UNSTABLE = /^(css-|sc-|jsx-|_|[a-z]{1,2}[0-9a-f]{5,}|[0-9a-f]{8,}|.*[0-9]{4,}.*)/i;

function stableToken(token) {
    return token && !UNSTABLE.test(token) && token.length < 40;
}

function esc(v) {
    return CSS.escape(v);
}

function simpleSelector(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id && stableToken(el.id)) return `#${esc(el.id)}`;
    for (const attr of ["data-testid", "data-test", "data-cy", "data-action", "data-role", "name"]) {
        const v = el.getAttribute(attr);
        if (v && stableToken(v)) return `${tag}[${attr}="${v.replace(/"/g, '\\"')}"]`;
    }
    const classes = Array.from(el.classList).filter(stableToken).slice(0, 2);
    if (classes.length) return tag + classes.map(c => "." + esc(c)).join("");
    const role = el.getAttribute("role");
    if (role) return `${tag}[role="${role}"]`;
    return tag;
}

// Selector for `el` that is unique inside `root` (or document), preferring short ones.
export function uniqueSelector(el, root = null) {
    const scope = root || el.ownerDocument;
    const matchesOnlyEl = (sel) => {
        try {
            const found = scope.querySelectorAll(sel);
            return found.length === 1 && found[0] === el;
        } catch (e) { return false; }
    };

    let sel = simpleSelector(el);
    if (matchesOnlyEl(sel)) return sel;

    // Walk up adding ancestors until unique.
    const parts = [sel];
    let node = el.parentElement;
    while (node && node !== root && node !== el.ownerDocument.body && parts.length < 5) {
        parts.unshift(simpleSelector(node));
        const candidate = parts.join(" ");
        if (matchesOnlyEl(candidate)) return candidate;
        node = node.parentElement;
    }
    // Fall back to a structural path (nth-of-type at every level): unique by construction.
    const segs = [];
    const docEl = el.ownerDocument.documentElement;
    for (let n = el; n && n.nodeType === 1 && n !== docEl; n = n.parentElement) {
        const tag = n.tagName.toLowerCase();
        const sibs = n.parentElement ? Array.from(n.parentElement.children).filter(c => c.tagName === n.tagName) : [n];
        segs.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(n) + 1})` : tag);
    }
    // Shorten from the top while the selector still matches only this element.
    while (segs.length > 1 && matchesOnlyEl(segs.slice(1).join(" > "))) segs.shift();
    return segs.join(" > ");
}

const GENERIC_SELECTOR = /^(#(dialog|modal|popup|overlay|banner|container|wrapper|content|root|app|main|window)|(div|section|aside|dialog|body|main))$/i;

const escapeRegExp = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Generated rules only apply on the site they were made for: the selectors come from one page and must not fire elsewhere. */
function hostMatcher(hostname) {
    return { type: "url", regexp: true, url: ["^[a-z-]+://" + escapeRegExp(hostname) + "(:\\d+)?([/?#]|$)"] };
}

/** presentMatcher/showingMatcher target for a banner; generic selectors get a text filter so they only match cookie banners. */
export function bannerTarget(banner, selector, extra = {}) {
    const target = { selector, ...extra };
    if (GENERIC_SELECTOR.test(selector)) {
        const word = (cleanText(banner).match(BANNER_WORDS) || [])[0];
        if (word) target.textFilter = word.toLowerCase();
    }
    return target;
}

// ---------- Banner detection ----------

export function findBannerCandidates(doc = document) {
    const candidates = [];
    const seen = new Set();

    const roots = doc.querySelectorAll(
        "dialog, [role='dialog'], [role='alertdialog'], [aria-modal='true'], " +
        "[id*='cookie' i], [class*='cookie' i], [id*='consent' i], [class*='consent' i], " +
        "[id*='gdpr' i], [class*='gdpr' i], [id*='privacy' i], [class*='privacy' i], [id*='cmp' i], [class*='cmp' i], " +
        "body > div, body > section, body > aside"
    );

    for (const el of roots) {
        if (seen.has(el) || !visible(el)) continue;
        seen.add(el);
        const text = cleanText(el);
        if (text.length < 20 || text.length > 6000) continue;

        const style = el.ownerDocument.defaultView.getComputedStyle(el);
        const buttons = el.querySelectorAll(BUTTON_SELECTOR).length;
        if (buttons === 0) continue;

        let score = 0;
        const keywordHits = (text.match(new RegExp(BANNER_WORDS, "gi")) || []).length;
        score += Math.min(keywordHits, 5) * 2;
        if (/fixed|sticky/.test(style.position)) score += 3;
        if (parseInt(style.zIndex, 10) > 100) score += 2;
        if (el.matches("dialog, [role='dialog'], [role='alertdialog'], [aria-modal='true']")) score += 2;
        if (/cookie|consent|gdpr|cmp/i.test(el.id + " " + el.className)) score += 3;
        if (el.querySelector(TOGGLE_SELECTOR)) score += 1;
        // Prefer tighter containers over full-page wrappers.
        score -= Math.min(Math.floor(text.length / 1500), 3);
        // Penalise huge page wrappers
        if (el === el.ownerDocument.body) score -= 10;

        if (keywordHits === 0) continue;
        candidates.push({ el, score, text: text.slice(0, 300) });
    }

    // Drop containers that merely wrap a better-scoring descendant of similar content.
    candidates.sort((a, b) => b.score - a.score);
    return candidates.filter((c, i) =>
        !candidates.slice(0, i).some(better => c.el.contains(better.el) && better.score >= c.score - 1));
}

// ---------- Control classification ----------

export function classifyButtons(root) {
    const out = { acceptAll: [], rejectAll: [], save: [], manage: [], other: [] };
    for (const el of root.querySelectorAll(BUTTON_SELECTOR)) {
        if (!visible(el)) continue;
        const text = cleanText(el);
        if (!text || text.length > 80) continue;

        // Reject first: "Accept only necessary" must not count as accept-all.
        let kind;
        if (TEXT.rejectAll.test(text) || (TEXT.acceptAll.test(text) && TEXT.necessary.test(text))) kind = "rejectAll";
        else if (TEXT.save.test(text) && !TEXT.acceptAll.test(text)) kind = "save"; // before manage: "Save settings"
        else if (TEXT.manage.test(text) && !TEXT.acceptAll.test(text)) kind = "manage";
        else if (TEXT.acceptAll.test(text)) kind = "acceptAll";
        else kind = "other";
        out[kind].push({ el, text });
    }
    return out;
}

// Text around a toggle that belongs only to it (its row or card), used when the label alone says nothing.
function contextFor(el) {
    let best = "";
    for (let n = el.parentElement; n && n !== el.ownerDocument.body; n = n.parentElement) {
        if (n.querySelectorAll(TOGGLE_SELECTOR).length > 1) break;
        const t = cleanText(n);
        if (t.length > 600) break;
        best = t;
    }
    return best;
}

/** Best-guess consent type (A,B,D,E,F or X) from a toggle's label, then from the description next to it. */
export function categoryFor(el, label = labelFor(el)) {
    for (const [t, re] of CATEGORY_RULES) if (re.test(label)) return t;
    const context = contextFor(el);
    let best = "X", top = 0;
    for (const [t, re] of CATEGORY_RULES) {
        const hits = (context.match(new RegExp(re.source, "gi")) || []).length;
        if (hits > top) { top = hits; best = t; }
    }
    return best;
}

export function classifyToggles(root) {
    const toggles = [];
    for (const el of root.querySelectorAll(TOGGLE_SELECTOR)) {
        const label = labelFor(el);
        const disabled = el.disabled || el.getAttribute("aria-disabled") === "true";
        const necessary = disabled || TEXT.necessary.test(label);
        const type = categoryFor(el, label);
        toggles.push({ el, label, type, necessary, hidden: !visible(el) && !visible(el.parentElement) });
    }
    return toggles;
}

// ---------- Rule synthesis ----------

function sel(el, root) {
    return { selector: uniqueSelector(el, root) };
}

export function ruleNameFor(hostname, banner) {
    const clean = (t) => String(t || "").replace(/[^a-z0-9_-]/gi, "");
    const cls = clean(banner.id) || clean(Array.from(banner.classList).find(stableToken)) || "banner";
    return `auto:${hostname}:${cls}`.slice(0, 80);
}

/**
 * Analyse the banner and return { rule, name, analysis } or null if no usable controls.
 */
export function generateRule(banner, hostname) {
    const bannerSelector = uniqueSelector(banner);
    const buttons = classifyButtons(banner);
    const toggles = classifyToggles(banner).filter(t => !t.necessary);

    const first = (list) => list[0];
    const accept = first(buttons.acceptAll);
    const reject = first(buttons.rejectAll);
    const save = first(buttons.save);
    const manage = first(buttons.manage);

    const analysis = {
        bannerSelector,
        accept: accept?.text, reject: reject?.text, save: save?.text, manage: manage?.text,
        toggles: toggles.map(t => ({ label: t.label, type: t.type, hidden: t.hidden })),
        confidence: 0
    };

    // Need at least one way to record a decision.
    if (!accept && !reject && toggles.length === 0) return null;

    const methods = [];
    const parent = { selector: bannerSelector };

    // OPEN_OPTIONS: only when toggles exist but are not yet visible.
    const hiddenToggles = toggles.length > 0 && toggles.every(t => t.hidden);
    if (manage && (hiddenToggles || (toggles.length === 0 && !reject))) {
        methods.push({
            name: "OPEN_OPTIONS",
            action: { type: "click", parent, target: sel(manage.el, banner) }
        });
    }

    const visibleToggles = toggles.filter(t => !t.hidden || hiddenToggles);

    if (visibleToggles.length > 0) {
        // Granular path: one consent per toggle, then save.
        const consents = visibleToggles.map(t => ({
            type: t.type,
            matcher: { type: "checkbox", parent, target: sel(t.el, banner) },
            toggleAction: { type: "click", parent, target: sel(t.el, banner) }
        }));
        methods.push({ name: "DO_CONSENT", action: { type: "consent", consents } });
        analysis.toggles = visibleToggles.map(t => ({ label: t.label, type: t.type, hidden: t.hidden }));

        const saveBtn = save || reject || accept;
        if (saveBtn) {
            methods.push({
                name: "SAVE_CONSENT",
                action: { type: "click", parent, target: sel(saveBtn.el, banner) }
            });
        }
        analysis.confidence = save ? 0.85 : 0.6;
    } else {
        // Binary path: choose accept-all or reject-all depending on the user's settings.
        analysis.toggles = [];
        const actions = [];
        if (accept && reject && uniqueSelector(accept.el, banner) === uniqueSelector(reject.el, banner)) return null;
        if (accept && reject) {
            actions.push({
                type: "ifallowall",
                trueAction: { type: "click", parent, target: sel(accept.el, banner) },
                falseAction: { type: "click", parent, target: sel(reject.el, banner) }
            });
        } else if (reject) {
            actions.push({
                type: "ifallownone",
                trueAction: { type: "click", parent, target: sel(reject.el, banner) }
            });
        } else if (accept) {
            // Only an accept button exists: only press it if the user allows everything.
            actions.push({
                type: "ifallowall",
                trueAction: { type: "click", parent, target: sel(accept.el, banner) }
            });
        }
        methods.push({ name: "SAVE_CONSENT", action: { type: "list", actions } });
        analysis.confidence = accept && reject ? 0.8 : 0.5;
    }

    methods.push({
        name: "HIDE_CMP",
        action: { type: "hide", target: { selector: bannerSelector } }
    });

    const name = ruleNameFor(hostname, banner);
    const rule = {
        [name]: {
            detectors: [{
                presentMatcher: [hostMatcher(hostname), { type: "css", target: bannerTarget(banner, bannerSelector) }],
                showingMatcher: [{ type: "css", target: bannerTarget(banner, bannerSelector, { displayFilter: true }) }]
            }],
            methods
        }
    };

    const result = { name, rule, analysis };
    // A control that opens more options but no visible toggles: the runner should offer to open it and read the choices.
    if (manage && toggles.length === 0) { result.needsOptions = true; result.manageEl = manage.el; }
    return result;
}

/** Discover the best candidate and generate a rule. */
export function discover(doc = document, hostname = location.hostname) {
    const candidates = findBannerCandidates(doc);
    for (const c of candidates) {
        const result = generateRule(c.el, hostname);
        if (result) return { ...result, banner: c.el, score: c.score };
    }
    return null;
}

/**
 * Teach mode: build a rule from elements the user picked by hand.
 * picks = { banner: Element, manage?: Element, toggles?: [{el, type}], save?: Element,
 *           accept?: Element, reject?: Element }
 */
// Taught toggles start as "X" (unset): fill in a guess from their text, but never override a type the caller chose.
const pickType = (t) => (t.type && t.type !== "X") ? t.type : categoryFor(t.el);

export function generateRuleFromPicks(picks, hostname) {
    const banner = picks.banner;
    // Teach mode records selectors while the page is still as the user saw it (opening the options can replace the banner).
    const bannerSelector = picks.bannerSelector || uniqueSelector(banner);
    const panel = picks.panel && picks.panel !== banner && !banner.contains(picks.panel) ? picks.panel : null;
    const panelSelector = panel ? (picks.panelSelector || uniqueSelector(panel)) : null;
    const parents = { banner: { selector: bannerSelector }, panel: panelSelector && { selector: panelSelector } };
    const act = (el) => {
        const known = picks.info && picks.info.get(el);
        const where = known ? known.where : (panel && panel.contains(el) && !banner.contains(el) ? "panel" : "banner");
        const selector = known ? known.selector : uniqueSelector(el, where === "panel" ? panel : banner);
        return { parent: parents[where] || parents.banner, target: { selector } };
    };
    const click = (el) => ({ type: "click", ...act(el) });
    // Teach mode snapshots the target while the banner is on screen; its text may differ once the options are open.
    const bannerTargetFor = (extra = {}) => picks.bannerTargetBase
        ? { ...picks.bannerTargetBase, ...extra } : bannerTarget(banner, bannerSelector, extra);
    const methods = [];

    if (picks.manage) {
        // After opening the options, wait for the first toggle to exist before the consent step runs.
        const firstToggle = picks.toggles && picks.toggles[0];
        methods.push({
            name: "OPEN_OPTIONS",
            action: firstToggle
                ? { type: "list", actions: [click(picks.manage), { type: "waitcss", ...act(firstToggle.el), retries: 20, waitTime: 150 }] }
                : click(picks.manage)
        });
    }

    if (picks.toggles && picks.toggles.length) {
        methods.push({
            name: "DO_CONSENT",
            action: {
                type: "consent",
                consents: picks.toggles.map(t => ({
                    type: pickType(t),
                    matcher: { type: "checkbox", ...act(t.el) },
                    toggleAction: click(t.el)
                }))
            }
        });
        const saveEl = picks.save || picks.reject || picks.accept;
        if (saveEl) methods.push({ name: "SAVE_CONSENT", action: click(saveEl) });
    } else {
        const actions = [];
        if (picks.accept && picks.reject) {
            actions.push({ type: "ifallowall", trueAction: click(picks.accept), falseAction: click(picks.reject) });
        } else if (picks.reject) {
            actions.push({ type: "ifallownone", trueAction: click(picks.reject) });
        } else if (picks.accept) {
            actions.push({ type: "ifallowall", trueAction: click(picks.accept) });
        } else {
            return null;
        }
        methods.push({ name: "SAVE_CONSENT", action: { type: "list", actions } });
    }

    const hides = [{ type: "hide", target: { selector: bannerSelector } }];
    if (panelSelector) hides.push({ type: "hide", target: { selector: panelSelector } });
    methods.push({ name: "HIDE_CMP", action: hides.length === 1 ? hides[0] : { type: "list", actions: hides } });

    const name = ruleNameFor(hostname, banner).replace("auto:", "taught:");
    return {
        taught: true,
        name,
        rule: {
            [name]: {
                detectors: [{
                    presentMatcher: [hostMatcher(hostname), { type: "css", target: bannerTargetFor() }],
                    showingMatcher: [{ type: "css", target: bannerTargetFor({ displayFilter: true }) }]
                }],
                methods
            }
        },
        analysis: {
            bannerSelector,
            accept: picks.accept && cleanText(picks.accept), reject: picks.reject && cleanText(picks.reject),
            save: picks.save && cleanText(picks.save), manage: picks.manage && cleanText(picks.manage),
            toggles: (picks.toggles || []).map(t => ({ label: labelFor(t.el), type: pickType(t), hidden: false })),
            confidence: 1
        },
        banner
    };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function panelWithToggles(root) {
    return classifyToggles(root).some(t => !t.necessary && !t.hidden);
}

/** After clicking "more options": find the container that now shows the toggles. */
export function findOptionsPanel(doc, original) {
    if (original && original.isConnected && visible(original) && panelWithToggles(original)) return original;
    for (const c of findBannerCandidates(doc)) if (panelWithToggles(c.el)) return c.el;
    for (const d of doc.querySelectorAll("dialog, [role='dialog'], [role='alertdialog'], [aria-modal='true']")) {
        if (visible(d) && panelWithToggles(d)) return d;
    }
    return null;
}

/**
 * Click the banner's "more options" control, wait for toggles to appear, and build one rule:
 * detector from the original banner, OPEN_OPTIONS + DO_CONSENT + SAVE_CONSENT from what the opened panel shows.
 * Returns null if nothing usable appears (e.g. the control navigates away, or reveals no toggles).
 */
export async function exploreOptions(result, doc = document, hostname = location.hostname, { timeout = 3000, interval = 150 } = {}) {
    const banner = result.banner;
    const bannerSelector = result.analysis.bannerSelector;
    // Selector must be computed before the click changes the DOM.
    const openAction = { type: "click", parent: { selector: bannerSelector }, target: sel(result.manageEl, banner) };
    const manageText = result.analysis.manage;

    result.manageEl.click();
    let panel = null;
    for (const end = Date.now() + timeout; Date.now() < end && !panel;) {
        await sleep(interval);
        panel = findOptionsPanel(doc, banner);
    }
    if (!panel) return null;

    const opened = generateRule(panel, hostname);
    if (!opened) return null;
    const open = opened.rule[opened.name].methods;
    const consent = open.find(m => m.name === "DO_CONSENT");
    if (!consent || consent.action.type !== "consent") return null;

    const first = result.rule[result.name];
    const hides = [{ type: "hide", target: { selector: bannerSelector } }];
    const panelHide = open.find(m => m.name === "HIDE_CMP");
    if (panelHide && panelHide.action.target.selector !== bannerSelector) hides.push(panelHide.action);

    const methods = [
        { name: "HIDE_CMP", action: hides.length === 1 ? hides[0] : { type: "list", actions: hides } },
        { name: "OPEN_OPTIONS", action: openAction },
        ...open.filter(m => m.name === "DO_CONSENT" || m.name === "SAVE_CONSENT")
    ];
    const rule = { [result.name]: { detectors: first.detectors, methods } };
    const analysis = { ...opened.analysis, manage: manageText, bannerSelector, confidence: Math.min(opened.analysis.confidence, 0.85) };
    return { name: result.name, rule, analysis, banner, panel };
}

/** Rule for the page that "more options" navigates to: this page only opens the options page, nothing else. */
export function openerRule(result) {
    const first = result.rule[result.name];
    const name = result.name + ":open";
    return {
        name,
        rule: { [name]: {
            detectors: first.detectors,
            methods: [
                { name: "OPEN_OPTIONS", action: { type: "click", parent: { selector: result.analysis.bannerSelector }, target: sel(result.manageEl, result.banner) } },
                { name: "DO_CONSENT" },
                { name: "SAVE_CONSENT" }
            ]
        } }
    };
}

export const CONSENT_TYPE_NAMES = {
    A: "Preferences", B: "Performance", D: "Information storage", E: "Content", F: "Advertising", X: "Other"
};
