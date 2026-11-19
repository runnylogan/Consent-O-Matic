import GDPRConfig from './GDPRConfig.js';
import { scheduleBackup, pushRemote, seedBundledRules, dropGistConfig } from './Backup.js';

const STATUS = {
    "INIT": 0,
    "NOTHING": 1,
    "SEARCHING": 2,
    "ERROR": 3,
    "HANDLED": 4
}

chrome.runtime.onMessage.addListener(function (message, sender, reply) {
    console.log("Got msg", message);
    try {
    switch (message.split("|")[0]) {
        case "GetTabUrl": {
            reply(sender.tab.url);
            return false;
        }

        case "GetRuleList": {
            GDPRConfig.getDebugValues().then((debugValues)=>{
                fetchRules(debugValues.alwaysForceRulesUpdate).then((rules)=>{
                    reply(rules);
                });
            });
            //Return true to keep reply working after method has ended, async response
            return true;
        }

        case "ForceRuleUpdate": {
            forceRuleUpdate().then(reply);
            return true;
        }

        case "GetCustomRuleList": {
            GDPRConfig.getCustomRuleLists().then((customRules)=>{
                reply(customRules);
            });
            //Return true to keep reply working after method has ended, async response
            return true;
        }

        case "AddCustomRule": {
            let newRule = JSON.parse(message.substring(message.indexOf("|")+1));

            GDPRConfig.getCustomRuleLists().then((customRules)=>{
                // A rule discovery or teach mode builds replaces the earlier ones it built for the same site, so old
                // attempts cannot run first and get in the way. (Openers end in ":open" and are added after their rule.)
                const [newName] = Object.keys(newRule);
                const m = /^(?:auto|taught):([^:]+):/.exec(newName || "");
                if (m && !newName.endsWith(":open")) {
                    Object.keys(customRules).forEach((key) => {
                        const k = /^(?:auto|taught):([^:]+):/.exec(key);
                        if (k && k[1] === m[1] && key !== newName) delete customRules[key];
                    });
                }
                let combinedCustomRules = Object.assign({}, customRules, newRule);

                GDPRConfig.setCustomRuleLists(combinedCustomRules);
            });

            return false;
        }

        case "DeleteCustomRule": {
            let deleteRule = message.substring(message.indexOf("|")+1);

            GDPRConfig.getCustomRuleLists().then((customRules)=>{
                delete customRules[deleteRule];

                GDPRConfig.setCustomRuleLists(customRules).then(()=>{
                    reply();
                });
            });

            return true;
        }

        case "CMPError": {
            if(tabStatusMap.get(sender.tab.id) !== STATUS.HANDLED) {
                setBadgeCheckmark("\u2717", sender.tab.id);
                tabStatusMap.set(sender.tab.id, STATUS.ERROR);
            }
	    reply();
            return false;
        }

        case "NothingFound": {
            if(tabStatusMap.get(sender.tab.id) !== STATUS.HANDLED) {
                setBadgeCheckmark("", sender.tab.id);
                tabStatusMap.set(sender.tab.id, STATUS.NOTHING);
            }
	    reply();
            return false;
        }

        case "Searching": {
            if(tabStatusMap.get(sender.tab.id) !== STATUS.HANDLED) {
                setBadgeCheckmark("\uD83D\uDD0E", sender.tab.id);
                tabStatusMap.set(sender.tab.id, STATUS.SEARCHING);
            }
	    reply();
            return false;
        }

        case "HandledCMP": {
            let json = JSON.parse(message.substring(message.indexOf("|")+1));

            setBadgeCheckmark("\u2714", sender.tab.id);

            tabStatusMap.set(sender.tab.id, STATUS.HANDLED);

            recordActivity(json, sender.tab.url);

            GDPRConfig.getStatistics().then((entries)=>{
                entries.clicks += json.clicks;
                
                if (!entries.cmps.hasOwnProperty(json.cmp)){
                    entries.cmps[json.cmp] = {
                        filledForms: 0,
                        clicks: 0
                    }
                }
                entries.cmps[json.cmp].filledForms ++;
                entries.cmps[json.cmp].clicks += json.clicks;

                GDPRConfig.setStatistics(entries);
            });
	    reply();
            return false;
        }

        default:
            console.warn("Unhandled message:", message);
    }
    } catch (ex){
	console.log(ex);
    }
});

function setBadgeCheckmark(text, id) {
    if (chrome.browserAction){
        if (chrome.browserAction.setBadgeText){
            chrome.browserAction.setBadgeText({
                text: text,
                tabId: id
            });
        }
        if (chrome.browserAction.setBadgeBackgroundColor){
            chrome.browserAction.setBadgeBackgroundColor({
                color: "white",
                tabId: id
            });
        }
    }
}

function fetchRules(forceUpdate) {
    // Make sure the cached rule-lists are up-to-date, fetch updates if needed
    let maxStaleness = 22 * 3600 + (Math.random()*26*3600);  // Fetch frequency in seconds
    let rulePromise = new Promise((resolve, reject) => {
        GDPRConfig.getRuleLists().then((ruleLists) => {

            let oldDefaultListIndex = ruleLists.indexOf("https://raw.githubusercontent.com/cavi-au/Consent-O-Matic/master/Rules.json");

            if(oldDefaultListIndex !== -1) {
                console.log("Cleaning old rule list, and replacing with new reference based list...");
                ruleLists[oldDefaultListIndex] = "https://raw.githubusercontent.com/cavi-au/Consent-O-Matic/master/rules-list.json"
                GDPRConfig.setRuleLists(ruleLists);
            }

            chrome.storage.local.get({ cachedEntries: {} }, async function ({ cachedEntries: cachedEntries }) {
                let rules = [];
                for (let ruleList of ruleLists) {
                    let entry = cachedEntries[ruleList];

                    // Check for cache
                    if (!forceUpdate && (entry != null && 'timestamp' in entry && ((Date.now() / 1000) - entry.timestamp) < maxStaleness && 'rules' in entry)) {
                        rules.push(entry.rules);
                    } else {
                        // No cache, or to old, try to fetch
                        let theList = await fetchRulesList(ruleList);

                        if(theList != null) {
                            let storedEntry = {};
                            rules.push(theList);
                            cachedEntries[ruleList] = {
                                timestamp: Date.now() / 1000,
                                rules: theList
                            };
                        } else {
                            //Reuse cached entry even though its out of date at this point
                            console.log("Failed to fetch CoM rule list, check the URL", ruleList);
                            if(entry != null) {
                                rules.push(entry.rules);
                            } else {
                        	console.log("Giving up entirely on rule list, no cache available either",ruleList);
                            }
                        }
                    }
                }

                chrome.storage.local.set({
                    cachedEntries: cachedEntries
                }, () => {
                    resolve(rules);
                });
            });
        });
    });

    return rulePromise;

}

// Recent activity for the About page: which rule handled which site, and the settings in force at the time.
const ACTIVITY_KEY = "handledLog";
const ACTIVITY_MAX = 30;
function recordActivity(json, tabUrl) {
    let host = "";
    try { host = new URL(json.url || tabUrl).hostname; } catch (e) { /* keep empty */ }
    const entry = { time: Date.now(), host, cmp: json.cmp, source: json.source || "", clicks: json.clicks || 0, consentTypes: json.consentTypes || {} };
    chrome.storage.local.get({ [ACTIVITY_KEY]: [] }, (r) => {
        const log = [entry, ...r[ACTIVITY_KEY]].slice(0, ACTIVITY_MAX);
        chrome.storage.local.set({ [ACTIVITY_KEY]: log });
    });
}

const isRule = (v) => v && typeof v === "object" && Array.isArray(v.detectors);

/** Re-fetch every rule list now and report what came back, for the "Update rules now" status line. */
async function forceRuleUpdate() {
    const ruleLists = await GDPRConfig.getRuleLists();
    const cachedEntries = {};
    const lists = [];
    let total = 0;
    for (const url of ruleLists) {
        const theList = await fetchRulesList(url);
        if (theList == null) { lists.push({ url, ok: false, rules: 0 }); continue; }
        const rules = Object.values(theList).filter(isRule).length;
        cachedEntries[url] = { timestamp: Date.now() / 1000, rules: theList };
        lists.push({ url, ok: true, rules });
        total += rules;
    }
    // Keep the old cache for lists that failed to fetch; replace the rest.
    const old = await new Promise((r) => chrome.storage.local.get({ cachedEntries: {} }, (v) => r(v.cachedEntries)));
    for (const l of lists) if (!l.ok && old[l.url]) cachedEntries[l.url] = old[l.url];
    await new Promise((r) => chrome.storage.local.set({ cachedEntries }, r));
    const custom = Object.keys(await GDPRConfig.getCustomRuleLists()).length;
    return { lists, total, custom };
}

let tabStatusMap = new Map();

chrome.tabs.onUpdated.addListener((tabId, info, tab)=>{
    if(info.status != null && info.status === "Loading") {
        setBadgeCheckmark("", tabId);
        tabStatusMap.set(tabId, STATUS.INIT);
    }
});

async function fetchRulesList(ruleList) {
    try {

        let response = await fetch(ruleList, { cache: "no-store" });
        let theList = await response.json();

        let theMergedList = Object.assign({}, theList);
        delete theMergedList.references;

        //If references is present, fetch those and merge into big json object
        if(theList.references != null) {
            let promises = [];
            for(let ref of theList.references) {
                promises.push(fetchRulesList(ref));
            }

            let lists = await Promise.all(promises);

            lists.forEach((list) => {
                Object.assign(theMergedList, list);
            });
        }

        return theMergedList;

    } catch (e) {
        console.warn("Error fetching rulelist: ", ruleList, e.message);
    }

    return null;
}

// Show onboarding page on first load 
GDPRConfig.getDebugValues().then((config)=>{
    if (config.autoOpenOptionsTab){
        config.autoOpenOptionsTab = false;
        GDPRConfig.setDebugValues(config);
        chrome.tabs.create({ url: chrome.runtime.getURL("options.html") }, function (tab) {
            console.log("Launched initial onboarding page");
        });
    }
})


// Back up custom rules automatically whenever they change (local snapshot + online targets).
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.customRuleLists) {
        scheduleBackup();
    }
});

// Catch up on anything not yet pushed (failed earlier, or changed while offline). No-op when unchanged.
pushRemote().catch((e) => console.warn("Online backup failed:", e.message));
dropGistConfig().catch((e) => console.warn("Could not clear old gist settings:", e.message));


// Seed the custom rules bundled with the extension (custom-rules.json) into storage, once per bundle version.
const BUNDLED_RULES_VERSION = 2; // 2: google_cwiz override with a working hide step
(async () => {
    try {
        const bundled = await (await fetch(chrome.runtime.getURL("custom-rules.json"))).json();
        await seedBundledRules(bundled, BUNDLED_RULES_VERSION);
    } catch (e) {
        console.warn("Could not seed bundled custom rules:", e.message);
    }
})();
