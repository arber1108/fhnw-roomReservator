// Captures the API token the way the CLI does (src/auth.ts): watch raum.fhnw.ch
// call eviapi.fhnw.ch and keep its clx-authorization header.
import { getLoginTabId, saveAuthHeader, setLoginTabId } from "./lib/auth-store.js";
import { installHeaderRule } from "./lib/header-rule.js";

const WEB_APP_ORIGIN = "https://raum.fhnw.ch";

chrome.runtime.onInstalled.addListener(() => void installHeaderRule());
chrome.runtime.onStartup.addListener(() => void installHeaderRule());

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    // Only the web app's own requests; the extension's requests carry a copy of the token.
    if (details.initiator !== WEB_APP_ORIGIN) return;
    const header = details.requestHeaders?.find((h) => h.name.toLowerCase() === "clx-authorization");
    if (!header?.value) return;
    void captureToken(header.value, details.tabId);
  },
  { urls: ["https://eviapi.fhnw.ch/*"] },
  ["requestHeaders"]
);

async function captureToken(clxAuthorization, tabId) {
  await saveAuthHeader(clxAuthorization);
  // Close the tab the popup opened for signing in, as the CLI closes its browser.
  const loginTabId = await getLoginTabId();
  if (loginTabId !== null && loginTabId === tabId) {
    await setLoginTabId(null);
    await chrome.tabs.remove(tabId).catch(() => {});
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await getLoginTabId()) === tabId) await setLoginTabId(null);
});
