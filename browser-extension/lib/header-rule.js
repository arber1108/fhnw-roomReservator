const RULE_ID = 1;

/**
 * The CLI sends `referer: https://raum.fhnw.ch/`. Browsers forbid setting Referer
 * and Origin from fetch(), so a session rule sets them on the extension's own
 * requests to the Evento API, making them look like the CLI's and the web app's.
 */
export async function installHeaderRule() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_ID],
    addRules: [{
      id: RULE_ID,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "origin", operation: "set", value: "https://raum.fhnw.ch" },
          { header: "referer", operation: "set", value: "https://raum.fhnw.ch/" },
        ],
      },
      condition: {
        requestDomains: ["eviapi.fhnw.ch"],
        initiatorDomains: [chrome.runtime.id],
      },
    }],
  });
}
