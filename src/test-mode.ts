import * as fs from "fs";
import * as path from "path";
import dayjs from "dayjs";
import { DATA_DIR, ensureDataDir } from "./paths.js";
import { SITES } from "./locations.js";
import type { AuthState, AvailableRoom, NotifySettings, Reservation, ReservationRequest } from "./types.js";

/**
 * Test mode replaces every outgoing request (Evento API, browser login, Teams)
 * with an in-memory fake, so new features can be tried without touching real
 * FHNW data. Enable it with `--test` / `--dry-run` or `ROOMRESERVE_TEST_MODE=1`.
 */
export function isTestMode(): boolean {
  if (process.argv.includes("--test") || process.argv.includes("--dry-run")) return true;
  const env = process.env.ROOMRESERVE_TEST_MODE?.trim().toLowerCase();
  return !!env && env !== "0" && env !== "false";
}

export const TEST_LOG_FILE = path.join(DATA_DIR, "test-mode.log");
const MOCK_PERSON_ID = 999999;

/** Requests that would have changed something, newest last. Shown in the screen header. */
const sentRequests: string[] = [];

export function lastMockedRequest(): string | undefined {
  return sentRequests[sentRequests.length - 1];
}

/** Records a request that test mode intercepted instead of sending. */
export function logMockedRequest(summary: string, body?: unknown): void {
  const line = body === undefined ? summary : `${summary} ${JSON.stringify(body)}`;
  sentRequests.push(line);
  try {
    ensureDataDir();
    fs.appendFileSync(TEST_LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // The log is a convenience; the in-memory copy is still shown on screen.
  }
}

/** A fake but well-formed token, so JWT parsing (person ID, expiry) still runs. */
export function mockAuthState(): AuthState {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const expiresAt = Date.now() + 24 * 3600_000;
  const token = [
    encode({ alg: "none", typ: "JWT" }),
    encode({ id_person: MOCK_PERSON_ID, exp: Math.floor(expiresAt / 1000) }),
    "test-mode",
  ].join(".");
  return { clxAuthorization: `access_token=${token}`, expiresAt };
}

// Notification settings stay in memory so test runs never overwrite notify.json.
let notifySettings: NotifySettings | undefined;

export function loadMockNotifySettings(load: () => NotifySettings): NotifySettings {
  notifySettings ??= structuredClone(load());
  return structuredClone(notifySettings);
}

export function saveMockNotifySettings(settings: NotifySettings): void {
  notifySettings = structuredClone(settings);
}

/** The API sends local times without a UTC offset. */
function apiTime(date: Date): string {
  return dayjs(date).format("YYYY-MM-DDTHH:mm:ss");
}

const ROOM_TEMPLATES = [
  { suffix: "1.01", type: "Gruppenraum", persons: 4 },
  { suffix: "1.02", type: "Gruppenraum", persons: 6 },
  { suffix: "2.11", type: "Seminarraum", persons: 12 },
];

function mockRooms(siteId: number): AvailableRoom[] {
  const site = SITES.find((s) => s.id === siteId);
  if (!site) return [];
  const buildingId = site.buildingIds[0] ?? siteId * 100;
  return ROOM_TEMPLATES.map((template, i) => ({
    Room: `TEST-${site.name.replace("Campus ", "").slice(0, 3).toUpperCase()}-${template.suffix}`,
    RoomId: siteId * 1000 + i + 1,
    RoomType: template.type,
    Building: `Testgebäude ${buildingId}`,
    BuildingId: buildingId,
    Floor: template.suffix.split(".")[0]!,
    NumberPersons: template.persons,
    IsAvailable: true,
    IsBookable: true,
    Status: "Frei",
    Occupancies: [],
  }));
}

function findMockRoom(roomId: number): AvailableRoom | undefined {
  return SITES.flatMap((site) => mockRooms(site.id)).find((room) => room.RoomId === roomId);
}

function seedReservations(): Reservation[] {
  const room = mockRooms(SITES[0]!.id)[0]!;
  const start = dayjs().add(1, "day").startOf("day").add(10, "hour");
  return [{
    ReservationId: 900001,
    ResourceId: room.RoomId,
    Resource: room.Room,
    Designation: "Testreservation",
    FurtherInformation: "2",
    Status: "Bestätigt",
    StatusRemark: "",
    IsCancelable: true,
    Occupancies: [{
      DateTimeFrom: apiTime(start.toDate()),
      DateTimeTo: apiTime(start.add(2, "hour").toDate()),
      Designation: "Testreservation",
      Type: 20,
    }],
  }];
}

let reservations: Reservation[] | undefined;
let nextReservationId = 900100;

function store(): Reservation[] {
  reservations ??= seedReservations();
  return reservations;
}

/** Restores the fake service to its starting data (used by automated tests). */
export function resetMockEvento(): void {
  reservations = undefined;
  notifySettings = undefined;
  nextReservationId = 900100;
  sentRequests.length = 0;
}

function overlaps(r: Reservation, from: number, to: number): boolean {
  return r.Status !== "Storniert" && (r.Occupancies ?? []).some((o) =>
    new Date(o.DateTimeFrom).getTime() < to && new Date(o.DateTimeTo).getTime() > from
  );
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * Answers Evento API requests from in-memory data. Reads return fake rooms and
 * reservations; writes change only that data and are logged instead of sent.
 */
export async function mockEventoFetch(url: string, init?: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  const route = parsed.pathname.replace(/^\/Evento\/api2/, "");
  const query = parsed.searchParams;
  const method = (init?.method ?? "GET").toUpperCase();

  if (method === "GET" && route === "/Buildings/") {
    return json(SITES.flatMap((site) => site.buildingIds.map((id) => ({
      Id: id, Site: site.name, SiteId: site.id, ShortName: `T${id}`,
      Designation: `Testgebäude ${id}`, Location: site.name, Address: "", Zip: "",
    }))));
  }

  if (method === "GET" && route === "/RoomReservation/Rooms/Available/") {
    const from = Number(query.get("availableFrom")) * 1000;
    const to = Number(query.get("availableTo")) * 1000;
    const siteIds = (query.get("locations") ?? "").split(",").map(Number);
    const designation = query.get("designations");
    if (designation !== null) {
      const duration = Number(query.get("timespan") ?? 0) * 1000;
      return json(siteIds.flatMap(mockRooms).filter((room) => room.Room.includes(designation)).map((room) => {
        const occupancies = store().filter((reservation) =>
          reservation.ResourceId === room.RoomId && reservation.Status !== "Storniert"
        ).flatMap((reservation) => reservation.Occupancies ?? []);
        const blocked = occupancies.map((occupancy) => ({
          from: new Date(occupancy.DateTimeFrom).getTime(),
          to: new Date(occupancy.DateTimeTo).getTime(),
        })).filter((interval) => interval.from < to && interval.to > from)
          .sort((a, b) => a.from - b.from);
        let freeFrom = from;
        const available = blocked.some((interval) => {
          if (interval.from - freeFrom >= duration) return true;
          freeFrom = Math.max(freeFrom, interval.to);
          return false;
        }) || to - freeFrom >= duration;
        return { ...room, IsAvailable: available, Occupancies: occupancies };
      }).filter((room) => query.get("availableOnly") !== "1" || room.IsAvailable));
    }
    const busy = new Set(store().filter((r) => overlaps(r, from, to)).map((r) => r.ResourceId));
    return json(siteIds.flatMap(mockRooms).filter((room) => !busy.has(room.RoomId)));
  }

  if (method === "GET" && route === "/Reservations/") {
    const from = Number(query.get("DateTimeFrom") ?? 0) * 1000;
    return json(store().filter((r) =>
      (r.Occupancies ?? []).some((o) => new Date(o.DateTimeTo).getTime() > from)
    ));
  }

  const byId = route.match(/^\/Reservations\/(\d+)$/);
  if (method === "GET" && byId) {
    const found = store().find((r) => r.ReservationId === Number(byId[1]));
    return found ? json(found) : json({ Message: "Not found" }, 404);
  }

  if (method === "POST" && route === "/Reservations/") {
    const body = JSON.parse(String(init?.body ?? "{}")) as ReservationRequest;
    logMockedRequest("POST /Reservations/", body);
    const occupancy = body.Occupancies[0];
    const room = findMockRoom(body.ResourceId);
    if (!occupancy || !room) return json({ Message: "Unknown room or time" }, 400);
    const from = new Date(occupancy.DateTimeFrom);
    const to = new Date(occupancy.DateTimeTo);
    if (store().some((r) => r.ResourceId === room.RoomId && overlaps(r, from.getTime(), to.getTime()))) {
      return json({ Message: "Room is already reserved" }, 409);
    }
    const id = nextReservationId++;
    store().push({
      ReservationId: id,
      ResourceId: room.RoomId,
      Resource: room.Room,
      Designation: body.Designation,
      FurtherInformation: body.FurtherInformation,
      Status: "Bestätigt",
      StatusRemark: "Test mode: not sent to FHNW",
      IsCancelable: true,
      Occupancies: [{
        DateTimeFrom: apiTime(from), DateTimeTo: apiTime(to), Designation: body.Designation, Type: 20,
      }],
    });
    return new Response(null, { status: 201, headers: { location: `https://eviapi.fhnw.ch/Evento/api2/Reservations/${id}` } });
  }

  if (method === "DELETE" && byId) {
    logMockedRequest(`DELETE /Reservations/${byId[1]}`);
    const found = store().find((r) => r.ReservationId === Number(byId[1]));
    if (!found) return json({ Message: "Not found" }, 404);
    found.Status = "Storniert";
    return new Response(null, { status: 204 });
  }

  return json({ Message: `Test mode has no mock for ${method} ${route}` }, 501);
}
