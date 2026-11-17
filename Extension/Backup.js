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
    enabled: false, repo: "", branch: "main", dir: "consent-o-matic", token: "",
    gistEnabled: false, gistId: "", gistFile: "custom-rules.json", gistToken: ""
};
const RULES_SCHEMA = "https://raw.githubusercontent.com/cavi-au/Consent-O-Matic/master/rules.schema.json";
const GIST_HASH_KEY = "backupGistHash";
const GIST_STATUS_KEY = "backupGistStatus";

function localGet(key, fallback) {
    return new Promise((resolve) => chrome.storage.local.get({ [key]: fallback }, (r) => resolve(r[key])));
}
function localSet(key, value) {
    return new Promise((resolve) => chrome.storage.local.set({ [key]: value }, resolve));
}

export async function getRemote() {
    return Object.assign({}, REMOTE_DEFAULTS, await localGet(REMOTE_KEY, {}));
}

export async function setRemote(cfg) {
    const next = Object.assign({}, await getRemote(), cfg);
    next.repo = String(next.repo || "").trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    next.branch = String(next.branch || "main").trim() || "main";
    next.dir = String(next.dir || "").trim().replace(/^\/+|\/+$/g, "");
    if (next.repo && !/^[\w.-]+\/[\w.-]+$/.test(next.repo)) throw new Error("Repository must look like owner/name");
    // Accept a gist URL or a bare id.
    const idMatch = String(next.gistId || "").match(/[0-9a-f]{20,40}/i);
    next.gistId = idMatch ? idMatch[0].toLowerCase() : "";
    if (String(cfg.gistId || "").trim() && !next.gistId) throw new Error("Gist must be a gist URL or id");
    next.gistFile = String(next.gistFile || "").trim() || "custom-rules.json";
    await localSet(REMOTE_KEY, next);
    await localSet(HASH_KEY, ""); // new target: push again even if content is unchanged
    await localSet(GIST_HASH_KEY, "");
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
    const res = await fetch(url, Object.assign({}, init, {
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

async function putFile(cfg, name, text, message) {
    const url = contentsUrl(cfg, name);
    let sha;
    const existing = await gh(cfg, url + "?ref=" + encodeURIComponent(cfg.branch));
    if (existing.ok) sha = (await existing.json()).sha;
    else if (existing.status !== 404) throw await explain(existing, "Reading " + name);

    const res = await gh(cfg, url, {
        method: "PUT",
        body: JSON.stringify({ message, content: toBase64(text), branch: cfg.branch, ...(sha ? { sha } : {}) })
    });
    if (!res.ok) throw await explain(res, "Writing " + name);
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
export async function pushRemote({ force = false } = {}) {
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

export function getGistStatus() {
    return localGet(GIST_STATUS_KEY, null);
}

/**
 * Publish the rules to a gist as a rule-list URL. The gist file is MERGED, never replaced: rules already in
 * it (written by hand, or by another install) are kept, and local rules win on a name clash. If the existing
 * file cannot be read or parsed nothing is written. Returns "pushed" | "unchanged" | "skipped".
 */
export async function pushGist({ force = false } = {}) {
    const cfg = await getRemote();
    if (!cfg.gistEnabled || !cfg.gistId || !cfg.gistToken) return "skipped";

    const local = await GDPRConfig.getCustomRuleLists();
    delete local["$schema"];
    if (Object.keys(local).length === 0) return "skipped";

    const hash = await sha256(JSON.stringify(local));
    if (!force && hash === await localGet(GIST_HASH_KEY, "")) return "unchanged";

    const url = "https://api.github.com/gists/" + cfg.gistId;
    try {
        const res = await gh(cfg, url, {}, cfg.gistToken);
        if (!res.ok) throw await explain(res, "Reading gist");
        const gist = await res.json();
        const file = gist.files && gist.files[cfg.gistFile];

        let remote = {};
        if (file) {
            if (file.truncated) throw new Error("Gist file is too large to merge safely; nothing was written");
            try { remote = JSON.parse(file.content); } catch (e) {
                throw new Error("Existing gist file is not valid JSON; nothing was written");
            }
            if (!remote || typeof remote !== "object" || Array.isArray(remote)) {
                throw new Error("Existing gist file is not a rule object; nothing was written");
            }
        }

        const merged = Object.assign({ "$schema": remote["$schema"] || RULES_SCHEMA }, remote, local);
        const added = Object.keys(merged).filter((k) => !(k in remote)).length;
        const changed = Object.keys(local).filter((k) => k in remote && JSON.stringify(remote[k]) !== JSON.stringify(local[k])).length;

        if (file && added === 0 && changed === 0) {
            await localSet(GIST_HASH_KEY, hash);
            await setGistStatus(true, "Gist already up to date");
            return "unchanged";
        }

        const patch = await gh(cfg, url, {
            method: "PATCH",
            body: JSON.stringify({ files: { [cfg.gistFile]: { content: JSON.stringify(merged, null, 2) + "\n" } } })
        }, cfg.gistToken);
        if (!patch.ok) throw await explain(patch, "Writing gist");

        await localSet(GIST_HASH_KEY, hash);
        await setGistStatus(true, "Gist updated: " + added + " added, " + changed + " changed, " + Object.keys(remote).filter((k) => k !== "$schema" && !(k in local)).length + " existing kept");
        return "pushed";
    } catch (e) {
        await setGistStatus(false, e.message);
        throw e;
    }
}
async function setGistStatus(ok, message) {
    await localSet(GIST_STATUS_KEY, { time: Date.now(), ok, message });
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
        pushGist().catch((e) => console.warn("Gist publish failed:", e.message));
    }, delay);
}
