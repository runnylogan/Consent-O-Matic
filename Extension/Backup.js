import GDPRConfig from "./GDPRConfig.js";

export const BACKUP_FORMAT = "consent-o-matic-backup";
export const BACKUP_VERSION = 1;
const SNAPSHOT_KEY = "ruleBackups";
const MAX_SNAPSHOTS = 10;

export async function buildBackup() {
    return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        createdAt: new Date().toISOString(),
        customRuleLists: await GDPRConfig.getCustomRuleLists(),
        ruleLists: await GDPRConfig.getRuleLists(),
        consentValues: await GDPRConfig.getConsentValues(),
        generalSettings: await GDPRConfig.getGeneralSettings()
    };
}

/** Accepts either a full backup or a plain rules file ({ "$schema": ..., "name": { detectors, methods } }); returns backup form. */
export function normaliseImport(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || obj.format === BACKUP_FORMAT) return obj;
    const names = Object.keys(obj).filter((k) => k !== "$schema");
    const looksLikeRules = names.length > 0 && names.every((k) => obj[k] && Array.isArray(obj[k].detectors) && Array.isArray(obj[k].methods));
    return looksLikeRules ? { format: BACKUP_FORMAT, version: BACKUP_VERSION, customRuleLists: obj } : obj;
}

export function validateBackup(obj) {
    if (!obj || typeof obj !== "object") throw new Error("Not a JSON object");
    if (obj.format !== BACKUP_FORMAT) throw new Error("Not a Consent-O-Matic backup file");
    if (typeof obj.version !== "number" || obj.version > BACKUP_VERSION) throw new Error("Backup was made by a newer version");
    if (!obj.customRuleLists || typeof obj.customRuleLists !== "object" || Array.isArray(obj.customRuleLists)) {
        throw new Error("Backup has no ruleset");
    }
    for (const [name, rule] of Object.entries(obj.customRuleLists)) {
        if (name === "$schema") continue;
        if (!rule || !Array.isArray(rule.detectors) || !Array.isArray(rule.methods)) {
            throw new Error("Rule '" + name + "' is malformed");
        }
    }
    return obj;
}

/** mode: "merge" keeps existing rules (backup wins on name clash); "replace" overwrites everything. */
export async function applyBackup(obj, mode = "merge", { settings = true } = {}) {
    obj = normaliseImport(obj);
    validateBackup(obj);
    await snapshotLocal("before-restore");

    const incoming = Object.assign({}, obj.customRuleLists);
    delete incoming["$schema"];
    const current = mode === "replace" ? {} : await GDPRConfig.getCustomRuleLists();
    await GDPRConfig.setCustomRuleLists(Object.assign({}, current, incoming));

    if (settings) {
        if (Array.isArray(obj.ruleLists)) {
            const existing = mode === "replace" ? [] : await GDPRConfig.getRuleLists();
            await GDPRConfig.setRuleLists(Array.from(new Set([...existing, ...obj.ruleLists])));
        }
        if (obj.consentValues) await GDPRConfig.setConsentValues(obj.consentValues);
        if (obj.generalSettings) await GDPRConfig.setGeneralSettings(obj.generalSettings);
    }
    return Object.keys(incoming).length;
}

export function listSnapshots() {
    return new Promise((resolve) => chrome.storage.local.get({ [SNAPSHOT_KEY]: [] }, (r) => resolve(r[SNAPSHOT_KEY])));
}

/** Rotating in-extension history. Survives rule edits, not an uninstall. */
export async function snapshotLocal(reason = "auto") {
    const backup = await buildBackup();
    if (Object.keys(backup.customRuleLists).length === 0) return null; // never record an empty ruleset
    const snaps = await listSnapshots();
    const last = snaps[0];
    if (last && JSON.stringify(last.backup.customRuleLists) === JSON.stringify(backup.customRuleLists)) return last;
    const entry = { id: Date.now(), reason, ruleCount: Object.keys(backup.customRuleLists).length, backup };
    const next = [entry, ...snaps].slice(0, MAX_SNAPSHOTS);
    await new Promise((resolve) => chrome.storage.local.set({ [SNAPSHOT_KEY]: next }, resolve));
    return entry;
}

// ---------- Online backup (GitHub repository) ----------
//
// Each change is pushed as a commit, so the repository history is the dated backup trail.
// Two files are written: backup.json (rules + settings, for restoring) and custom-rules.json
// (rules only, usable as a rule-list URL). The token is stored only in storage.local and is never
// part of a backup. Rule names contain site hostnames: use a private repository.

const REMOTE_KEY = "backupRemote";
const STATUS_KEY = "backupRemoteStatus";
const HASH_KEY = "backupRemoteHash";

export const REMOTE_DEFAULTS = {
    enabled: false, repo: "", branch: "main", dir: "consent-o-matic", token: ""
};
const LEGACY_GIST_KEYS = ["gistEnabled", "gistId", "gistFile", "gistToken"];
const RULES_SCHEMA = "https://raw.githubusercontent.com/cavi-au/Consent-O-Matic/master/rules.schema.json";

function localGet(key, fallback) {
    return new Promise((resolve) => chrome.storage.local.get({ [key]: fallback }, (r) => resolve(r[key])));
}
function localSet(key, value) {
    return new Promise((resolve) => chrome.storage.local.set({ [key]: value }, resolve));
}

export async function getRemote() {
    const stored = Object.assign({}, await localGet(REMOTE_KEY, {}));
    for (const k of LEGACY_GIST_KEYS) delete stored[k];
    return Object.assign({}, REMOTE_DEFAULTS, stored);
}

/** The gist target was removed: wipe any saved gist settings (including its token) and status. */
export async function dropGistConfig() {
    const stored = await localGet(REMOTE_KEY, null);
    if (stored && LEGACY_GIST_KEYS.some((k) => k in stored)) {
        for (const k of LEGACY_GIST_KEYS) delete stored[k];
        await localSet(REMOTE_KEY, stored);
    }
    await new Promise((resolve) => chrome.storage.local.remove(["backupGistHash", "backupGistStatus"], resolve));
}

export async function setRemote(cfg) {
    const next = Object.assign({}, await getRemote(), cfg);
    next.repo = String(next.repo || "").trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    next.branch = String(next.branch || "main").trim() || "main";
    next.dir = String(next.dir || "").trim().replace(/^\/+|\/+$/g, "");
    if (next.repo && !/^[\w.-]+\/[\w.-]+$/.test(next.repo)) throw new Error("Repository must look like owner/name");
    await localSet(REMOTE_KEY, next);
    await localSet(HASH_KEY, ""); // new target: push again even if content is unchanged
    return next;
}

export function getRemoteStatus() {
    return localGet(STATUS_KEY, null);
}
async function setStatus(ok, message) {
    await localSet(STATUS_KEY, { time: Date.now(), ok, message });
}

function toBase64(text) {
    let bin = "";
    new TextEncoder().encode(text).forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
}
function fromBase64(b64) {
    const bin = atob(b64.replace(/\s/g, ""));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function contentsUrl(cfg, name) {
    const path = (cfg.dir ? cfg.dir + "/" : "") + name;
    return "https://api.github.com/repos/" + cfg.repo + "/contents/" + path.split("/").map(encodeURIComponent).join("/");
}

async function gh(cfg, url, init = {}, token = cfg.token) {
    const res = await fetch(url, Object.assign({ cache: "no-store" }, init, {
        headers: Object.assign({
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28"
        }, init.body ? { "Content-Type": "application/json" } : {}, init.headers || {})
    }));
    return res;
}

async function explain(res, what) {
    let detail = "";
    try { detail = (await res.json()).message || ""; } catch (e) { /* no body */ }
    const hint = res.status === 401 ? "token rejected"
        : res.status === 403 ? "token lacks Contents: write on this repository, or rate limited"
        : res.status === 404 ? "repository, branch or path not found, or token cannot see it"
        : res.status === 422 ? "branch does not exist?" : "";
    return new Error(what + " failed (" + res.status + (hint ? ", " + hint : "") + (detail ? ": " + detail : "") + ")");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Create or update one file. The background page and the options page can both push at once, so a 409
 * ("sha does not match") means the version we read is stale: read again and retry. Identical content is
 * never written, so no empty commits. Returns true if a commit was made.
 */
async function putFile(cfg, name, text, message) {
    const url = contentsUrl(cfg, name);
    const content = toBase64(text);
    for (let attempt = 0; ; attempt++) {
        let sha;
        const existing = await gh(cfg, url + "?ref=" + encodeURIComponent(cfg.branch));
        if (existing.ok) {
            const file = await existing.json();
            if (typeof file.content === "string" && file.content.replace(/\s/g, "") === content) return false;
            sha = file.sha;
        } else if (existing.status !== 404) throw await explain(existing, "Reading " + name);

        const res = await gh(cfg, url, {
            method: "PUT",
            body: JSON.stringify({ message, content, branch: cfg.branch, ...(sha ? { sha } : {}) })
        });
        if (res.ok) return true;
        if (res.status === 409 && attempt < 4) { await sleep(300 + Math.random() * 700); continue; }
        throw await explain(res, "Writing " + name);
    }
}

function stamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/**
 * Push the current backup. Skips when not configured, when the ruleset is empty (a fresh install must
 * never overwrite a good backup) or when nothing changed since the last successful push.
 * Returns "pushed" | "unchanged" | "skipped".
 */
let pushChain = Promise.resolve();
export function pushRemote(opts = {}) {
    const run = pushChain.then(() => pushRemoteNow(opts));
    pushChain = run.catch(() => {});
    return run;
}

async function pushRemoteNow({ force = false } = {}) {
    const cfg = await getRemote();
    if (!cfg.enabled || !cfg.repo || !cfg.token) return "skipped";

    const backup = await buildBackup();
    const count = Object.keys(backup.customRuleLists).length;
    if (count === 0) return "skipped";

    const hash = await sha256(JSON.stringify([backup.customRuleLists, backup.ruleLists, backup.consentValues, backup.generalSettings]));
    if (!force && hash === await localGet(HASH_KEY, "")) return "unchanged";

    try {
        const message = "Backup " + stamp() + " (" + count + " rule" + (count === 1 ? "" : "s") + ")";
        const rulesOnly = Object.assign({ "$schema": "https://raw.githubusercontent.com/cavi-au/Consent-O-Matic/master/rules.schema.json" }, backup.customRuleLists);
        await putFile(cfg, "backup.json", JSON.stringify(backup, null, 2) + "\n", message);
        await putFile(cfg, "custom-rules.json", JSON.stringify(rulesOnly, null, 2) + "\n", message);
        await localSet(HASH_KEY, hash);
        await setStatus(true, message);
        return "pushed";
    } catch (e) {
        await setStatus(false, e.message);
        throw e;
    }
}

/** Restore from the configured repository (used on a new install after entering repo + token). */
export async function restoreRemote(mode = "merge") {
    const cfg = await getRemote();
    if (!cfg.repo || !cfg.token) throw new Error("Enter the repository and token first");

    let res = await gh(cfg, contentsUrl(cfg, "backup.json") + "?ref=" + encodeURIComponent(cfg.branch));
    let obj;
    if (res.ok) {
        obj = JSON.parse(fromBase64((await res.json()).content));
    } else if (res.status === 404) {
        // Fall back to the rules-only file.
        res = await gh(cfg, contentsUrl(cfg, "custom-rules.json") + "?ref=" + encodeURIComponent(cfg.branch));
        if (!res.ok) throw await explain(res, "Reading backup");
        obj = { format: BACKUP_FORMAT, version: BACKUP_VERSION, customRuleLists: JSON.parse(fromBase64((await res.json()).content)) };
    } else {
        throw await explain(res, "Reading backup");
    }
    return applyBackup(obj, mode, { settings: Boolean(obj.ruleLists || obj.consentValues || obj.generalSettings) });
}

let timer = null;
/** Called from the background page whenever custom rules change: snapshot now, push shortly after. */
export function scheduleBackup(delay = 3000) {
    snapshotLocal("auto").catch((e) => console.warn("Snapshot failed", e));
    clearTimeout(timer);
    timer = setTimeout(() => {
        pushRemote().catch((e) => console.warn("Online backup failed:", e.message));
    }, delay);
}


/**
 * Seed rules bundled with the extension into custom rules, once per bundle version.
 * Only adds names that are missing, so later edits and deletions are never overwritten.
 * Returns the number of rules added.
 */
export async function seedBundledRules(bundled, version) {
    const { bundledRulesVersion } = await new Promise((r) => chrome.storage.local.get({ bundledRulesVersion: 0 }, r));
    if (bundledRulesVersion >= version) return 0;
    const current = await GDPRConfig.getCustomRuleLists();
    const add = {};
    for (const [name, rule] of Object.entries(bundled)) {
        if (rule && Array.isArray(rule.detectors) && Array.isArray(rule.methods) && !(name in current)) add[name] = rule;
    }
    if (Object.keys(add).length) await GDPRConfig.setCustomRuleLists(Object.assign({}, current, add));
    await new Promise((r) => chrome.storage.local.set({ bundledRulesVersion: version }, r));
    return Object.keys(add).length;
}
