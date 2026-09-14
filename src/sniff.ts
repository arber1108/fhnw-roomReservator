import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

const LOG_DIR = path.join(
  process.env.APPDATA || path.join(process.env.HOME || ".", ".config"),
  "roomreservator"
);

async function sniff() {
  console.log("\n🔍 API Sniffer — opening raum.fhnw.ch");
  console.log("   Log in and use the webapp normally.");
  console.log("   All API calls to eviapi.fhnw.ch will be captured.");
  console.log("   Close the browser window when done.\n");

  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, "api-log.json");
  const entries: any[] = [];

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on("request", (request) => {
    const url = request.url();
    if (!url.includes("eviapi.fhnw.ch")) return;

    const entry: any = {
      timestamp: new Date().toISOString(),
      method: request.method(),
      url,
      headers: request.headers(),
    };

    const postData = request.postData();
    if (postData) {
      try {
        entry.body = JSON.parse(postData);
      } catch {
        entry.body = postData;
      }
    }

    entries.push(entry);
    console.log(`  → ${request.method()} ${url}`);
  });

  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("eviapi.fhnw.ch")) return;

    const entry = entries.find((e) => e.url === url && !e.status);
    if (!entry) return;

    entry.status = response.status();
    try {
      const body = await response.json();
      entry.response = body;
      const preview = JSON.stringify(body).slice(0, 200);
      console.log(`  ← ${response.status()} ${url}`);
      console.log(`    ${preview}...`);
    } catch {
      entry.response = await response.text().catch(() => "(binary)");
    }
  });

  await page.goto("https://raum.fhnw.ch");

  page.on("close", () => {});
  await new Promise<void>((resolve) => {
    browser.on("disconnected", () => resolve());
  });

  fs.writeFileSync(logFile, JSON.stringify(entries, null, 2));
  console.log(`\n✅ Captured ${entries.length} API calls → ${logFile}\n`);
}

sniff().catch(console.error);
