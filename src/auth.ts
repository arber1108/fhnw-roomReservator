import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";
import type { AuthState } from "./types.js";

const DATA_DIR = path.join(
  process.env.APPDATA || path.join(process.env.HOME || ".", ".config"),
  "roomreservator"
);
const AUTH_FILE = path.join(DATA_DIR, "auth.json");
const SESSION_FILE = path.join(DATA_DIR, "browser-session.json");
const API_HOST = "eviapi.fhnw.ch";

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadCachedToken(): AuthState | null {
  try {
    if (!fs.existsSync(AUTH_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8")) as AuthState;
    if (data.expiresAt < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function saveToken(state: AuthState) {
  ensureDir();
  fs.writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2));
}

function hasSavedSession(): boolean {
  return fs.existsSync(SESSION_FILE);
}

async function loginWithBrowser(forceInteractive: boolean): Promise<AuthState> {
  const hasSession = !forceInteractive && hasSavedSession();

  if (hasSession) {
    console.log("  Refreshing token from saved session...");
  } else {
    console.log(
      "\n  Opening browser for FHNW login...\n" +
      "  Log in with your FHNW credentials.\n"
    );
  }

  const browser = await chromium.launch({ headless: hasSession });
  const context = await browser.newContext(
    hasSession ? { storageState: SESSION_FILE } : undefined
  );
  const page = await context.newPage();

  let clxAuth = "";

  page.on("request", (request) => {
    if (!request.url().includes(API_HOST)) return;
    const header = request.headers()["clx-authorization"];
    if (header) clxAuth = header;
  });

  await page.goto("https://raum.fhnw.ch");

  try {
    // Wait for an API call with auth header — means we're logged in
    await page.waitForRequest(
      (req) => {
        if (!req.url().includes(API_HOST)) return false;
        const h = req.headers()["clx-authorization"];
        if (h) { clxAuth = h; return true; }
        return false;
      },
      { timeout: hasSession ? 15_000 : 120_000 }
    );
  } catch {
    if (hasSession) {
      // SSO session expired — retry interactively
      await browser.close();
      console.log("  Session expired, need fresh login.");
      return loginWithBrowser(true);
    }
    throw new Error("Login timed out");
  }

  await page.waitForTimeout(1000);

  // Save browser state (SSO cookies) for next time
  ensureDir();
  await context.storageState({ path: SESSION_FILE });

  await browser.close();

  let expiresAt = Date.now() + 600_000;
  try {
    const tokenMatch = clxAuth.match(/access_token=([^,\s]+)/);
    if (tokenMatch) {
      const payload = JSON.parse(
        Buffer.from(tokenMatch[1]!.split(".")[1]!, "base64").toString()
      );
      if (payload.exp) expiresAt = payload.exp * 1000;
    }
  } catch {}

  const authState: AuthState = { clxAuthorization: clxAuth, expiresAt };
  saveToken(authState);

  if (hasSession) {
    console.log("  Token refreshed!\n");
  } else {
    console.log("  Login successful! Session saved for next time.\n");
  }

  return authState;
}

export async function authenticate(forceLogin = false): Promise<AuthState> {
  if (!forceLogin) {
    const cached = loadCachedToken();
    if (cached) return cached;
  }
  return loginWithBrowser(forceLogin);
}

export function buildHeaders(auth: AuthState): Record<string, string> {
  return {
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
    "clx-authorization": auth.clxAuthorization,
    "referer": "https://raum.fhnw.ch/",
  };
}
