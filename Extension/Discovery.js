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

// Order matters: first match wins. Letters are the engine's consent types.
const CATEGORY_RULES = [
    ["F", /\b(advertis|marketing|targeting|personali[sz]ed ads?|ads?\b|werbung|publicité|pubblicit|publicidad)/i],
    ["B", /\b(analytic|statistic|performance|measurement|measure|metrics|statistik|statistique|analisi|estadístic)/i],
    ["A", /\b(preference|functional|personali[sz]ation|customi[sz]ation|präferenz|préférence|funzional)/i],
    ["E", /\b(content|social media|social|video|embedded|inhalte|contenu)/i],
    ["D", /\b(storage|access information|device information|geolocation|information storage|speicher)/i]
];

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
    // Fall back to nth-of-type on the leaf.
    const idx = Array.from(el.parentElement?.children || []).filter(c => c.tagName === el.tagName).indexOf(el) + 1;
    return `${parts.slice(0, -1).concat(`${parts[parts.length - 1]}:nth-of-type(${idx})`).join(" ")}`;
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

export function classifyToggles(root) {
    const toggles = [];
    for (const el of root.querySelectorAll(TOGGLE_SELECTOR)) {
        const label = labelFor(el);
        const disabled = el.disabled || el.getAttribute("aria-disabled") === "true";
        const necessary = disabled || TEXT.necessary.test(label);
        let type = "X";
        for (const [t, re] of CATEGORY_RULES) {
            if (re.test(label)) { type = t; break; }
        }
        toggles.push({ el, label, type, necessary, hidden: !visible(el) && !visible(el.parentElement) });
    }
    return toggles;
}

// ---------- Rule synthesis ----------

function sel(el, root) {
    return { selector: uniqueSelector(el, root) };
}

function textSel(item, root, bannerSelector) {
    // Prefer structural selector; add a textFilter when selector is ambiguous across siblings.
    const s = { selector: uniqueSelector(item.el, root) };
    return s;
}

function clickAction(item, root, parentSel) {
    const target = textSel(item, root);
    // Selector is relative to the banner root, so use banner as parent.
    return { type: "click", parent: { selector: parentSel }, target };
}

export function ruleNameFor(hostname, banner) {
    const cls = (banner.id || "").replace(/[^a-z0-9-]/gi, "") || Array.from(banner.classList).find(stableToken) || "banner";
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
                presentMatcher: [{ type: "css", target: { selector: bannerSelector } }],
                showingMatcher: [{ type: "css", target: { selector: bannerSelector, displayFilter: true } }]
            }],
            methods
        }
    };

    return { name, rule, analysis };
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
export function generateRuleFromPicks(picks, hostname) {
    const banner = picks.banner;
    const bannerSelector = uniqueSelector(banner);
    const parent = { selector: bannerSelector };
    const methods = [];

    if (picks.manage) {
        methods.push({ name: "OPEN_OPTIONS", action: { type: "click", parent, target: sel(picks.manage, banner) } });
    }

    if (picks.toggles && picks.toggles.length) {
        methods.push({
            name: "DO_CONSENT",
            action: {
                type: "consent",
                consents: picks.toggles.map(t => ({
                    type: t.type || "X",
                    matcher: { type: "checkbox", parent, target: sel(t.el, banner) },
                    toggleAction: { type: "click", parent, target: sel(t.el, banner) }
                }))
            }
        });
        const saveEl = picks.save || picks.reject || picks.accept;
        if (saveEl) methods.push({ name: "SAVE_CONSENT", action: { type: "click", parent, target: sel(saveEl, banner) } });
    } else {
        const actions = [];
        if (picks.accept && picks.reject) {
            actions.push({
                type: "ifallowall",
                trueAction: { type: "click", parent, target: sel(picks.accept, banner) },
                falseAction: { type: "click", parent, target: sel(picks.reject, banner) }
            });
        } else if (picks.reject) {
            actions.push({ type: "ifallownone", trueAction: { type: "click", parent, target: sel(picks.reject, banner) } });
        } else if (picks.accept) {
            actions.push({ type: "ifallowall", trueAction: { type: "click", parent, target: sel(picks.accept, banner) } });
        } else {
            return null;
        }
        methods.push({ name: "SAVE_CONSENT", action: { type: "list", actions } });
    }

    methods.push({ name: "HIDE_CMP", action: { type: "hide", target: { selector: bannerSelector } } });

    const name = ruleNameFor(hostname, banner).replace("auto:", "taught:");
    return {
        name,
        rule: {
            [name]: {
                detectors: [{
                    presentMatcher: [{ type: "css", target: { selector: bannerSelector } }],
                    showingMatcher: [{ type: "css", target: { selector: bannerSelector, displayFilter: true } }]
                }],
                methods
            }
        },
        analysis: {
            bannerSelector,
            accept: picks.accept && cleanText(picks.accept), reject: picks.reject && cleanText(picks.reject),
            save: picks.save && cleanText(picks.save), manage: picks.manage && cleanText(picks.manage),
            toggles: (picks.toggles || []).map(t => ({ label: labelFor(t.el), type: t.type || "X", hidden: false })),
            confidence: 1
        },
        banner
    };
}

export const CONSENT_TYPE_NAMES = {
    A: "Preferences", B: "Performance", D: "Information storage", E: "Content", F: "Advertising", X: "Other"
};
