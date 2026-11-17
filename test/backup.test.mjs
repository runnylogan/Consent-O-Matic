import test from "node:test";
import assert from "node:assert/strict";

// Minimal in-memory chrome.storage stub (local + sync share semantics for these tests).
function area() {
    const data = {};
    return {
        get(defaults, cb) { cb(Object.fromEntries(Object.keys(defaults).map(k => [k, k in data ? data[k] : defaults[k]]))); },
        set(obj, cb) { Object.assign(data, JSON.parse(JSON.stringify(obj))); cb && cb(); }
    };
}
globalThis.chrome = { storage: { local: area(), sync: area() }, runtime: {} };

const { buildBackup, validateBackup, applyBackup, snapshotLocal, listSnapshots } = await import("../Extension/Backup.js");
const GDPRConfig = (await import("../Extension/GDPRConfig.js")).default;

const rule = (n) => ({ [n]: { detectors: [{ presentMatcher: [{ type: "css", target: { selector: "#x" } }] }], methods: [] } });

test("empty ruleset is never snapshotted", async () => {
    assert.equal(await snapshotLocal(), null);
});

test("round trip: backup -> wipe -> restore on 'new install'", async () => {
    await GDPRConfig.setCustomRuleLists({ ...rule("auto:a.test:x"), ...rule("taught:b.test:y") });
    await GDPRConfig.setConsentValues({ A: true, F: false });
    const backup = await buildBackup();
    JSON.parse(JSON.stringify(backup)); // serialisable

    await GDPRConfig.setCustomRuleLists({});   // fresh install
    await GDPRConfig.setConsentValues({});
    const n = await applyBackup(backup, "replace");
    assert.equal(n, 2);
    assert.deepEqual(Object.keys(await GDPRConfig.getCustomRuleLists()).sort(), ["auto:a.test:x", "taught:b.test:y"]);
    assert.equal((await GDPRConfig.getConsentValues()).A, true);
});

test("merge keeps existing rules; replace drops them", async () => {
    await GDPRConfig.setCustomRuleLists(rule("keep-me"));
    const backup = { ...(await buildBackup()), customRuleLists: rule("from-backup") };
    await applyBackup(backup, "merge");
    assert.deepEqual(Object.keys(await GDPRConfig.getCustomRuleLists()).sort(), ["from-backup", "keep-me"]);
    await applyBackup(backup, "replace");
    assert.deepEqual(Object.keys(await GDPRConfig.getCustomRuleLists()), ["from-backup"]);
});

test("restore takes a safety snapshot first", async () => {
    await GDPRConfig.setCustomRuleLists(rule("precious"));
    await applyBackup({ ...(await buildBackup()), customRuleLists: rule("other") }, "replace");
    const snaps = await listSnapshots();
    assert.ok(snaps.some(s => "precious" in s.backup.customRuleLists), "pre-restore state is recoverable");
});

test("malformed or foreign files are rejected", () => {
    assert.throws(() => validateBackup({}), /Not a Consent-O-Matic backup/);
    assert.throws(() => validateBackup({ format: "consent-o-matic-backup", version: 99, customRuleLists: {} }), /newer/);
    assert.throws(() => validateBackup({ format: "consent-o-matic-backup", version: 1, customRuleLists: { bad: {} } }), /malformed/);
});
