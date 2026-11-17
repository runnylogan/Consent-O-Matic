import test from "node:test";
import assert from "node:assert/strict";

function area() {
    const data = {};
    return {
        get(defaults, cb) { cb(Object.fromEntries(Object.keys(defaults).map(k => [k, k in data ? data[k] : defaults[k]]))); },
        set(obj, cb) { Object.assign(data, JSON.parse(JSON.stringify(obj))); cb && cb(); }
    };
}
globalThis.chrome = { storage: { local: area(), sync: area() }, runtime: {} };

// In-memory GitHub contents API.
const repoFiles = new Map(); // path -> {sha, content(base64)}
const calls = [];
let failWith = null;
let shaCounter = 0;
// In-memory gist.
const GIST_ID = "9f78a5005cf3d79fc6a81c3ffde93c21";
let gistFiles = { "custom-rules.json": { content: JSON.stringify({ "$schema": "s", ConsentMagic: { detectors: [], methods: [] }, BBC: { detectors: [], methods: [] } }) } };
const gistCalls = [];
globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname.startsWith("/gists/")) {
        assert.equal(u.pathname, "/gists/" + GIST_ID);
        assert.equal(init.headers.Authorization, "Bearer gtok");
        const method = init.method || "GET";
        gistCalls.push(method);
        if (method === "GET") return { ok: true, status: 200, json: async () => ({ files: gistFiles }) };
        const body = JSON.parse(init.body);
        for (const [name, f] of Object.entries(body.files)) gistFiles[name] = { content: f.content };
        return { ok: true, status: 200, json: async () => ({}) };
    }
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

const GIST_CFG = { gistEnabled: true, gistId: "https://gist.github.com/runnylogan/" + GIST_ID, gistFile: "custom-rules.json", gistToken: "gtok" };
const gistRules = () => JSON.parse(gistFiles["custom-rules.json"].content);

test("gist: not configured -> skipped; id is taken from a URL", async () => {
    assert.equal(await B.pushGist(), "skipped");
    const cfg = await B.setRemote(GIST_CFG);
    assert.equal(cfg.gistId, GIST_ID);
});

test("gist: merges into the existing file, keeps existing rules, adds local ones", async () => {
    await GDPRConfig.setCustomRuleLists({ ...rule("auto:a.test:x") });
    assert.equal(await B.pushGist(), "pushed");
    assert.deepEqual(Object.keys(gistRules()).sort(), ["$schema", "BBC", "ConsentMagic", "auto:a.test:x"]);
    assert.equal(gistRules().$schema, "s", "existing $schema is kept");
    assert.match((await B.getGistStatus()).message, /1 added, 0 changed, 2 existing kept/);
});

test("gist: unchanged is not rewritten; local wins on a name clash; remote-only rules survive", async () => {
    const before = gistCalls.length;
    assert.equal(await B.pushGist(), "unchanged");
    assert.equal(gistCalls.length, before, "no network when unchanged");
    const changed = { "auto:a.test:x": { detectors: [], methods: [{ name: "UTILITY" }] } };
    await GDPRConfig.setCustomRuleLists(changed);
    assert.equal(await B.pushGist(), "pushed");
    assert.deepEqual(gistRules()["auto:a.test:x"], changed["auto:a.test:x"]);
    assert.ok(gistRules().BBC && gistRules().ConsentMagic, "hand-written rules are never removed");
});

test("gist: unparseable existing file is never overwritten", async () => {
    gistFiles["custom-rules.json"] = { content: "{ not json" };
    await GDPRConfig.setCustomRuleLists({ ...rule("something-new") });
    await assert.rejects(B.pushGist(), /not valid JSON; nothing was written/);
    assert.equal(gistFiles["custom-rules.json"].content, "{ not json");
    assert.equal((await B.getGistStatus()).ok, false);
});

test("gist: missing file is created; empty local ruleset is never published", async () => {
    gistFiles = {};
    assert.equal(await B.pushGist(), "pushed");
    assert.deepEqual(Object.keys(gistRules()).sort(), ["$schema", "something-new"]);
    await GDPRConfig.setCustomRuleLists({});
    assert.equal(await B.pushGist({ force: true }), "skipped");
});
