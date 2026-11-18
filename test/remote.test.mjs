import test from "node:test";
import assert from "node:assert/strict";

function area() {
    const data = {};
    return {
        get(defaults, cb) { cb(Object.fromEntries(Object.keys(defaults).map(k => [k, k in data ? data[k] : defaults[k]]))); },
        set(obj, cb) { Object.assign(data, JSON.parse(JSON.stringify(obj))); cb && cb(); },
        remove(keys, cb) { [].concat(keys).forEach(k => delete data[k]); cb && cb(); }
    };
}
globalThis.chrome = { storage: { local: area(), sync: area() }, runtime: {} };

// In-memory GitHub contents API.
const repoFiles = new Map(); // path -> {sha, content(base64)}
const calls = [];
let failWith = null;
let conflictsLeft = 0; // simulate a concurrent writer: PUT fails with 409 this many times
let shaCounter = 0;
globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/);
    assert.ok(m, "unexpected URL " + url);
    assert.equal(init.headers.Authorization, "Bearer tok123");
    const path = decodeURIComponent(m[2]);
    const method = init.method || "GET";
    calls.push({ method, path, body: init.body && JSON.parse(init.body) });
    const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (failWith) return res(failWith, { message: "boom" });
    if (m[1] !== "me/private-rules") return res(404, { message: "Not Found" });
    if (method === "GET") return repoFiles.has(path) ? res(200, repoFiles.get(path)) : res(404, { message: "Not Found" });
    const body = JSON.parse(init.body);
    const prev = repoFiles.get(path);
    if (conflictsLeft > 0) { conflictsLeft--; if (prev) prev.sha = "other" + (++shaCounter); return res(409, { message: path + " does not match " + body.sha }); }
    if (prev && body.sha !== prev.sha) return res(409, { message: "sha mismatch" });
    repoFiles.set(path, { sha: "sha" + (++shaCounter), content: body.content });
    return res(200, {});
};

const B = await import("../Extension/Backup.js");
const GDPRConfig = (await import("../Extension/GDPRConfig.js")).default;
const rule = (n) => ({ [n]: { detectors: [{ presentMatcher: [{ type: "css", target: { selector: "#x" } }] }], methods: [] } });
const decode = (p) => JSON.parse(Buffer.from(repoFiles.get(p).content, "base64").toString("utf8"));

const CFG = { enabled: true, repo: "me/private-rules", branch: "main", dir: "consent-o-matic", token: "tok123" };

test("not configured or empty ruleset -> nothing is pushed", async () => {
    assert.equal(await B.pushRemote(), "skipped");
    await B.setRemote(CFG);
    assert.equal(await B.pushRemote(), "skipped", "empty ruleset must never overwrite a backup");
    assert.equal(calls.length, 0);
});

test("first push creates backup.json and custom-rules.json; token is not in the backup", async () => {
    await GDPRConfig.setCustomRuleLists({ ...rule("auto:a.test:x"), ...rule("taught:b.test:y") });
    assert.equal(await B.pushRemote(), "pushed");
    assert.deepEqual([...repoFiles.keys()].sort(), ["consent-o-matic/backup.json", "consent-o-matic/custom-rules.json"]);
    const backup = decode("consent-o-matic/backup.json");
    assert.equal(backup.format, "consent-o-matic-backup");
    assert.ok(!JSON.stringify(backup).includes("tok123"), "token must not leak into the backup");
    const rulesOnly = decode("consent-o-matic/custom-rules.json");
    assert.deepEqual(Object.keys(rulesOnly).sort(), ["$schema", "auto:a.test:x", "taught:b.test:y"]);
    assert.match(calls.find(c => c.method === "PUT").body.message, /^Backup \d{4}-\d\d-\d\d \d\d:\d\d \(2 rules\)$/);
    assert.equal((await B.getRemoteStatus()).ok, true);
});

test("unchanged content is not pushed again; a change updates with the existing sha", async () => {
    const before = calls.length;
    assert.equal(await B.pushRemote(), "unchanged");
    assert.equal(calls.length, before);
    await GDPRConfig.setCustomRuleLists({ ...rule("auto:a.test:x"), ...rule("taught:b.test:y"), ...rule("auto:c.test:z") });
    assert.equal(await B.pushRemote(), "pushed");
    const puts = calls.slice(before).filter(c => c.method === "PUT");
    assert.equal(puts.length, 2);
    assert.ok(puts.every(p => p.body.sha), "update must carry the current sha");
    assert.equal(Object.keys(decode("consent-o-matic/custom-rules.json")).length, 4);
});

test("failure is reported and retried: hash only advances on success", async () => {
    await GDPRConfig.setCustomRuleLists({ ...rule("only-one") });
    failWith = 401;
    await assert.rejects(B.pushRemote(), /401, token rejected/);
    assert.equal((await B.getRemoteStatus()).ok, false);
    failWith = null;
    assert.equal(await B.pushRemote(), "pushed", "next attempt pushes the pending change");
});

test("restore on a 'new install' from the repository", async () => {
    await GDPRConfig.setCustomRuleLists({});
    assert.equal(await B.restoreRemote("replace"), 1);
    assert.deepEqual(Object.keys(await GDPRConfig.getCustomRuleLists()), ["only-one"]);
});

test("restore falls back to custom-rules.json when backup.json is missing", async () => {
    repoFiles.delete("consent-o-matic/backup.json");
    await GDPRConfig.setCustomRuleLists({});
    assert.equal(await B.restoreRemote("replace"), 1);
});

test("repo input is normalised and validated", async () => {
    const cfg = await B.setRemote({ repo: "https://github.com/me/private-rules.git", dir: "/a/b/" });
    assert.equal(cfg.repo, "me/private-rules");
    assert.equal(cfg.dir, "a/b");
    await assert.rejects(B.setRemote({ repo: "not a repo" }), /owner\/name/);
});

test("legacy gist settings are wiped, including the token", async () => {
    await new Promise((r) => chrome.storage.local.set({ backupRemote: { repo: "me/private-rules", token: "tok123", enabled: true, gistEnabled: true, gistId: "abc", gistFile: "x.json", gistToken: "gtok" }, backupGistHash: "h", backupGistStatus: { ok: true } }, r));
    await B.dropGistConfig();
    const stored = await new Promise((r) => chrome.storage.local.get({ backupRemote: null, backupGistHash: "none", backupGistStatus: "none" }, r));
    assert.deepEqual(Object.keys(stored.backupRemote).sort(), ["enabled", "repo", "token"]);
    assert.equal(stored.backupGistHash, "none");
    assert.equal(stored.backupGistStatus, "none");
    const cfg = await B.getRemote();
    assert.equal(cfg.gistToken, undefined);
    assert.equal(cfg.token, "tok123");
});

test("409 from a concurrent writer is retried with a fresh sha; an unchanged rules file is not rewritten", async () => {
    await GDPRConfig.setCustomRuleLists({ ...rule("auto:race.test:x") });
    await B.setRemote(CFG);
    calls.length = 0;
    conflictsLeft = 2;
    assert.equal(await B.pushRemote({ force: true }), "pushed");
    assert.equal(conflictsLeft, 0);
    assert.ok(calls.filter(c => c.method === "PUT").length >= 4, "retried after the conflicts");
    assert.deepEqual(Object.keys(decode("consent-o-matic/custom-rules.json")).sort(), ["$schema", "auto:race.test:x"]);
    calls.length = 0;
    assert.equal(await B.pushRemote({ force: true }), "pushed");
    assert.equal(calls.filter(c => c.method === "PUT" && c.path.endsWith("custom-rules.json")).length, 0, "identical rules file is not rewritten");
});

test("simultaneous pushes are serialised and both succeed", async () => {
    await GDPRConfig.setCustomRuleLists({ ...rule("auto:two.test:y") });
    const results = await Promise.all([B.pushRemote({ force: true }), B.pushRemote({ force: true })]);
    assert.deepEqual(results, ["pushed", "pushed"]);
});
