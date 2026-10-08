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
type ReservationConfirmation = "confirm" | "back" | "cancel";

type EndParseResult = { end: Date } | { error: string };
export type TimeRangeDraft = {
  date: string;
  startTime: string;
  endInput: string;
};
export type TimeStep = "date" | "start";
type TimeRange = {
  fromUnix: number;
  toUnix: number;
  fromISO: string;
  toISO: string;
};
type ReservationDetails = { title: string; numPersons: string };
type ReservationContext = {
  siteName: string;
  room: AvailableRoom;
  fromUnix: number;
  toUnix: number;
};
type InputConfig = {
  message: string;
  default?: string;
  validate?: (value: string) => boolean | string | Promise<boolean | string>;
};

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

export function showStep(title: string, context: string[] = []): void {
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
  console.log("\n  FHNW Room Reservator\n  ────────────────────");
  console.log(`\n  ${title}`);
  for (const line of context) console.log(`  ${line}`);
  console.log();
}

export function formatPeriod(fromUnix: number, toUnix: number): string {
  const from = dayjs.unix(fromUnix);
  const to = dayjs.unix(toUnix);
  const endFormat = from.isSame(to, "day") ? "HH:mm" : "DD.MM.YYYY HH:mm";
  return `${from.format("DD.MM.YYYY HH:mm")} – ${to.format(endFormat)}`;
}

export async function showResult(title: string, lines: string[] = []): Promise<void> {
  showStep(title, lines);
  await waitForMainMenu();
}

export async function waitForMainMenu(): Promise<void> {
  await select({
    message: "Continue:",
    choices: [{ name: "Back to main menu", value: "back" as const }],
  });
}

/** Adds W/S navigation to Inquirer's select prompt without changing text inputs. */
async function select<Value>(config: SelectConfig<Value>): Promise<Value> {
  const mapWsToArrows = (
    _character: string | undefined,
    key: { name?: string }
  ): void => {
    // Inquirer must see only the navigation key. Emitting another keypress here
    // also lets it process the original W/S as a choice search.
    if (key.name === "w") key.name = "up";
    if (key.name === "s") key.name = "down";
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
    }, { clearPromptOnDone: true });
  } finally {
    process.stdin.removeListener("keypress", mapWsToArrows);
  }
}

/** Lets users leave a text prompt with Escape instead of cancelling the CLI. */
async function inputWithBack(config: InputConfig): Promise<string | null> {
  const controller = new AbortController();
  const goBack = (_character: string | undefined, key: { name?: string }): void => {
    if (key.name === "escape") controller.abort();
  };

  process.stdin.prependListener("keypress", goBack);
  try {
    return await input(config, {
      signal: controller.signal,
      clearPromptOnDone: true,
    });
  } catch (error) {
    if (controller.signal.aborted) return null;
    throw error;
  } finally {
    process.stdin.removeListener("keypress", goBack);
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
    if (end.getHours() !== hours || end.getMinutes() !== minutes) {
      return { error: "End time does not exist on this date" };
    }

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
  showStep("Main menu");
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

export async function selectSite(defaultSiteId?: number): Promise<Site | null> {
  showStep("Reserve a room", ["Choose a campus"]);
  const siteId = await select({
    message: "Select campus:",
    default: defaultSiteId,
    choices: [
      ...SITES.map((s) => ({
        name: s.name,
        value: s.id,
      })),
      { name: "Back", value: -1 },
    ],
  });
  if (siteId === -1) return null;
  return SITES.find((s) => s.id === siteId) ?? null;
}

export function createTimeRangeDraft(): TimeRangeDraft {
  const now = dayjs();
  const suggestedStart = now
    .add(15 - (now.minute() % 15), "minute")
    .startOf("minute");

  return {
    date: suggestedStart.format("DD.MM.YYYY"),
    startTime: suggestedStart.format("HH:mm"),
    endInput: suggestedStart.add(1, "hour").format("HH:mm"),
  };
}

export async function getTimeRange(
  siteName: string,
  draft: TimeRangeDraft,
  initialStep: TimeStep = "date"
): Promise<TimeRange | null> {
  let step: "date" | "start" | "end" = initialStep;
  while (true) {
    if (step === "date") {
      showStep("Choose date", [
        `Campus: ${siteName}`,
        "Enter keeps the shown value; typing replaces it.",
      ]);
      const dateStr = await inputWithBack({
        message: "Date (DD.MM.YYYY, Esc to go back):",
        default: draft.date,
        validate: (val) => {
          if (!/^\d{2}\.\d{2}\.\d{4}$/.test(val)) return "Use DD.MM.YYYY format";
          const [day, month, year] = val.split(".").map(Number);
          const d = new Date(year!, month! - 1, day!);
          if (
            isNaN(d.getTime()) ||
            d.getDate() !== day ||
            d.getMonth() !== month! - 1 ||
            d.getFullYear() !== year
          ) return "Invalid date";
          return true;
        },
      });
      if (dateStr === null) return null;
      draft.date = dateStr;
      step = "start";
    }

    if (step === "start") {
      showStep("Choose start time", [
        `Campus: ${siteName}`,
        `Date: ${draft.date}`,
        "Enter keeps the shown value; typing replaces it.",
      ]);
      const timeStr = await inputWithBack({
        message: "Start time (HH:mm, Esc to go back):",
        default: draft.startTime,
        validate: (val) => {
          if (!/^\d{2}:\d{2}$/.test(val)) return "Use HH:mm format";
          const [hours, minutes] = val.split(":").map(Number);
          if (hours! < 0 || hours! > 23 || minutes! < 0 || minutes! > 59) return "Invalid time";
          if (minutes! % 15 !== 0) return "Start time must use 15-minute steps";
          const [day, month, year] = draft.date.split(".").map(Number);
          const start = new Date(year!, month! - 1, day!, hours!, minutes!);
          if (start.getHours() !== hours || start.getMinutes() !== minutes) {
            return "Start time does not exist on this date";
          }
          return true;
        },
      });
      if (timeStr === null) {
        step = "date";
        continue;
      }

      const dp = draft.date.split(".").map(Number);
      const tp = timeStr.split(":").map(Number);
      const start = new Date(dp[2]!, dp[1]! - 1, dp[0]!, tp[0]!, tp[1]!);
      if (timeStr !== draft.startTime && /^\d{2}:\d{2}$/.test(draft.endInput)) {
        draft.endInput = dayjs(start).add(1, "hour").format("HH:mm");
      }
      draft.startTime = timeStr;
      step = "end";
    }

    if (step === "end") {
      const dp = draft.date.split(".").map(Number);
      const tp = draft.startTime.split(":").map(Number);
      const start = new Date(dp[2]!, dp[1]! - 1, dp[0]!, tp[0]!, tp[1]!);
      showStep("Choose end time or duration", [
        `Campus: ${siteName}`,
        `Start: ${dayjs(start).format("DD.MM.YYYY HH:mm")}`,
        "Enter keeps the shown value; typing replaces it.",
      ]);
      const endInput = await inputWithBack({
        message: "End time or duration (Esc to go back):",
        default: draft.endInput,
        validate: (val) => {
          const result = parseEndTimeOrDuration(val, start);
          return "error" in result ? result.error : true;
        },
      });
      if (endInput === null) {
        step = "start";
        continue;
      }

      const endResult = parseEndTimeOrDuration(endInput, start);
      if ("error" in endResult) throw new Error(endResult.error);
      draft.endInput = endInput;
      const { end } = endResult;
      return {
        fromUnix: Math.floor(start.getTime() / 1000),
        toUnix: Math.floor(end.getTime() / 1000),
        fromISO: start.toISOString(),
        toISO: end.toISOString(),
      };
    }
  }
}

export function displayRooms(rooms: AvailableRoom[], fromUnix: number, toUnix: number): void {
  if (rooms.length === 0) {
    console.log("  No rooms available for this time slot.\n");
    return;
  }

  console.log(`  ${rooms.length} rooms available (${formatPeriod(fromUnix, toUnix)}):\n`);

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

export async function selectRoom(
  rooms: AvailableRoom[],
  siteName: string,
  fromUnix: number,
  toUnix: number
): Promise<AvailableRoom | "back"> {
  showStep("Choose a room", [`Campus: ${siteName}`]);
  displayRooms(rooms, fromUnix, toUnix);

  if (rooms.length === 0) {
    await select({
      message: "Continue:",
      choices: [{ name: "Change time", value: "back" as const }],
    });
    return "back";
  }

  const roomId = await select({
    message: "Select room:",
    choices: [
      ...rooms.map((r, i) => ({
        name: `${(i + 1).toString().padStart(2)}. ${r.Room}  (${r.Building}, ${r.Floor}, ${r.NumberPersons} Pl.)`,
        value: r.RoomId,
      })),
      { name: "   Back", value: -1 },
    ],
  });

  if (roomId === -1) return "back";
  return rooms.find((r) => r.RoomId === roomId) ?? "back";
}

export async function getReservationDetails(
  context: ReservationContext,
  previous?: ReservationDetails
): Promise<ReservationDetails | null> {
  const defaults = previous ?? { title: "Gruppenarbeit", numPersons: "1" };
  let titleDefault = defaults.title;
  const summary = [
    `Campus: ${context.siteName}`,
    `Room: ${context.room.Room}`,
    `Time: ${formatPeriod(context.fromUnix, context.toUnix)}`,
    "Enter keeps the shown value; typing replaces it.",
  ];

  while (true) {
    showStep("Reservation details", summary);
    const title = await inputWithBack({
      message: "Reservation title (Esc to go back):",
      default: titleDefault,
    });
    if (title === null) return null;

    showStep("Reservation details", [...summary, `Title: ${title}`]);
    const numPersons = await inputWithBack({
      message: "Number of persons (Esc to go back):",
      default: defaults.numPersons,
    });
    if (numPersons !== null) return { title, numPersons };

    titleDefault = title;
  }
}

export async function confirmReservation(
  room: AvailableRoom,
  fromUnix: number,
  toUnix: number,
  title: string,
  numPersons: string
): Promise<ReservationConfirmation> {
  showStep("Confirm reservation");
  console.log("  ┌─ Reservation ──────────────────────────");
  console.log(`  │ Room:     ${room.Room} (${room.Building}, ${room.Floor})`);
  console.log(`  │ Time:     ${formatPeriod(fromUnix, toUnix)}`);
  console.log(`  │ Title:    ${title}`);
  console.log(`  │ Persons:  ${numPersons}`);
  console.log("  └─────────────────────────────────────────");
  console.log();

  return select({
    message: "Continue?",
    choices: [
      { name: "Reserve room", value: "confirm" as const },
      { name: "Back (edit details)", value: "back" as const },
      { name: "Cancel reservation", value: "cancel" as const },
    ],
  });
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
  showStep("My reservations");
  displayReservations(reservations);

  if (reservations.length === 0) {
    await select({
      message: "Continue:",
      choices: [{ name: "Back to main menu", value: "back" as const }],
    });
    return null;
  }

  const cancelable = reservations.filter((r) => r.IsCancelable);
  if (cancelable.length === 0) {
    console.log("  No cancelable reservations.\n");
    await select({
      message: "Continue:",
      choices: [{ name: "Back to main menu", value: "back" as const }],
    });
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

  showStep("Cancel reservation");
  console.log("  ┌─ Cancel Reservation ────────────────────");
  console.log(`  │ Room:   ${reservation.Resource}`);
  console.log(`  │ Time:   ${when}`);
  console.log(`  │ Title:  ${reservation.Designation}`);
  console.log("  └─────────────────────────────────────────");
  console.log();

  return confirm(
    { message: "Cancel this reservation?", default: false },
    { clearPromptOnDone: true }
  );
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
