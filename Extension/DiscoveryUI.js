import { CONSENT_TYPE_NAMES, generateRuleFromPicks, discover, visible, uniqueSelector } from "./Discovery.js";

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
        header{display:flex;gap:10px;align-items:center;padding:14px 16px 6px;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}
        header.dragging{cursor:grabbing}
        header:focus-visible{outline:3px solid #9db4ff;outline-offset:-3px}
        .grip{margin-left:auto;color:#98a2b3;font-size:16px;letter-spacing:-2px;line-height:1}
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

// Lets the panel be dragged by its header (mouse, touch or pen) or moved with the arrow keys,
// so it can be shifted off the banner it is describing.
function makeDraggable(host, handle) {
    handle.setAttribute("tabindex", "0");
    handle.setAttribute("role", "button");
    handle.setAttribute("aria-label", "Move this panel (drag, or use the arrow keys)");
    handle.append(el("span", { class: "grip", "aria-hidden": "true" }, "⠿"));
    const place = (left, top) => {
        const maxL = Math.max(0, window.innerWidth - host.offsetWidth);
        const maxT = Math.max(0, window.innerHeight - host.offsetHeight);
        host.style.right = "auto"; host.style.bottom = "auto";
        host.style.left = Math.min(Math.max(0, left), maxL) + "px";
        host.style.top = Math.min(Math.max(0, top), maxT) + "px";
    };
    handle.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        const r = host.getBoundingClientRect();
        const dx = e.clientX - r.left, dy = e.clientY - r.top;
        handle.setPointerCapture(e.pointerId);
        handle.classList.add("dragging");
        const move = (ev) => place(ev.clientX - dx, ev.clientY - dy);
        const up = () => {
            handle.classList.remove("dragging");
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
            handle.removeEventListener("pointercancel", up);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
        e.preventDefault();
    });
    handle.addEventListener("keydown", (e) => {
        const step = e.shiftKey ? 80 : 20;
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (!d) return;
        e.preventDefault(); e.stopPropagation();
        const r = host.getBoundingClientRect();
        place(r.left + d[0], r.top + d[1]);
    });
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
        makeDraggable(host, card.querySelector("header"));
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
            { key: "manage", prompt: "Click the button that opens detailed options. It will open as normal (or Skip)", skippable: true },
            { key: "toggle", prompt: "Click each cookie toggle, then press Done. Clicks here only record the toggle", multi: true, skippable: true },
            { key: "save", prompt: "Click the button that saves or confirms the choices (or Skip)", skippable: true },
            { key: "reject", prompt: "Click the “Reject all” button (or Skip)", skippable: true },
            { key: "accept", prompt: "Click the “Accept all” button (or Skip)", skippable: true }
        ];
        const picks = { toggles: [], info: new Map() };
        let i = 0, hovered = null, removeHover = () => {};

        const { host, shadow } = createHost();
        const msg = el("div", { class: "body", role: "status", "aria-live": "polite" });
        const skip = el("button", { class: "ghost" }, "Skip");
        const done = el("button", {}, "Done");
        const cancel = el("button", { class: "ghost" }, "Cancel");
        const teachCard = el("div", { class: "card" },
            el("header", {}, el("div", { class: "dot" }, "C"), el("h1", {}, "Teach Consent-O-Matic")), msg,
            el("footer", {}, skip, done, cancel));
        shadow.appendChild(teachCard);
        makeDraggable(host, teachCard.querySelector("header"));

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
        // Nearest fixed/dialog-like ancestor, else the element itself.
        const containerOf = (t) => {
            for (let n = t; n && n !== document.body; n = n.parentElement) {
                if (/fixed|sticky/.test(getComputedStyle(n).position) || n.matches("dialog,[role='dialog'],[aria-modal='true']")) return n;
            }
            return t;
        };
        // Selectors are recorded now: opening the options can replace or remove the banner.
        const record = (el) => {
            const where = picks.panel && picks.panel.contains(el) && !picks.banner.contains(el) ? "panel" : "banner";
            picks.info.set(el, { where, selector: uniqueSelector(el, where === "panel" ? picks.panel : picks.banner) });
        };
        function onClick(e) {
            if (inUi(e.target)) return;
            const s = steps[i];
            const t = e.target;
            if (s.key === "manage") {
                // Let the page open its options panel so its toggles can be picked next.
                const link = t.closest("a[href]");
                const leaves = link && !/^(#|javascript:)/i.test(link.getAttribute("href")) && link.target !== "_blank";
                if (leaves) { e.preventDefault(); e.stopPropagation(); }
                const el = t.closest("button,[role='button'],a,input") || t;
                picks.manage = el; record(el);
                next();
                return;
            }
            e.preventDefault(); e.stopPropagation();
            if (s.key === "banner") {
                picks.banner = containerOf(t);
                picks.bannerSelector = uniqueSelector(picks.banner);
                next();
            } else if (s.key === "toggle") {
                const input = t.matches("input") ? t : (t.querySelector("input[type='checkbox']") || t.closest("label")?.querySelector("input") || t);
                if (!picks.panel && !picks.banner.contains(input)) {
                    picks.panel = containerOf(input);
                    picks.panelSelector = uniqueSelector(picks.panel);
                }
                if (!picks.toggles.find(x => x.el === input)) { record(input); picks.toggles.push({ el: input, type: "X" }); }
                render();
            } else {
                const el = t.closest("button,[role='button'],a,input") || t;
                if (!picks.panel && !picks.banner.contains(el) && el.isConnected && picks.toggles.length === 0) {
                    picks.panel = containerOf(el);
                    picks.panelSelector = uniqueSelector(picks.panel);
                }
                picks[s.key] = el; record(el);
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
