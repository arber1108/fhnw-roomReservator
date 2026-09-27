import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import dayjs from "dayjs";
import { DATA_DIR, ensureDataDir } from "./paths.js";
import type { BookingNotice, Contact, NotifySettings } from "./types.js";

const SETTINGS_FILE = path.join(DATA_DIR, "notify.json");
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function loadNotifySettings(): NotifySettings {
  if (!fs.existsSync(SETTINGS_FILE)) return { contacts: [] };
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")) as Partial<NotifySettings>;
    return { teamsWebhookUrl: data.teamsWebhookUrl, contacts: data.contacts ?? [] };
  } catch {
    // Don't fall back to empty settings: the next save would wipe the contacts.
    throw new Error(`Invalid notification settings in ${SETTINGS_FILE}; fix or delete the file`);
  }
}

export function saveNotifySettings(settings: NotifySettings): void {
  ensureDataDir();
  // Anyone holding the webhook URL can post into the chat, so keep the file owner-only.
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.chmodSync(SETTINGS_FILE, 0o600);
}

export function validateWebhookUrl(value: string): true | string {
  try {
    return new URL(value.trim()).protocol === "https:" ? true : "The URL must start with https://";
  } catch {
    return "Paste the full URL from the Teams Workflows setup";
  }
}

export function validateContactEmail(value: string, contacts: Contact[]): true | string {
  const email = value.trim();
  if (!EMAIL_PATTERN.test(email)) return "Enter a valid email address";
  if (contacts.some((c) => c.email.toLowerCase() === email.toLowerCase())) {
    return "This contact already exists";
  }
  return true;
}

/** Lines of the booking message, used for both the Teams card and the chat-link fallback. */
export function formatBookingLines(b: BookingNotice): string[] {
  // TODO(you): decide what your friends see — wording, language, which fields,
  // and what to say when b.reservationId is 0 (ID unknown).
  const where = [b.building, b.floor].filter(Boolean).join(", ");
  return [
    where ? `${b.room} (${where})` : b.room,
    `${dayjs(b.from).format("dd DD.MM.YYYY HH:mm")} – ${dayjs(b.to).format("HH:mm")}`,
  ];
}

/** One section per booking; sections are separated by a line in the card. */
function buildAdaptiveCardMessage(title: string, sections: string[][]) {
  // Payload shape expected by the Teams Workflows "webhook alerts to a chat" template.
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true },
            ...sections.flatMap((lines) =>
              lines.map((text, i) => ({
                type: "TextBlock",
                text,
                wrap: true,
                ...(i === 0 ? { spacing: "Medium", separator: true } : { spacing: "Small" }),
              }))
            ),
          ],
        },
      },
    ],
  };
}

export async function postToTeams(webhookUrl: string, title: string, sections: string[][]): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildAdaptiveCardMessage(title, sections)),
    signal: AbortSignal.timeout(15_000),
  });
  // Workflows answers 202 Accepted; the message shows up in the chat a few seconds later.
  // The URL is a secret, so it is deliberately left out of the error.
  if (!res.ok) throw new Error(`Teams webhook failed (${res.status})`);
}

export function buildTeamsChatLink(emails: string[], message: string): string {
  const users = emails.map(encodeURIComponent).join(",");
  return `https://teams.microsoft.com/l/chat/0/0?users=${users}&message=${encodeURIComponent(message)}`;
}

export function openUrl(url: string): Promise<void> {
  // rundll32 avoids cmd.exe, which would split the URL at every "&".
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
