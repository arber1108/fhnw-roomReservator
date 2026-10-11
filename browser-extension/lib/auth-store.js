// The token lives in chrome.storage.session: kept in memory only and cleared
// when the browser closes. The SSO cookies in the browser make re-capturing it cheap.
import { authStateFromHeader, isAuthValid } from "./token.js";

const AUTH_KEY = "auth";
const LOGIN_TAB_KEY = "loginTabId";

export async function getAuth() {
  const { [AUTH_KEY]: auth } = await chrome.storage.session.get(AUTH_KEY);
  return isAuthValid(auth) ? auth : null;
}

export async function saveAuthHeader(clxAuthorization) {
  const { [AUTH_KEY]: current } = await chrome.storage.session.get(AUTH_KEY);
  if (current?.clxAuthorization === clxAuthorization) return;
  await chrome.storage.session.set({ [AUTH_KEY]: authStateFromHeader(clxAuthorization) });
}

export async function clearAuth() {
  await chrome.storage.session.remove(AUTH_KEY);
}

export function onAuthChanged(listener) {
  chrome.storage.session.onChanged.addListener((changes) => {
    if (AUTH_KEY in changes) listener();
  });
}

export async function getLoginTabId() {
  const { [LOGIN_TAB_KEY]: tabId } = await chrome.storage.session.get(LOGIN_TAB_KEY);
  return tabId ?? null;
}

export async function setLoginTabId(tabId) {
  if (tabId === null) await chrome.storage.session.remove(LOGIN_TAB_KEY);
  else await chrome.storage.session.set({ [LOGIN_TAB_KEY]: tabId });
}
