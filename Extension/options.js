import GDPRConfig from './GDPRConfig.js';
import Language from './Language.js';
import { buildBackup, applyBackup, listSnapshots, getRemote, setRemote, pushRemote, restoreRemote, getRemoteStatus } from './Backup.js';

let optionsUL = document.querySelector(".configurator ul.categorylist");
if (optionsUL){
    let ruleUL = document.querySelector(".configurator .tab_rl .rulelist");
    let debugUL = document.querySelector(".configurator .tab_dbg ul.flags");
    let aboutTable = document.querySelector(".configurator .tab_about table.logList");

    optionsUL.innerHTML = "";

    let menuTabs = document.querySelectorAll(".header .menuitem");

    menuTabs.forEach((menuTab) => {
        menuTab.addEventListener("click", (evt)=>{
            tabChanged(menuTab);
        });

        menuTab.addEventListener("keydown", (evt)=> {
            console.log(evt.code);

            let newTab = null;

            if(evt.code === "ArrowRight") {
                newTab = menuTab.nextElementSibling;
                if(newTab == null) {
                    newTab = menuTabs[0];
                }
            } else if(evt.code === "ArrowLeft") {
                newTab = menuTab.previousElementSibling;
                if(newTab == null) {
                    newTab = menuTabs[menuTabs.length - 1];
                }
            }
            if(newTab != null) {
                tabChanged(newTab);
            }
        });
    });

    GDPRConfig.getGeneralSettings().then((generalSettings)=>{
        let hideOrPipForm = document.querySelector("#generalTab #hideOrPip");
        let hideOrPipRadioGroup = hideOrPipForm.elements["hideOrPip"];
        if(generalSettings.hideInsteadOfPIP) {
            hideOrPipRadioGroup.value = "hide";
        } else {
            hideOrPipRadioGroup.value = "pip";
        }

        const discoveryInput = document.querySelector("#discoveryEnabled");
        discoveryInput.checked = generalSettings.discoveryEnabled !== false;

        function saveGeneralSettings() {
            const newGeneralSettings = Object.assign({}, generalSettings, {
                hideInsteadOfPIP: hideOrPipRadioGroup.value === "hide",
                discoveryEnabled: discoveryInput.checked
            });

            GDPRConfig.setGeneralSettings(newGeneralSettings);
        }

        hideOrPipForm.addEventListener("input", ()=>{
            saveGeneralSettings();
        });
    });

    let consentPromise = GDPRConfig.getConsentTypes().then((consentTypes) => {
        consentTypes.forEach((consentType) => {
            addToggleItem(optionsUL, consentType.type, Language.getString(consentType.name), Language.getString(consentType.description), consentType.value);
        });
    });

    let debugPromise = GDPRConfig.getDebugFlags().then((debugFlags) => {
        debugFlags.forEach((debugFlag) => {
            let optionLi = addToggleItem(debugUL, debugFlag.name, debugFlag.name, debugFlag.description, debugFlag.value);
            let input = optionLi.querySelector("input");
            input.addEventListener("input", function (evt) {
                if (this.checked) {
                    this.parentNode.parentNode.classList.add("active");
                } else {
                    this.parentNode.parentNode.classList.remove("active");
                }
                saveSettings();
            });

            if(input.checked) {
                optionLi.classList.add("active");
            }
        });
    });

    document.querySelector("#clearDebugFlags").addEventListener("click", ()=>{
        GDPRConfig.setDebugValues({}).then(()=>{
            GDPRConfig.getDebugFlags().then((debugFlags)=>{
                debugFlags.forEach((debugFlag)=>{
                    let optionLi = document.querySelector("ul.flags li[data-name='"+debugFlag.name+"']");
                    let input = optionLi.querySelector("input");
                    input.checked = debugFlag.value;
                    if(!debugFlag.value) {
                        optionLi.classList.remove("active");
                    }
                });
            });
        })
    })

    function uuidv4() {
        return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
        );
    }

    function addToggleItem(parent, type, name, description, isChecked) {
        let optionLI = document.createElement("li");
        optionLI.setAttribute("data-name", name);

        let uuid = uuidv4();        

        const optionHtml = `
            <label class="slider" for="${type}">
                    <input type="checkbox" id="${type}" ${isChecked ? "checked" : ""}>
                    <div class="knob" role="checkbox" aria-checked="${isChecked ? "true" : "false"}" tabindex="0" aria-labelledby="${uuid}"></div>
            </label>
            <h2 id=${uuid}>${name}</h2>
            <div class="category_description">
    ${description}
            </div>`;

        let parser = new DOMParser();
        let parsed = parser.parseFromString(optionHtml, "text/html");
        let children = parsed.querySelector("body");

        for (let child of children.childNodes) {
            optionLI.appendChild(child);
        }

        function toggleInput() {
            let input = optionLI.querySelector("input");
            input.checked = !input.checked;
            optionLI.querySelector(".knob").setAttribute("aria-checked", ""+input.checked);
            if (input.checked) {
                optionLI.classList.add("active");
            } else {
                optionLI.classList.remove("active");
            }
            saveSettings();
        }

        parent.appendChild(optionLI);
        optionLI.addEventListener("click", function (evt) {
            toggleInput();
            evt.stopPropagation();
        });
        optionLI.addEventListener("keydown", function (evt) {
            if(evt.code === "Space") {
                toggleInput();
                evt.stopPropagation();
            }
        });
        Language.doLanguage(optionLI);
        return optionLI;
    }

    function updateRuleList() {
        GDPRConfig.getRuleLists().then((ruleLists) => {
            ruleUL.innerHTML = "";
            ruleLists.forEach((ruleList) => {
                let optionLI = document.createElement("li");
                let button = document.createElement("button");
                let link = document.createElement("a");
                link.href = ruleList;
                link.innerText = ruleList;
                button.innerText = "X";
                optionLI.appendChild(button);
                optionLI.appendChild(link);
                ruleUL.appendChild(optionLI);

                button.addEventListener("click", function () {
                    GDPRConfig.removeRuleList(ruleList).then(() => {
                        updateRuleList();
                    });
                });
            });
        });
    }

    updateRuleList();

    // ---- Custom rules list ----
    function renderCustomRules() {
        chrome.runtime.sendMessage("GetCustomRuleList", (rules) => {
            const list = document.querySelector("#customRuleList");
            list.innerHTML = "";
            const names = Object.keys(rules || {}).filter((n) => n !== "$schema").sort();
            document.querySelector("#customCount").textContent = names.length ? "(" + names.length + ")" : "";
            if (names.length === 0) {
                const li = document.createElement("li");
                li.className = "empty";
                li.textContent = "None yet. They appear here when the extension generates or you teach a rule.";
                list.appendChild(li);
                return;
            }
            names.forEach((name) => {
                const li = document.createElement("li");
                const button = document.createElement("button");
                button.textContent = "X";
                button.title = "Delete " + name;
                button.setAttribute("aria-label", "Delete " + name);
                const label = document.createElement("span");
                label.textContent = name;
                li.append(button, label);
                list.appendChild(li);
                button.addEventListener("click", () => {
                    if (!confirm("Delete the rule \u201c" + name + "\u201d? It stays in your local history and GitHub backups.")) return;
                    chrome.runtime.sendMessage("DeleteCustomRule|" + name, () => renderCustomRules());
                });
            });
        });
    }
    renderCustomRules();
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.customRuleLists) renderCustomRules();
    });

    document.querySelector("#urladd").addEventListener("click", function (evt) {
        let ruleList = document.querySelector("#newurl").value;
        document.querySelector("#newurl").value = "";
        GDPRConfig.addRuleList(ruleList).then(() => {
            updateRuleList();
        });
    });

    document.querySelector("#forceupdate").addEventListener("click", () => {
        const status = document.querySelector("#updateStatus");
        const setStatus = (text, ok = true) => { status.textContent = text; status.classList.toggle("error", !ok); };
        setStatus("Updating rules…");
        chrome.runtime.sendMessage("ForceRuleUpdate", (res) => {
            if (chrome.runtime.lastError || !res) { setStatus("Update failed: " + (chrome.runtime.lastError ? chrome.runtime.lastError.message : "no response"), false); return; }
            const failed = res.lists.filter((l) => !l.ok);
            const n = (x, w) => x + " " + w + (x === 1 ? "" : "s");
            let text = "Updated " + n(res.lists.length - failed.length, "rule list") + ": " + n(res.total, "rule") + " loaded, plus " + n(res.custom, "custom rule") + ".";
            if (failed.length) text += " Failed to fetch " + failed.map((l) => l.url).join(", ") + " (kept the previous copy if there was one).";
            setStatus(text, failed.length === 0);
        });
    });

    // ---- Backup & restore ----
    const backupStatus = document.querySelector("#backupStatus");
    function setBackupStatus(text, ok = true) {
        backupStatus.textContent = text;
        backupStatus.classList.toggle("error", !ok);
    }

    async function renderSnapshots() {
        const list = document.querySelector("#snapshotList");
        list.innerHTML = "";
        const snaps = await listSnapshots();
        if (snaps.length === 0) {
            const li = document.createElement("li");
            li.className = "empty";
            li.textContent = "No snapshots yet. One is taken each time your custom rules change.";
            list.appendChild(li);
            return;
        }
        snaps.forEach((snap) => {
            const li = document.createElement("li");
            const label = document.createElement("span");
            label.textContent = new Date(snap.id).toLocaleString("en-GB") + " · " + snap.ruleCount + " rule" + (snap.ruleCount === 1 ? "" : "s");
            const btn = document.createElement("button");
            btn.textContent = "Restore";
            btn.className = "ghost";
            btn.addEventListener("click", async () => {
                try {
                    const n = await applyBackup(snap.backup, document.querySelector("#backupReplace").checked ? "replace" : "merge");
                    setBackupStatus("Restored " + n + " rule" + (n === 1 ? "" : "s") + " from snapshot.");
                    renderSnapshots();
                } catch (e) { setBackupStatus("Restore failed: " + e.message, false); }
            });
            li.append(label, btn);
            list.appendChild(li);
        });
    }

    document.querySelector("#backupExport").addEventListener("click", async () => {
        const backup = await buildBackup();
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "consent-o-matic-backup-" + new Date().toISOString().slice(0, 10) + ".json";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        setBackupStatus("Exported " + Object.keys(backup.customRuleLists).length + " custom rule(s).");
    });

    document.querySelector("#backupFile").addEventListener("change", async (evt) => {
        const file = evt.target.files[0];
        evt.target.value = "";
        if (!file) return;
        try {
            const obj = JSON.parse(await file.text());
            const n = await applyBackup(obj, document.querySelector("#backupReplace").checked ? "replace" : "merge");
            setBackupStatus("Restored " + n + " rule" + (n === 1 ? "" : "s") + " from " + file.name + ".");
            renderSnapshots();
        } catch (e) {
            setBackupStatus("Restore failed: " + e.message, false);
        }
    });

    renderSnapshots();

    // ---- Online backup settings ----
    const remoteStatus = document.querySelector("#remoteStatus");
    function setRemoteStatus(text, ok = true) {
        remoteStatus.textContent = text;
        remoteStatus.classList.toggle("error", !ok);
    }
    const field = (id) => document.querySelector("#" + id);
    let hasToken = false;

    async function loadRemote() {
        const cfg = await getRemote();
        field("remoteRepo").value = cfg.repo;
        field("remoteBranch").value = cfg.branch;
        field("remoteDir").value = cfg.dir;
        field("remoteEnabled").checked = cfg.enabled;
        hasToken = Boolean(cfg.token);
        field("remoteToken").placeholder = hasToken ? "Saved (leave blank to keep)" : "github_pat_…";
        const status = await getRemoteStatus();
        if (status) setRemoteStatus((status.ok ? "Last backup: " : "Last attempt failed: ") + status.message + " · " + new Date(status.time).toLocaleString("en-GB"), status.ok);
    }

    async function saveRemote() {
        const update = {
            repo: field("remoteRepo").value,
            branch: field("remoteBranch").value,
            dir: field("remoteDir").value,
            enabled: field("remoteEnabled").checked
        };
        if (field("remoteToken").value) update.token = field("remoteToken").value.trim();
        await setRemote(update);
        field("remoteToken").value = "";
        await loadRemote();
    }

    field("remoteForm").addEventListener("submit", async (evt) => {
        evt.preventDefault();
        try { await saveRemote(); setRemoteStatus("Saved."); } catch (e) { setRemoteStatus(e.message, false); }
    });
    field("remotePush").addEventListener("click", async () => {
        try {
            await saveRemote();
            setRemoteStatus("Backing up…");
            const result = await pushRemote({ force: true });
            await loadRemote();
            if (result === "skipped") setRemoteStatus("Nothing to back up: tick “Push automatically”, fill in the repository and token, and have at least one custom rule.", false);
        } catch (e) { setRemoteStatus(e.message, false); }
    });
    field("remoteRestore").addEventListener("click", async () => {
        try {
            await saveRemote();
            setRemoteStatus("Restoring…");
            const n = await restoreRemote(field("backupReplace").checked ? "replace" : "merge");
            setBackupStatus("Restored " + n + " rule" + (n === 1 ? "" : "s") + " from the repository.");
            setRemoteStatus("Restored " + n + " rule" + (n === 1 ? "" : "s") + " from the repository.");
            renderSnapshots();
        } catch (e) { setRemoteStatus(e.message, false); }
    });
    loadRemote();

    function tabChanged(target) {
        let oldTab = document.querySelector(".header .menuitem[tabindex='0']");
        if(oldTab != null) {
            oldTab.setAttribute("tabindex", -1);
        }

        menuTabs.forEach((item) => {
            item.classList.remove("active");
            item.setAttribute("aria-selected", false);
        });
        document.querySelectorAll(".tab").forEach((item) => {
            item.style.display = "none";
        });
        target.classList.add("active");
        target.setAttribute("aria-selected", true);
        target.setAttribute("tabindex", 0);

        document.querySelectorAll(".configurator .tab").forEach((tab)=>{
            tab.style.display = "none";
        });

        document.getElementById(target.getAttribute("aria-controls")).style.display = "block";

        target.focus();

        updateLog();
    }

    function saveSettings() {
        let consentValues = {};
        optionsUL.querySelectorAll("li input").forEach((input) => {
            consentValues[input.id] = input.checked;
        });
        GDPRConfig.setConsentValues(consentValues);

        let debugFlags = {};
        debugUL.querySelectorAll("li input").forEach((input) => {
            debugFlags[input.id] = input.checked;
        });
        GDPRConfig.setDebugValues(debugFlags);
    }

    function updateLog() {
        aboutTable.querySelectorAll("tr:not(:first-child)").forEach((el) => {
            el.remove();
        });
        GDPRConfig.getStatistics().then((entries) => {
            document.querySelector("#clicks").innerText = entries.clicks;

            for (const [cmp, stats] of Object.entries(entries.cmps)) {
                let tr = document.createElement("tr");
                let cell = document.createElement("th");
                cell.innerText = cmp;
                tr.appendChild(cell);
                cell = document.createElement("td");
                cell.innerText = stats.filledForms;
                tr.appendChild(cell);
                cell = document.createElement("td");
                cell.innerText = stats.clicks;
                tr.appendChild(cell);
                aboutTable.append(tr);
            }
        });
    }


    document.querySelector("#clearLog").addEventListener("click", () => {
        GDPRConfig.setStatistics({
            clicks: 0,
            cmps: {}
        }).then(() => {
            updateLog();
        });
    });

    document.querySelector("#rulesEditor").addEventListener("click", () => {
        location.href = "/editor.html";
    });

    // Check if we need to show the onboarding permissions panel
    let permAPI = (typeof browser!="undefined")?browser.permissions:chrome.permissions;
    if (permAPI){
        document.querySelector("#permissions button").addEventListener("click", ()=>{
            permAPI.request({
                "origins": [
                    "<all_urls>"
                ]
            }).then(()=>{
                attemptPermissions();
                document.querySelector("#failedpermissions").style.display = "block";
            });
        });

        function attemptPermissions(){
            permAPI.getAll().then((grantedPermissions)=>{
                console.log(grantedPermissions);
                if ((!grantedPermissions) || (!grantedPermissions.origins) || (!grantedPermissions.permissions)
                    || ((!grantedPermissions.origins.includes("<all_urls>")) && (!grantedPermissions.origins.includes("*://*/*")))
                    || (!grantedPermissions.permissions.includes("tabs"))
                    || (!grantedPermissions.permissions.includes("activeTab"))
                    || (!grantedPermissions.permissions.includes("storage"))
                ){
                    document.querySelector("#permissions").style.display = "block";
                    setTimeout(attemptPermissions, 1500);
                } else {
                    document.querySelector("#permissions").style.display = "none";
                }
            });
        }

        attemptPermissions();
    }

    Language.doLanguage();
}


