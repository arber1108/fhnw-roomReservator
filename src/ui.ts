import { select as inquirerSelect, input, confirm, password, checkbox } from "@inquirer/prompts";
import Table from "cli-table3";
import dayjs from "dayjs";
import { SITES } from "./locations.js";
import { validateContactEmail, validateWebhookUrl } from "./notify.js";
import type { PromptResult, PromptSession } from "./prompt-session.js";
import type { AvailableRoom, BookingNotice, Contact, NotifySettings, Reservation, Site } from "./types.js";
import { ExtensionSearch, isExtendableReservation } from "./extension.js";
import type { ExtensionDirection, ExtensionRange } from "./extension.js";

type Action = "reserve" | "my-reservations" | "share" | "notifications" | "exit";

type NotifyAction =
  | "set-webhook"
  | "test-webhook"
  | "remove-webhook"
  | "add-contact"
  | "remove-contact";
type ReservationConfirmation = "confirm" | "cancel";

type EndParseResult = { end: Date } | { error: string };
export type TimeRangeDraft = {
  date: string;
  startTime: string;
  endInput: string;
  endInputEdited: boolean;
};
export type TimeRange = {
  fromUnix: number;
  toUnix: number;
  fromISO: string;
  toISO: string;
};
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

export async function showResult(session: PromptSession, title: string, lines: string[] = []): Promise<void> {
  showStep(title, lines);
  await waitForMainMenu(session);
}

export async function waitForMainMenu(session: PromptSession): Promise<void> {
  await select(session, {
    message: "Continue:",
    choices: [{ name: "Back to main menu", value: "back" as const }],
  });
}

/** Adds W/S navigation to Inquirer's select prompt without changing text inputs. */
async function select<Value>(
  session: PromptSession,
  config: SelectConfig<Value>,
  showBack = true
): Promise<PromptResult<Value>> {
  return session.prompt((context) => inquirerSelect({
      ...config,
      theme: {
        style: {
          keysHelpTip: () => `↑↓ / w s navigate • ⏎ select${showBack ? " • Esc back" : ""}`,
        },
      },
    }, context), { navigation: true });
}

/** Lets users leave a text prompt with Escape instead of cancelling the CLI. */
async function inputWithBack(session: PromptSession, config: InputConfig): Promise<PromptResult<string>> {
  return session.prompt((context) => input(config, context));
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

export async function selectAction(session: PromptSession): Promise<Action> {
  while (true) {
    showStep("Main menu");
    const result = await select(session, {
      message: "What do you want to do?",
      choices: [
        { name: "Reserve a room", value: "reserve" as const },
        { name: "My reservations", value: "my-reservations" as const },
        { name: "Share today's & tomorrow's bookings", value: "share" as const },
        { name: "Notification settings", value: "notifications" as const },
        { name: "Exit", value: "exit" as const },
      ],
    }, false);
    if (result.kind === "value") return result.value;
  }
}

export async function selectSite(session: PromptSession, defaultSiteId?: number): Promise<PromptResult<Site>> {
  showStep("Reserve a room", ["Choose a campus"]);
  const result = await select(session, {
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
  if (result.kind === "back" || result.value === -1) return { kind: "back" };
  const site = SITES.find((s) => s.id === result.value);
  return site ? { kind: "value", value: site } : { kind: "back" };
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
    endInputEdited: false,
  };
}

export async function promptDate(
  session: PromptSession,
  siteName: string,
  draft: TimeRangeDraft
): Promise<PromptResult<string>> {
  showStep("Choose date", [
    `Campus: ${siteName}`,
    "Enter keeps the shown value; typing replaces it.",
  ]);
  return inputWithBack(session, {
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
}

export async function promptStartTime(
  session: PromptSession,
  siteName: string,
  draft: TimeRangeDraft
): Promise<PromptResult<string>> {
  showStep("Choose start time", [
    `Campus: ${siteName}`,
    `Date: ${draft.date}`,
    "Enter keeps the shown value; typing replaces it.",
  ]);
  return inputWithBack(session, {
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
}

function startFromDraft(draft: TimeRangeDraft): Date {
  const [day, month, year] = draft.date.split(".").map(Number);
  const [hours, minutes] = draft.startTime.split(":").map(Number);
  return new Date(year!, month! - 1, day!, hours!, minutes!);
}

export function applyStartTime(draft: TimeRangeDraft, startTime: string): void {
  if (startTime !== draft.startTime && !draft.endInputEdited) {
    const start = startFromDraft({ ...draft, startTime });
    draft.endInput = dayjs(start).add(1, "hour").format("HH:mm");
  }
  draft.startTime = startTime;
}

export async function promptEndTime(
  session: PromptSession,
  siteName: string,
  draft: TimeRangeDraft
): Promise<PromptResult<{ range: TimeRange; endInput: string }>> {
  const start = startFromDraft(draft);
  showStep("Choose end time or duration", [
    `Campus: ${siteName}`,
    `Start: ${dayjs(start).format("DD.MM.YYYY HH:mm")}`,
    "Enter keeps the shown value; typing replaces it.",
  ]);
  const result = await inputWithBack(session, {
    message: "End time or duration (Esc to go back):",
    default: draft.endInput,
    validate: (val) => {
      const parsed = parseEndTimeOrDuration(val, start);
      return "error" in parsed ? parsed.error : true;
    },
  });
  if (result.kind === "back") return result;

  const parsed = parseEndTimeOrDuration(result.value, start);
  if ("error" in parsed) throw new Error(parsed.error);
  return {
    kind: "value",
    value: {
      endInput: result.value,
      range: {
        fromUnix: Math.floor(start.getTime() / 1000),
        toUnix: Math.floor(parsed.end.getTime() / 1000),
        fromISO: start.toISOString(),
        toISO: parsed.end.toISOString(),
      },
    },
  };
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
  session: PromptSession,
  rooms: AvailableRoom[],
  siteName: string,
  fromUnix: number,
  toUnix: number,
  selectedRoomId?: number
): Promise<PromptResult<AvailableRoom>> {
  showStep("Choose a room", [`Campus: ${siteName}`]);
  displayRooms(rooms, fromUnix, toUnix);

  if (rooms.length === 0) {
    await select(session, {
      message: "Continue:",
      choices: [{ name: "Change time", value: "back" as const }],
    });
    return { kind: "back" };
  }

  const roomId = await select(session, {
    message: "Select room:",
    default: selectedRoomId,
    choices: [
      ...rooms.map((r, i) => ({
        name: `${(i + 1).toString().padStart(2)}. ${r.Room}  (${r.Building}, ${r.Floor}, ${r.NumberPersons} Pl.)`,
        value: r.RoomId,
      })),
      { name: "   Back", value: -1 },
    ],
  });

  if (roomId.kind === "back" || roomId.value === -1) return { kind: "back" };
  const room = rooms.find((r) => r.RoomId === roomId.value);
  return room ? { kind: "value", value: room } : { kind: "back" };
}

export async function promptReservationTitle(
  session: PromptSession,
  context: ReservationContext,
  title: string
): Promise<PromptResult<string>> {
  const summary = [
    `Campus: ${context.siteName}`,
    `Room: ${context.room.Room}`,
    `Time: ${formatPeriod(context.fromUnix, context.toUnix)}`,
    "Enter keeps the shown value; typing replaces it.",
  ];

  showStep("Reservation details", summary);
  return inputWithBack(session, {
    message: "Reservation title (Esc to go back):",
    default: title,
  });
}

export async function promptReservationPersons(
  session: PromptSession,
  context: ReservationContext,
  title: string,
  numPersons: string
): Promise<PromptResult<string>> {
  showStep("Reservation details", [
    `Campus: ${context.siteName}`,
    `Room: ${context.room.Room}`,
    `Time: ${formatPeriod(context.fromUnix, context.toUnix)}`,
    `Title: ${title}`,
    "Enter keeps the shown value; typing replaces it.",
  ]);
  return inputWithBack(session, {
    message: "Number of persons (Esc to go back):",
    default: numPersons,
  });
}

export async function confirmReservation(
  session: PromptSession,
  room: AvailableRoom,
  fromUnix: number,
  toUnix: number,
  title: string,
  numPersons: string
): Promise<PromptResult<ReservationConfirmation>> {
  showStep("Confirm reservation");
  console.log("  ┌─ Reservation ──────────────────────────");
  console.log(`  │ Room:     ${room.Room} (${room.Building}, ${room.Floor})`);
  console.log(`  │ Time:     ${formatPeriod(fromUnix, toUnix)}`);
  console.log(`  │ Title:    ${title}`);
  console.log(`  │ Persons:  ${numPersons}`);
  console.log("  └─────────────────────────────────────────");
  console.log();

  const result = await select(session, {
    message: "Continue?",
    choices: [
      { name: "Reserve room", value: "confirm" as const },
      { name: "Back to number of persons", value: "back" as const },
      { name: "Cancel reservation", value: "cancel" as const },
    ],
  });
  if (result.kind === "back" || result.value === "back") return { kind: "back" };
  return { kind: "value", value: result.value };
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

export async function selectReservation(
  session: PromptSession,
  reservations: Reservation[]
): Promise<PromptResult<Reservation>> {
  showStep("My reservations");
  displayReservations(reservations);

  if (reservations.length === 0) {
    await select(session, {
      message: "Continue:",
      choices: [{ name: "Back to main menu", value: "back" as const }],
    });
    return { kind: "back" };
  }

  const actionable = reservations.filter((r) => r.IsCancelable || isExtendableReservation(r));
  if (actionable.length === 0) {
    console.log("  No reservations can be changed.\n");
    await select(session, {
      message: "Continue:",
      choices: [{ name: "Back to main menu", value: "back" as const }],
    });
    return { kind: "back" };
  }

  const id = await select(session, {
    message: "Select reservation:",
    choices: [
      ...actionable.map((r, i) => {
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

  if (id.kind === "back" || id.value === -1) return { kind: "back" };
  const reservation = actionable.find((r) => r.ReservationId === id.value);
  return reservation ? { kind: "value", value: reservation } : { kind: "back" };
}

export async function selectReservationAction(
  session: PromptSession,
  reservation: Reservation
): Promise<PromptResult<"extend" | "cancel">> {
  showStep("Manage reservation", [
    `Room: ${reservation.Resource}`,
    `Title: ${reservation.Designation}`,
  ]);
  const result = await select(session, {
    message: "What do you want to do?",
    choices: [
      ...(isExtendableReservation(reservation)
        ? [{ name: "Extend reservation", value: "extend" as const }]
        : []),
      ...(reservation.IsCancelable
        ? [{ name: "Cancel reservation", value: "cancel" as const }]
        : []),
      { name: "Back", value: "back" as const },
    ],
  });
  if (result.kind === "back" || result.value === "back") return { kind: "back" };
  return { kind: "value", value: result.value };
}

export async function selectExtensionDirection(
  session: PromptSession,
  reservation: Reservation
): Promise<PromptResult<ExtensionDirection>> {
  const before = ExtensionSearch.forReservation(reservation, "before");
  const after = ExtensionSearch.forReservation(reservation, "after");
  showStep("Extend reservation", [`Room: ${reservation.Resource}`]);
  const result = await select(session, {
    message: "Extend in which direction?",
    choices: [
      ...(before ? [{ name: "Before the reservation", value: "before" as const }] : []),
      ...(after ? [{ name: "After the reservation", value: "after" as const }] : []),
      { name: "Back", value: "back" as const },
    ],
  });
  if (result.kind === "back" || result.value === "back") return { kind: "back" };
  return { kind: "value", value: result.value };
}

export async function promptExtensionDuration(
  session: PromptSession,
  reservation: Reservation,
  search: ExtensionSearch,
  maximumUnits: number
): Promise<PromptResult<number>> {
  const maximum = search.range(maximumUnits);
  const minimum = search.range(1);
  showStep("Choose extension duration", [
    `Room: ${reservation.Resource}`,
    `Maximum: ${maximum.durationMinutes} minutes (${formatPeriod(maximum.fromUnix, maximum.toUnix)})`,
    `Allowed: ${minimum.durationMinutes} minutes, then ${search.direction === "before" ? "15" : "5"}-minute steps`,
    ...(search.gapMinutes ? [`Gap after original reservation: ${search.gapMinutes} minutes`] : []),
  ]);
  const result = await inputWithBack(session, {
    message: "Additional duration in minutes (Esc to go back):",
    default: String(maximum.durationMinutes),
    validate: (value) => {
      const minutes = Number(value.trim());
      return Number.isInteger(minutes) && search.unitsForDuration(minutes, maximumUnits) !== null
        ? true
        : "Enter one of the available durations shown above";
    },
  });
  if (result.kind === "back") return result;
  const units = search.unitsForDuration(Number(result.value.trim()), maximumUnits);
  if (units === null) throw new Error("Invalid extension duration");
  return { kind: "value", value: units };
}

export async function promptExtensionPersons(
  session: PromptSession,
  reservation: Reservation
): Promise<PromptResult<string>> {
  showStep("Extension details", [`Room: ${reservation.Resource}`, `Title: ${reservation.Designation}`]);
  const result = await inputWithBack(session, {
    message: "Number of persons (Esc to go back):",
    default: "1",
    validate: (value) => value.trim() ? true : "Enter a number of persons",
  });
  return result.kind === "back" ? result : { kind: "value", value: result.value.trim() };
}

export async function confirmExtension(
  session: PromptSession,
  reservation: Reservation,
  range: ExtensionRange,
  gapMinutes: number,
  persons: string
): Promise<PromptResult<boolean>> {
  const original = reservation.Occupancies![0]!;
  showStep("Confirm extension", [
    `Room: ${reservation.Resource}`,
    `Existing: ${formatPeriod(new Date(original.DateTimeFrom).getTime() / 1000, new Date(original.DateTimeTo).getTime() / 1000)}`,
    `Additional: ${formatPeriod(range.fromUnix, range.toUnix)}`,
    ...(gapMinutes ? [`Gap between reservations: ${gapMinutes} minutes`] : []),
    `Title: ${reservation.Designation}`,
    `Persons: ${persons}`,
  ]);
  return session.prompt((context) => confirm(
    { message: "Book this additional time? (Esc to go back)", default: false },
    context
  ));
}

export async function confirmCancel(session: PromptSession, reservation: Reservation): Promise<PromptResult<boolean>> {
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

  return session.prompt((context) => confirm(
    { message: "Cancel this reservation? (Esc to go back)", default: false },
    context
  ));
}

export async function selectNotifyAction(
  session: PromptSession,
  settings: NotifySettings
): Promise<PromptResult<NotifyAction>> {
  const hasWebhook = Boolean(settings.teamsWebhookUrl);
  console.log();
  console.log(`  Teams webhook: ${hasWebhook ? "set" : "not set"}`);
  console.log(`  Contacts:      ${settings.contacts.map((c) => c.name).join(", ") || "none"}`);
  console.log();

  const result = await select<NotifyAction | "back">(session, {
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
  if (result.kind === "back" || result.value === "back") return { kind: "back" };
  return { kind: "value", value: result.value };
}

export async function promptWebhookUrl(session: PromptSession): Promise<PromptResult<string>> {
  // Masked because the URL works like a password for posting into the chat.
  const result = await session.prompt((context) => password({
    message: "Paste the Teams Workflows webhook URL (Esc to go back):",
    mask: true,
    validate: validateWebhookUrl,
  }, context));
  return result.kind === "back" ? result : { kind: "value", value: result.value.trim() };
}

export async function confirmRemoveWebhook(session: PromptSession): Promise<PromptResult<boolean>> {
  return session.prompt((context) => confirm({ message: "Remove the Teams webhook? (Esc to go back)", default: false }, context));
}

export async function promptContactName(session: PromptSession, previous = ""): Promise<PromptResult<string>> {
  const result = await inputWithBack(session, {
    message: "Name (Esc to go back):",
    default: previous,
    validate: (val) => (val.trim() ? true : "Enter a name"),
  });
  return result.kind === "back" ? result : { kind: "value", value: result.value.trim() };
}

export async function promptContactEmail(
  session: PromptSession,
  contacts: Contact[],
  previous = ""
): Promise<PromptResult<string>> {
  const result = await inputWithBack(session, {
    message: "FHNW email (Esc to go back):",
    default: previous,
    validate: (val) => validateContactEmail(val, contacts),
  });
  return result.kind === "back" ? result : { kind: "value", value: result.value.trim() };
}

export async function selectContactToRemove(
  session: PromptSession,
  contacts: Contact[]
): Promise<PromptResult<Contact>> {
  const email = await select(session, {
    message: "Remove which contact?",
    choices: [
      ...contacts.map((c) => ({ name: `${c.name} <${c.email}>`, value: c.email })),
      { name: "   Back", value: "" },
    ],
  });
  if (email.kind === "back" || email.value === "") return { kind: "back" };
  const contact = contacts.find((c) => c.email === email.value);
  return contact ? { kind: "value", value: contact } : { kind: "back" };
}

export async function selectContactsToNotify(
  session: PromptSession,
  contacts: Contact[]
): Promise<PromptResult<Contact[]>> {
  return session.prompt((context) => checkbox({
    message: "Message whom in Teams? (space toggles, enter confirms, Esc back)",
    choices: contacts.map((c) => ({ name: `${c.name} <${c.email}>`, value: c, checked: true })),
  }, context));
}

export async function selectBookingsToShare(
  session: PromptSession,
  bookings: BookingNotice[],
  selected?: BookingNotice[]
): Promise<PromptResult<BookingNotice[]>> {
  return session.prompt((context) => checkbox({
    message: "Share which bookings? (space toggles, enter confirms, Esc back)",
    choices: bookings.map((b) => ({
      name: `${b.room}  ${dayjs(b.from).format("dd DD.MM. HH:mm")}–${dayjs(b.to).format("HH:mm")}  "${b.title}"`,
      value: b,
      checked: selected ? selected.includes(b) : true,
    })),
  }, context));
}
