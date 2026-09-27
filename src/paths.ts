import * as fs from "fs";
import * as path from "path";

export const DATA_DIR = path.join(
  process.env.APPDATA || path.join(process.env.HOME || ".", ".config"),
  "roomreservator"
);

export function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
