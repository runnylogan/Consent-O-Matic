// Heuristic discovery of cookie banners that no rule covers.
//
// Pure DOM analysis, no network access. Produces a rule in the same JSON format the
// engine already consumes, so a generated rule can be dry-run through CMP/Detector
// and then stored with the other custom rules.

const BANNER_WORDS = /\b(cookie|cookies|consent|gdpr|privacy|tracking|ccpa|cmp)\b/i;
const BUTTON_SELECTOR = "button, [role='button'], a[href], input[type='button'], input[type='submit'], summary";
const TOGGLE_SELECTOR = "input[type='checkbox'], input[type='radio'], [role='switch'], [role='checkbox']";

const VENDOR_LIST = /\b(vendors?|partners?|suppliers?|third[- ]parties|companies)\b/i;

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
 * Is this element inside a section the page has closed: display:none or visibility:hidden somewhere above it,
 * hidden/aria-hidden/inert, or a clipped box squeezed to nothing (a height:0 accordion)? Layout is only used for that
 * last case, and only when the window itself has size, so it also works from a background pane.
 */
function inClosedSection(el) {
    const view = el.ownerDocument.defaultView;
    const sized = view.innerHeight > 50;
    for (let n = el; n && n.nodeType === 1 && n !== el.ownerDocument.documentElement; n = n.parentElement) {
        const cs = view.getComputedStyle(n);
        if (cs.display === "none" || cs.visibility === "hidden") return true;
        if (n.getAttribute("aria-hidden") === "true" || n.hasAttribute("inert") || n.hidden) return true;
        // A scrollable list is not collapsed: rows below its fold are still part of the open panel, so position never counts.
        if (sized && n !== el && /hidden|clip/.test(cs.overflowY + cs.overflowX) && n.getBoundingClientRect().height < 2) return true;
    }
    return false;
}

/** A toggle counts as showing unless it sits in a closed section. Switch inputs are often invisible, so their own size is ignored. */
export function toggleShown(input) {
    return !inClosedSection(input);
}

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
    const candidates = [];
    if (el.id) {
        const l = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) candidates.push(cleanText(l));
    }
    if (el.closest("label")) candidates.push(cleanText(el.closest("label")));
    if (el.getAttribute("aria-label")) candidates.push(el.getAttribute("aria-label").trim());
    if (el.getAttribute("aria-labelledby")) {
        candidates.push(el.getAttribute("aria-labelledby").split(/\s+/)
            .map(id => doc.getElementById(id)).filter(Boolean).map(cleanText).join(" "));
    }
    if (el.getAttribute("name")) candidates.push(el.getAttribute("name"));
    // First label that actually says something: a styled switch often carries a placeholder like "Switch Label"
    // while the real name sits in aria-label.
    let text = candidates.find(c => c && !GENERIC_LABEL.test(c.trim())) || candidates.find(Boolean) || "";
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
    // The engine matches against the page's host alone (no scheme), so the scheme part has to be optional.
    return { type: "url", regexp: true, url: ["^(?:[a-z-]+://)?" + escapeRegExp(hostname) + "(:\\d+)?([/?#]|$)"] };
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

export function findBannerCandidates(doc = document, { maxText = 6000 } = {}) {
    const candidates = [];
    const seen = new Set();

    const roots = doc.querySelectorAll(
        "dialog, [role='dialog'], [role='alertdialog'], [aria-modal='true'], " +
        "[id*='cookie' i], [class*='cookie' i], [id*='consent' i], [class*='consent' i], " +
        "[id*='gdpr' i], [class*='gdpr' i], [id*='privacy' i], [class*='privacy' i], [id*='cmp' i], [class*='cmp' i], " +
        "body > div, body > section, body > aside"
    );

    // Banners with unremarkable ids and classes (OneTrust's own wrapper, say): reach them through their accept/reject buttons.
    const found = new Set(roots);
    for (const b of doc.querySelectorAll(BUTTON_SELECTOR)) {
        const t = cleanText(b);
        if (!t || t.length > 40 || !(TEXT.rejectAll.test(t) || TEXT.acceptAll.test(t)) || !visible(b)) continue;
        const c = containerOf(b);
        if (c && c !== doc.body) found.add(c);
    }

    for (const el of found) {
        if (seen.has(el) || !visible(el)) continue;
        seen.add(el);
        const text = cleanText(el);
        if (text.length < 20 || text.length > maxText) continue;

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

const GENERIC_LABEL = /^(switch|toggle|checkbox|slider|button)( label)?$/i;

/** Label to show for a toggle: its own label, or the start of the text beside it when the label says nothing. */
export function displayLabel(el) {
    const label = labelFor(el);
    if (label && !GENERIC_LABEL.test(label.trim())) return label;
    const near = contextFor(el);
    const tidy = near.replace(/^[+\-\u2212\u2013\u25b8\u25be\s]+/, "");
    return tidy ? tidy.slice(0, 60) : label;
}

// A group's own description, when the page links one: aria-describedby on the toggle, or the text an accordion button
// controls. Only for the first toggle of its section (the group's header switch), never for the switches inside it.
function describedText(el) {
    const doc = el.ownerDocument;
    const ids = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    let n = el.parentElement;
    for (let depth = 0; depth < 6 && n && n !== doc.body; depth++, n = n.parentElement) {
        if (n.querySelector(TOGGLE_SELECTOR) !== el) break;
        for (const b of n.querySelectorAll("[aria-controls]")) ids.push(...b.getAttribute("aria-controls").split(/\s+/));
    }
    return ids.map(id => doc.getElementById(id)).filter(Boolean).map(cleanText).join(" ");
}

/** Best-guess consent type (A,B,D,E,F or X) from a toggle's label, then from the description beside it. */
export function categoryFor(el, label = labelFor(el)) {
    for (const [t, re] of CATEGORY_RULES) if (re.test(label)) return t;
    const context = contextFor(el) + " " + describedText(el);
    let best = "X", top = 0;
    for (const [t, re] of CATEGORY_RULES) {
        const hits = (context.match(new RegExp(re.source, "gi")) || []).length;
        if (hits > top) { top = hits; best = t; }
    }
    return best;
}

// Switches inside a vendor/partner list (one per company, or "select all vendors") are a separate screen, not the choices.
const VENDOR_TOKEN = /(^|[^a-z])(vendors?|hosts?|partners?|vlst)([^a-z]|$)/i;
function inVendorList(el, root) {
    for (let n = el; n && n !== root && n.nodeType === 1; n = n.parentElement) {
        if (VENDOR_TOKEN.test(n.id + " " + (n.getAttribute("class") || ""))) return true;
    }
    return VENDOR_TOKEN.test(el.id || "");
}

export function classifyToggles(root) {
    const toggles = [];
    for (const el of root.querySelectorAll(TOGGLE_SELECTOR)) {
        if (inVendorList(el, root)) continue;
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
    // A vendor or partner list is a separate screen of per-company switches, not the purposes the user chooses between.
    const manage = first(buttons.manage.filter(b => !VENDOR_LIST.test(b.text)));

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

/**
 * Toggles revealed by expanding a group take the category of the group's own toggle: the nearest earlier toggle
 * on the page that was not itself revealed. Returns Map(child toggle -> parent toggle).
 */
function parentToggles(toggles) {
    const inOrder = toggles.slice().sort((a, b) =>
        a.el.compareDocumentPosition(b.el) & 4 /* b follows a */ ? -1 : 1);
    const parents = new Map();
    let header = null;
    for (const t of inOrder) {
        if (t.child && header) parents.set(t, header);
        else if (!t.child) header = t;
    }
    return parents;
}

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
    const toggleList = picks.toggles || [];
    const parentOf = parentToggles(toggleList);
    const typeOf = (t) => parentOf.has(t) ? pickType(parentOf.get(t)) : pickType(t);
    // Teach mode snapshots the target while the banner is on screen; its text may differ once the options are open.
    const bannerTargetFor = (extra = {}) => picks.bannerTargetBase
        ? { ...picks.bannerTargetBase, ...extra } : bannerTarget(banner, bannerSelector, extra);
    const methods = [];

    const reveals = picks.reveals || [];
    if (picks.manage || reveals.length) {
        // Open the options, wait for the first toggle, replay any sections the user expanded, then wait for the last toggle.
        const toggles = picks.toggles || [];
        const wait = (t) => ({ type: "waitcss", ...act(t.el), retries: 20, waitTime: 150 });
        const steps = [];
        if (picks.manage) steps.push(click(picks.manage));
        if (toggles.length) steps.push(wait(toggles[0]));
        reveals.forEach(r => steps.push(click(r.el)));
        if (reveals.length && toggles.length > 1) steps.push(wait(toggles[toggles.length - 1]));
        methods.push({ name: "OPEN_OPTIONS", action: steps.length === 1 ? steps[0] : { type: "list", actions: steps } });
    }

    if (picks.toggles && picks.toggles.length) {
        methods.push({
            name: "DO_CONSENT",
            action: {
                type: "consent",
                consents: picks.toggles.map(t => ({
                    type: typeOf(t),
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
            toggles: toggleList.map(t => ({
                label: displayLabel(t.el), type: typeOf(t), hidden: false,
                parent: parentOf.has(t) ? toggleList.indexOf(parentOf.get(t)) : undefined
            })),
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
    for (const c of findBannerCandidates(doc, { maxText: 40000 })) if (panelWithToggles(c.el)) return c.el;
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

    // Groups the page keeps closed (an accordion of sub-purposes): open them and read what is inside.
    const expanded = await expandSections(panel, doc, { timeout, interval });
    if (expanded) {
        const built = ruleFromExpanded(result, expanded, panel, hostname);
        if (built) return built;
    }

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

const COLLAPSED = "[aria-expanded='false'], summary";

/** The control that opens the closed section holding this toggle: the nearest collapsed control among its ancestors' descendants. */
function expanderFor(input, panel) {
    for (let n = input.parentElement; n && n !== panel.parentElement; n = n.parentElement) {
        const found = Array.from(n.querySelectorAll(COLLAPSED)).filter(c => !c.contains(input) || c.tagName === "SUMMARY");
        // Prefer a control that names this section through aria-controls.
        const named = found.find(c => { const id = c.getAttribute("aria-controls"); const t = id && n.ownerDocument.getElementById(id); return t && t.contains(input); });
        const pick = named || found.find(c => !c.closest("[aria-hidden='true']") && !inClosedSection(c));
        if (pick) return pick;
    }
    return null;
}

/**
 * Open every closed section of an options panel so its switches can be read. Returns null when nothing was closed,
 * else { toggles: [{el, child}], reveals: [{el, selector}], save } with selectors taken before each click.
 */
export async function expandSections(panel, doc, { timeout = 3000, interval = 150 } = {}) {
    const all = classifyToggles(panel).filter(t => !t.necessary);
    const closed = new Set(all.filter(t => inClosedSection(t.el)).map(t => t.el));
    if (!closed.size) return null;

    const reveals = [];
    const seen = new Set();
    for (const el of closed) {
        const ex = expanderFor(el, panel);
        if (!ex || seen.has(ex)) continue;
        seen.add(ex);
        reveals.push({ el: ex, selector: uniqueSelector(ex, panel) });
    }
    if (!reveals.length) return null;
    for (const r of reveals) r.el.click();

    for (const end = Date.now() + timeout; Date.now() < end;) {
        await sleep(interval);
        if (Array.from(closed).every(el => !inClosedSection(el))) break;
    }
    const buttons = classifyButtons(panel);
    return {
        toggles: all.map(t => ({ el: t.el, type: "X", child: closed.has(t.el), shown: !inClosedSection(t.el) })).filter(t => t.shown || !t.child),
        reveals,
        save: (buttons.save[0] || buttons.rejectAll[0] || buttons.acceptAll[0] || {}).el,
        opened: Array.from(closed).filter(el => !inClosedSection(el)).length
    };
}

/** Build the finished rule from an options panel whose sections were expanded, reusing the taught-rule builder. */
function ruleFromExpanded(result, expanded, panel, hostname) {
    if (!expanded.opened) return null;
    const banner = result.banner;
    const bannerSelector = result.analysis.bannerSelector;
    const panelSelector = uniqueSelector(panel);
    const scoped = banner.isConnected && (panel === banner || banner.contains(panel)) ? null : panel;
    const info = new Map();
    const note = (el, selector) => info.set(el, { where: scoped ? "panel" : "banner", selector });
    expanded.reveals.forEach(r => note(r.el, r.selector));
    const root = scoped || panel;
    expanded.toggles.forEach(t => note(t.el, uniqueSelector(t.el, root)));
    if (expanded.save) note(expanded.save, uniqueSelector(expanded.save, root));

    const picks = {
        banner, bannerSelector, panel: scoped, panelSelector: scoped ? panelSelector : null, info,
        manage: result.manageEl, toggles: expanded.toggles, reveals: expanded.reveals, save: expanded.save
    };
    if (result.manageEl) info.set(result.manageEl, { where: "banner", selector: uniqueSelector(result.manageEl, banner) });
    const built = generateRuleFromPicks(picks, hostname);
    if (!built) return null;
    // Detect the original banner, not whatever the page swapped it for.
    const first = result.rule[result.name];
    const body = built.rule[built.name];
    body.detectors = first.detectors;
    const name = result.name;
    return {
        name, rule: { [name]: body },
        analysis: { ...built.analysis, manage: result.analysis.manage, confidence: 0.85 },
        banner, panel
    };
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
