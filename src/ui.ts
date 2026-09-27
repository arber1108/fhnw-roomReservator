import { select as inquirerSelect, input, confirm, password, checkbox } from "@inquirer/prompts";
import Table from "cli-table3";
import dayjs from "dayjs";
import { SITES } from "./locations.js";
import { validateContactEmail, validateWebhookUrl } from "./notify.js";
import type { AvailableRoom, BookingNotice, Contact, NotifySettings, Reservation, Site } from "./types.js";

type Action = "reserve" | "my-reservations" | "share" | "notifications" | "exit";

type NotifyAction =
  | "set-webhook"
  | "test-webhook"
  | "remove-webhook"
  | "add-contact"
  | "remove-contact"
  | "back";

type EndParseResult = { end: Date } | { error: string };

type SelectChoice<Value> =
  | Value
  | {
      value: Value;
      name?: string;
      description?: string;
      short?: string;
      disabled?: boolean | string;
    };

type SelectConfig<Value> = {
  message: string;
  choices: ReadonlyArray<SelectChoice<Value>>;
  pageSize?: number;
  loop?: boolean;
  default?: Value;
};

/** Adds W/S navigation to Inquirer's select prompt without changing text inputs. */
async function select<Value>(config: SelectConfig<Value>): Promise<Value> {
  const mapWsToArrows = (
    _character: string | undefined,
    key: { name?: string }
  ): void => {
    if (key.name !== "w" && key.name !== "s") return;

    process.stdin.emit("keypress", undefined, {
      ...key,
      name: key.name === "w" ? "up" : "down",
    });
  };

  process.stdin.prependListener("keypress", mapWsToArrows);
  try {
    return await inquirerSelect({
      ...config,
      theme: {
        style: {
          keysHelpTip: () => "↑↓ / w s navigate • ⏎ select",
        },
      },
    });
  } finally {
    process.stdin.removeListener("keypress", mapWsToArrows);
  }
}

function parseEndTimeOrDuration(value: string, start: Date): EndParseResult {
  const input = value.trim();
  const endTimeMatch = /^(\d{2}):(\d{2})$/.exec(input);

  if (endTimeMatch) {
    const hours = Number(endTimeMatch[1]);
    const minutes = Number(endTimeMatch[2]);
    if (hours > 23 || minutes > 59) {
      return { error: "Use a valid time in HH:mm format" };
    }
    if (minutes % 5 !== 0) {
      return { error: "End time must use 5-minute steps" };
    }

    const end = new Date(start);
    end.setHours(hours, minutes, 0, 0);
    if (end <= start) end.setDate(end.getDate() + 1);

    if (end.getTime() - start.getTime() > 16 * 3600_000) {
      return { error: "End time must be within 16 hours of the start" };
    }
    return { end };
  }

  let durationMinutes: number | undefined;
  const decimalHoursMatch = /^(\d+(?:[,.]\d+)?)\s*(?:h|hours?)?$/i.exec(input);
  if (decimalHoursMatch) {
    durationMinutes = Number(decimalHoursMatch[1].replace(",", ".")) * 60;
  } else {
    const durationMatch = /^(?:(\d+)\s*h(?:ours?)?\s*)?(?:(\d+)\s*m(?:in(?:utes?)?)?\s*)?$/i.exec(input);
    if (!durationMatch || (!durationMatch[1] && !durationMatch[2])) {
      return { error: "Use HH:mm or a duration such as 90m, 1h 30m, or 1,5h" };
    }
    durationMinutes = Number(durationMatch[1] ?? 0) * 60 + Number(durationMatch[2] ?? 0);
  }

  const roundedMinutes = Math.round(durationMinutes);
  if (
    !Number.isFinite(durationMinutes) ||
    Math.abs(durationMinutes - roundedMinutes) > Number.EPSILON ||
    roundedMinutes <= 0 ||
    roundedMinutes > 16 * 60 ||
    roundedMinutes % 5 !== 0
  ) {
    return { error: "Duration must be 5-minute steps between 5 minutes and 16 hours" };
  }

  return { end: new Date(start.getTime() + roundedMinutes * 60_000) };
}

export async function selectAction(): Promise<Action> {
  return select({
    message: "What do you want to do?",
    choices: [
      { name: "Reserve a room", value: "reserve" as const },
      { name: "My reservations", value: "my-reservations" as const },
      { name: "Share today's & tomorrow's bookings", value: "share" as const },
      { name: "Notification settings", value: "notifications" as const },
      { name: "Exit", value: "exit" as const },
    ],
  });
}

export async function selectSite(): Promise<Site> {
  const siteId = await select({
    message: "Select campus:",
    choices: SITES.map((s) => ({
      name: s.name,
      value: s.id,
    })),
  });
  return SITES.find((s) => s.id === siteId)!;
}

export async function getTimeRange(): Promise<{
  fromUnix: number;
  toUnix: number;
  fromISO: string;
  toISO: string;
}> {
  const now = dayjs();
  const suggestedStart = now
    .add(15 - (now.minute() % 15), "minute")
    .startOf("minute");

  const dateStr = await input({
    message: "Date (DD.MM.YYYY):",
    default: suggestedStart.format("DD.MM.YYYY"),
    validate: (val) => {
      if (!/^\d{2}\.\d{2}\.\d{4}$/.test(val)) return "Use DD.MM.YYYY format";
      const p = val.split(".").map(Number);
      const d = new Date(p[2]!, p[1]! - 1, p[0]!);
      if (isNaN(d.getTime())) return "Invalid date";
      return true;
    },
  });

  const timeStr = await input({
    message: "Start time (HH:mm):",
    default: suggestedStart.format("HH:mm"),
    validate: (val) => {
      if (!/^\d{2}:\d{2}$/.test(val)) return "Use HH:mm format";
      const p = val.split(":").map(Number);
      if (p[0]! < 0 || p[0]! > 23 || p[1]! < 0 || p[1]! > 59) return "Invalid time";
      if (p[1]! % 15 !== 0) return "Start time must use 15-minute steps";
      return true;
    },
  });

  const dp = dateStr.split(".").map(Number);
  const tp = timeStr.split(":").map(Number);
  const start = new Date(dp[2]!, dp[1]! - 1, dp[0]!, tp[0]!, tp[1]!);

  const endInput = await input({
    message: "End time or duration (HH:mm, 90m, 1h 30m, 1.5h or 1,5h):",
    default: dayjs(start).add(1, "hour").format("HH:mm"),
    validate: (val) => {
      const result = parseEndTimeOrDuration(val, start);
      return "error" in result ? result.error : true;
    },
  });
  const endResult = parseEndTimeOrDuration(endInput, start);
  if ("error" in endResult) throw new Error(endResult.error);
  const { end } = endResult;

  return {
    fromUnix: Math.floor(start.getTime() / 1000),
    toUnix: Math.floor(end.getTime() / 1000),
    fromISO: start.toISOString(),
    toISO: end.toISOString(),
  };
}

export function displayRooms(rooms: AvailableRoom[], fromUnix: number, toUnix: number): void {
  if (rooms.length === 0) {
    console.log("\n  No rooms available for this time slot.\n");
    return;
  }

  const fromStr = dayjs.unix(fromUnix).format("DD.MM.YYYY HH:mm");
  const toStr = dayjs.unix(toUnix).format("HH:mm");
  console.log(`\n  ${rooms.length} rooms available (${fromStr} – ${toStr}):\n`);

  const table = new Table({
    head: ["#", "Room", "Building", "Floor", "Capacity", "Type"],
    style: { head: ["cyan"] },
    colWidths: [5, 12, 16, 10, 10, 22],
  });

  rooms.forEach((r, i) => {
    table.push([
      i + 1,
      r.Room,
      r.Building,
      r.Floor,
      r.NumberPersons,
      r.RoomType,
    ]);
  });

  console.log(table.toString());
  console.log();
}

export async function selectRoom(rooms: AvailableRoom[]): Promise<AvailableRoom | null> {
  if (rooms.length === 0) return null;

  const roomId = await select({
    message: "Select room:",
    choices: [
      ...rooms.map((r, i) => ({
        name: `${(i + 1).toString().padStart(2)}. ${r.Room}  (${r.Building}, ${r.Floor}, ${r.NumberPersons} Pl.)`,
        value: r.RoomId,
      })),
      { name: "   Cancel", value: -1 },
    ],
  });

  if (roomId === -1) return null;
  return rooms.find((r) => r.RoomId === roomId) ?? null;
}

export async function getReservationDetails(): Promise<{ title: string; numPersons: string }> {
  const title = await input({
    message: "Reservation title:",
    default: "Gruppenarbeit",
  });
  const numPersons = await input({
    message: "Number of persons:",
    default: "1",
  });
  return { title, numPersons };
}

export async function confirmReservation(
  room: AvailableRoom,
  fromUnix: number,
  toUnix: number,
  title: string,
  numPersons: string
): Promise<boolean> {
  const fromStr = dayjs.unix(fromUnix).format("DD.MM.YYYY HH:mm");
  const toStr = dayjs.unix(toUnix).format("HH:mm");

  console.log();
  console.log("  ┌─ Reservation ──────────────────────────");
  console.log(`  │ Room:     ${room.Room} (${room.Building}, ${room.Floor})`);
  console.log(`  │ Time:     ${fromStr} – ${toStr}`);
  console.log(`  │ Title:    ${title}`);
  console.log(`  │ Persons:  ${numPersons}`);
  console.log("  └─────────────────────────────────────────");
  console.log();

  return confirm({ message: "Confirm?" });
}

export function displayReservations(reservations: Reservation[]): void {
  if (reservations.length === 0) {
    console.log("\n  No upcoming reservations.\n");
    return;
  }

  console.log(`\n  ${reservations.length} upcoming reservation(s):\n`);

  const table = new Table({
    head: ["#", "Room", "Date", "Time", "Title", "Status"],
    style: { head: ["cyan"] },
  });

  reservations.forEach((r, i) => {
    const occ = r.Occupancies?.[0];
    const from = occ ? dayjs(occ.DateTimeFrom).format("DD.MM.YYYY") : "–";
    const time = occ
      ? `${dayjs(occ.DateTimeFrom).format("HH:mm")} – ${dayjs(occ.DateTimeTo).format("HH:mm")}`
      : "–";

    table.push([
      i + 1,
      r.Resource,
      from,
      time,
      r.Designation,
      r.Status,
    ]);
  });

  console.log(table.toString());
  console.log();
}

export async function selectReservationToCancel(
  reservations: Reservation[]
): Promise<Reservation | null> {
  const cancelable = reservations.filter((r) => r.IsCancelable);
  if (cancelable.length === 0) {
    console.log("  No cancelable reservations.\n");
    return null;
  }

  const id = await select({
    message: "Select reservation to cancel:",
    choices: [
      ...cancelable.map((r, i) => {
        const occ = r.Occupancies?.[0];
        const when = occ
          ? `${dayjs(occ.DateTimeFrom).format("DD.MM. HH:mm")}–${dayjs(occ.DateTimeTo).format("HH:mm")}`
          : "";
        return {
          name: `${(i + 1).toString().padStart(2)}. ${r.Resource}  ${when}  "${r.Designation}"`,
          value: r.ReservationId,
        };
      }),
      { name: "   Back", value: -1 },
    ],
  });

  if (id === -1) return null;
  return cancelable.find((r) => r.ReservationId === id) ?? null;
}

export async function confirmCancel(reservation: Reservation): Promise<boolean> {
  const occ = reservation.Occupancies?.[0];
  const when = occ
    ? `${dayjs(occ.DateTimeFrom).format("DD.MM.YYYY HH:mm")} – ${dayjs(occ.DateTimeTo).format("HH:mm")}`
    : "";

  console.log();
  console.log("  ┌─ Cancel Reservation ────────────────────");
  console.log(`  │ Room:   ${reservation.Resource}`);
  console.log(`  │ Time:   ${when}`);
  console.log(`  │ Title:  ${reservation.Designation}`);
  console.log("  └─────────────────────────────────────────");
  console.log();

  return confirm({ message: "Cancel this reservation?", default: false });
}

export async function selectNotifyAction(settings: NotifySettings): Promise<NotifyAction> {
  const hasWebhook = Boolean(settings.teamsWebhookUrl);
  console.log();
  console.log(`  Teams webhook: ${hasWebhook ? "set" : "not set"}`);
  console.log(`  Contacts:      ${settings.contacts.map((c) => c.name).join(", ") || "none"}`);
  console.log();

  return select<NotifyAction>({
    message: "Notification settings:",
    choices: [
      { name: hasWebhook ? "Replace Teams webhook" : "Set Teams webhook", value: "set-webhook" },
      ...(hasWebhook
        ? [
            { name: "Send test message", value: "test-webhook" as const },
            { name: "Remove Teams webhook", value: "remove-webhook" as const },
          ]
        : []),
      { name: "Add contact", value: "add-contact" },
      ...(settings.contacts.length > 0
        ? [{ name: "Remove contact", value: "remove-contact" as const }]
        : []),
      { name: "Back", value: "back" },
    ],
  });
}

export async function promptWebhookUrl(): Promise<string> {
  // Masked because the URL works like a password for posting into the chat.
  const url = await password({
    message: "Paste the Teams Workflows webhook URL:",
    mask: true,
    validate: validateWebhookUrl,
  });
  return url.trim();
}

export async function confirmRemoveWebhook(): Promise<boolean> {
  return confirm({ message: "Remove the Teams webhook?", default: false });
}

export async function promptContact(contacts: Contact[]): Promise<Contact> {
  const name = await input({
    message: "Name:",
    validate: (val) => (val.trim() ? true : "Enter a name"),
  });
  const email = await input({
    message: "FHNW email (used for the Teams chat link):",
    validate: (val) => validateContactEmail(val, contacts),
  });
  return { name: name.trim(), email: email.trim() };
}

export async function selectContactToRemove(contacts: Contact[]): Promise<Contact | null> {
  const email = await select({
    message: "Remove which contact?",
    choices: [
      ...contacts.map((c) => ({ name: `${c.name} <${c.email}>`, value: c.email })),
      { name: "   Back", value: "" },
    ],
  });
  return contacts.find((c) => c.email === email) ?? null;
}

export async function selectContactsToNotify(contacts: Contact[]): Promise<Contact[]> {
  return checkbox({
    message: "Message whom in Teams? (space toggles, enter confirms)",
    choices: contacts.map((c) => ({ name: `${c.name} <${c.email}>`, value: c, checked: true })),
  });
}

export async function selectBookingsToShare(bookings: BookingNotice[]): Promise<BookingNotice[]> {
  return checkbox({
    message: "Share which bookings? (space toggles, enter confirms)",
    choices: bookings.map((b) => ({
      name: `${b.room}  ${dayjs(b.from).format("dd DD.MM. HH:mm")}–${dayjs(b.to).format("HH:mm")}  "${b.title}"`,
      value: b,
      checked: true,
    })),
  });
}
