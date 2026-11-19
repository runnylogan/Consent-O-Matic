import GDPRConfig from "./GDPRConfig.js";
import ConsentEngine from "./ConsentEngine.js";
import { runDiscovery, startTeach } from "./DiscoveryRunner.js";

async function contentScriptRunner() {
    if (document.contentType!=="text/html") return;

    // Figure out the URL
    let url = location.href;
    let insideIframe = window !== window.parent;
    if(insideIframe) {
        //We are inside an iframe, request the actual tab url to check if we are active
        url = await new Promise((resolve, reject)=>{
            chrome.runtime.sendMessage("GetTabUrl", (response)=>{
                resolve(response);
            });
        });
    }
    const urlObj = new URL(url);
    url = urlObj.host;

    GDPRConfig.isActive(url).then(async (active) => {
        if (active) {
            chrome.runtime.sendMessage("GetRuleList", (fetchedRules)=>{
                if (!fetchedRules) {
                    console.log("Failed to connect with service worker for getRuleList msg", fetchedRules);
                } else {
                    GDPRConfig.getCustomRuleLists().then((customRules)=>{
                        fetchedRules.forEach((ruleObj)=>{
                            delete ruleObj["$schema"];
                        });
                        delete customRules["$schema"];
        
                        // Concat rule-lists to engine config in order
                        let config = Object.assign({}, ...fetchedRules, customRules);
        
                        GDPRConfig.getConsentValues().then((consentTypes)=>{
                            GDPRConfig.getDebugValues().then((debugValues)=>{
                                GDPRConfig.getGeneralSettings().then((generalSettings)=>{
                                    if(debugValues.debugLog) {
                                        console.log("FetchedRules:", fetchedRules);
                                        console.log("CustomRules:", customRules);
                                    }
                    
                                    ConsentEngine.debugValues = debugValues;
                                    ConsentEngine.generalSettings = generalSettings;
                                    ConsentEngine.topFrameUrl = url;
            
                                    chrome.runtime.sendMessage("Searching");
                                    let handledAny = false;
                                    const handledCallback = (evt)=>{
                                        let result = {
                                            "handled": evt.handled
                                        };
    
                                        if(evt.handled) {
                                            handledAny = true;
                                            result.cmp = evt.cmpName;
                                            result.clicks = evt.clicks;
                                            result.url = url;
                                            result.source = Object.prototype.hasOwnProperty.call(customRules, evt.cmpName) ? "custom rule" : "downloaded list";
                                            result.consentTypes = consentTypes;
        
                                            chrome.runtime.sendMessage("HandledCMP|"+JSON.stringify(result));
                                        } else {
                                            chrome.runtime.sendMessage(evt.error ? "CMPError" : "NothingFound");
                                            // A known CMP can be recognised and still fail to clear the banner (Tesco's OneTrust is one):
                                            // discovery then waits and only steps in if the banner is still on screen and nothing handled it.
                                            const engineSawCMP = !!(ConsentEngine.singleton && ConsentEngine.singleton.triedCMPs.size > 0);
                                            if (window === window.parent) {
                                                runDiscovery({
                                                    host: urlObj.hostname,
                                                    consentTypes,
                                                    generalSettings,
                                                    onHandled: handledCallback,
                                                    engineSawCMP,
                                                    wasHandled: () => handledAny
                                                }).catch((e) => console.error("Discovery failed:", e));
                                            }
                                        }
                                    };
                                    let engine = new ConsentEngine(config, consentTypes, handledCallback);
            
                                    ConsentEngine.singleton = engine;

                                    if (window === window.parent) {
                                        chrome.runtime.onMessage.addListener((message) => {
                                            if (message === "StartTeach") {
                                                startTeach({ host: urlObj.hostname, consentTypes, generalSettings, onHandled: handledCallback })
                                                    .catch((e) => console.error("Teach mode failed:", e));
                                            }
                                        });
                                    }
            
                                    if(debugValues.debugLog) {
                                        console.log("ConsentEngine loaded " + engine.cmps.length + " of " + Object.keys(config).length + " rules");
                                    }
                                });
                            });
                        });
                    });
                }
            });
        }
    });
}

window.consentScrollBehaviours = {};
function getCalculatedStyles() {
    ["html","html body"].forEach(element=>{
        let node = document.querySelector(element);
        if (node) {
            let styles = window.getComputedStyle(node);
            window.consentScrollBehaviours[element+".consent-scrollbehaviour-override"] = ["position","overflow","overflow-y"].map(property=>{
                return {property:property, value:styles[property]}
            });
        }
    });
}

// Observe styles in order to temporarily restore them if a popup kills them
let topContentTag = document.querySelector("html");
if (topContentTag){
    let observer = new MutationObserver((mutations)=>{
        mutations.forEach((mutation)=>{
            mutation.addedNodes.forEach((node)=>{
                if(node.matches != null && node.matches("body")) {
                    getCalculatedStyles();
                    observer.disconnect();
                }
            })
        });
    });

    observer.observe(topContentTag, {
        childList: true
    });
}
window.addEventListener("message", (event)=>{
    try {
        if(event.data?.enforceScrollBehaviours != null) {
            ConsentEngine.enforceScrollBehaviours(event.data.enforceScrollBehaviours);
        }
    }catch(e) {
        console.error("Error inside message listener:", e);
    }
});

contentScriptRunner().catch((e)=>{
    console.error(e);
});
