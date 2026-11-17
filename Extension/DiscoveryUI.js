import { CONSENT_TYPE_NAMES, generateRuleFromPicks, discover, visible } from "./Discovery.js";

// All UI lives in a closed shadow root so page CSS cannot break it and it cannot break the page.
function createHost() {
    const host = document.createElement("div");
    host.setAttribute("data-consent-o-matic-discovery", "");
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
        :host{all:initial}
        *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
        .card{width:340px;max-width:calc(100vw - 32px);background:#fff;color:#1b1f27;border-radius:16px;
              box-shadow:0 12px 40px rgba(16,24,40,.28),0 0 0 1px rgba(16,24,40,.08);overflow:hidden;font-size:13px;line-height:1.45}
        @media (prefers-color-scheme:dark){.card{background:#1d2129;color:#e8ebf2;box-shadow:0 12px 40px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.1)}
            .muted{color:#9aa3b5!important}.row{border-color:#2d3340!important}select,button.ghost{background:#272c37!important;color:#e8ebf2!important;border-color:#394052!important}}
        header{display:flex;gap:10px;align-items:center;padding:14px 16px 6px}
        .dot{width:28px;height:28px;border-radius:9px;background:linear-gradient(135deg,#4f7cff,#7b4fff);display:grid;place-items:center;color:#fff;font-weight:700}
        h1{font-size:14px;margin:0;font-weight:650}
        .muted{color:#667085;font-size:12px}
        .body{padding:4px 16px 12px}
        .row{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:7px 0;border-top:1px solid #eef0f4}
        .row span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .badge{padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;background:#eef2ff;color:#3b4fd6}
        .badge.ok{background:#e7f8ee;color:#127a3e}.badge.warn{background:#fff4e0;color:#a15c00}.badge.bad{background:#fdeceb;color:#b42318}
        select{font:inherit;font-size:12px;padding:3px 6px;border:1px solid #d0d5dd;border-radius:8px;background:#fff}
        footer{display:flex;gap:8px;padding:12px 16px 16px;flex-wrap:wrap}
        button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:8px 12px;cursor:pointer;background:#4f46e5;color:#fff}
        button:hover{filter:brightness(1.08)}button:focus-visible,select:focus-visible{outline:3px solid #9db4ff;outline-offset:2px}
        button.ghost{background:#fff;color:#344054;border:1px solid #d0d5dd}
        button[disabled]{opacity:.5;cursor:not-allowed}
        @media (prefers-reduced-motion:no-preference){.card{animation:in .22s ease-out}@keyframes in{from{transform:translateY(12px);opacity:0}}}
    `;
    shadow.appendChild(style);
    document.documentElement.appendChild(host);
    return { host, shadow };
}

function el(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
        if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v);
    });
    children.flat().forEach(c => e.append(c));
    return e;
}

function highlight(target) {
    if (!target) return () => {};
    const old = target.style.outline;
    target.style.setProperty("outline", "3px solid #4f46e5", "important");
    return () => { target.style.outline = old; };
}

/**
 * Review panel for a generated rule.
 * result: output of discover()/generateRuleFromPicks(); dryRun: {ok, detail}
 * returns a promise resolving to {action:"save"|"teach"|"dismiss", types:{index:type}}
 */
export function showReview(result, dryRun) {
    return new Promise((resolve) => {
        const { host, shadow } = createHost();
        const unhighlight = highlight(result.banner);
        const done = (action, extra = {}) => { unhighlight(); host.remove(); resolve({ action, ...extra }); };

        const a = result.analysis;
        const typeSelects = a.toggles.map((t) => {
            const sel = el("select", { "aria-label": `Category for ${t.label}` },
                Object.entries(CONSENT_TYPE_NAMES).map(([k, v]) => {
                    const o = el("option", { value: k }, v); if (k === t.type) o.selected = true; return o;
                }));
            return sel;
        });

        const conf = a.confidence >= 0.8 ? ["High confidence", "ok"] : a.confidence >= 0.6 ? ["Medium confidence", "warn"] : ["Low confidence", "bad"];
        const dry = dryRun.ok ? ["Dry run passed", "ok"] : ["Dry run failed", "bad"];

        const rows = [];
        const addRow = (label, value) => value && rows.push(el("div", { class: "row" }, el("span", {}, label), el("span", { class: "badge" }, value)));
        addRow("Reject button", a.reject); addRow("Accept button", a.accept);
        addRow("Save button", a.save); addRow("Options button", a.manage);
        a.toggles.forEach((t, i) => rows.push(el("div", { class: "row" }, el("span", { title: t.label }, t.label || "(unlabelled toggle)"), typeSelects[i])));

        const save = el("button", { onclick: () => done("save", { types: typeSelects.map(s => s.value) }) }, "Save rule");
        if (!dryRun.ok) save.setAttribute("disabled", "");

        const card = el("div", { class: "card", role: "dialog", "aria-label": "Consent-O-Matic: new banner" },
            el("header", {}, el("div", { class: "dot" }, "C"),
                el("div", {}, el("h1", {}, "New cookie banner found"),
                    el("div", { class: "muted" }, "No rule covers this site yet."))),
            el("div", { class: "body" },
                el("div", { class: "row", style: "border-top:0" },
                    el("span", { class: "badge " + conf[1] }, conf[0]), el("span", { class: "badge " + dry[1], title: dryRun.detail || "" }, dry[0])),
                rows),
            el("footer", {}, save,
                el("button", { class: "ghost", onclick: () => done("teach") }, "Teach it"),
                el("button", { class: "ghost", onclick: () => done("dismiss") }, "Not now")));
        shadow.appendChild(card);
        save.focus();
        card.addEventListener("keydown", (e) => { if (e.key === "Escape") done("dismiss"); });
    });
}

/**
 * Teach mode: guided element picker. Resolves to a generated result or null if cancelled.
 */
export function teachMode(hostname) {
    return new Promise((resolve) => {
        const steps = [
            { key: "banner", prompt: "Click anywhere inside the cookie banner", required: true },
            { key: "manage", prompt: "Click the button that opens detailed options (or Skip)", skippable: true },
            { key: "toggle", prompt: "Click each cookie toggle, then press Done", multi: true, skippable: true },
            { key: "save", prompt: "Click the button that saves or confirms the choices (or Skip)", skippable: true },
            { key: "reject", prompt: "Click the “Reject all” button (or Skip)", skippable: true },
            { key: "accept", prompt: "Click the “Accept all” button (or Skip)", skippable: true }
        ];
        const picks = { toggles: [] };
        let i = 0, hovered = null, removeHover = () => {};

        const { host, shadow } = createHost();
        const msg = el("div", { class: "body", role: "status", "aria-live": "polite" });
        const skip = el("button", { class: "ghost" }, "Skip");
        const done = el("button", {}, "Done");
        const cancel = el("button", { class: "ghost" }, "Cancel");
        shadow.appendChild(el("div", { class: "card" },
            el("header", {}, el("div", { class: "dot" }, "C"), el("h1", {}, "Teach Consent-O-Matic")), msg,
            el("footer", {}, skip, done, cancel)));

        const inUi = (t) => host.contains(t) || t === host;
        const cleanup = () => {
            removeHover(); host.remove();
            document.removeEventListener("click", onClick, true);
            document.removeEventListener("mouseover", onOver, true);
        };
        const finish = () => {
            cleanup();
            if (!picks.banner) return resolve(null);
            const result = generateRuleFromPicks(picks, hostname);
            resolve(result);
        };
        const render = () => {
            const s = steps[i];
            msg.textContent = `Step ${i + 1} of ${steps.length}: ${s.prompt}` + (s.multi ? ` (${picks.toggles.length} picked)` : "");
            skip.style.display = s.skippable ? "" : "none";
            done.style.display = s.multi ? "" : "none";
        };
        const next = () => { i++; i >= steps.length ? finish() : render(); };

        function onOver(e) {
            if (inUi(e.target)) return;
            removeHover(); hovered = e.target; removeHover = highlight(hovered);
        }
        function onClick(e) {
            if (inUi(e.target)) return;
            e.preventDefault(); e.stopPropagation();
            const s = steps[i];
            const t = e.target;
            if (s.key === "banner") {
                // Climb to the nearest fixed/dialog-like ancestor, else the largest reasonable container.
                let n = t, best = t;
                while (n && n !== document.body) {
                    const pos = getComputedStyle(n).position;
                    if (/fixed|sticky/.test(pos) || n.matches("dialog,[role='dialog'],[aria-modal='true']")) { best = n; break; }
                    n = n.parentElement;
                }
                picks.banner = best;
                next();
            } else if (s.key === "toggle") {
                const input = t.matches("input") ? t : (t.querySelector("input[type='checkbox']") || t.closest("label")?.querySelector("input") || t);
                if (!picks.toggles.find(x => x.el === input)) picks.toggles.push({ el: input, type: "X" });
                render();
            } else {
                picks[s.key] = t.closest("button,[role='button'],a,input") || t;
                next();
            }
        }
        skip.addEventListener("click", next);
        done.addEventListener("click", next);
        cancel.addEventListener("click", () => { cleanup(); resolve(null); });
        document.addEventListener("click", onClick, true);
        document.addEventListener("mouseover", onOver, true);
        render();
    });
}

export { discover, visible };
