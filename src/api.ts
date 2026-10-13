import type { AuthState, AvailableRoom, Building, ReservationRequest, Reservation } from "./types.js";
import { buildHeaders } from "./auth.js";
import { SITES } from "./locations.js";
import { isTestMode, mockEventoFetch } from "./test-mode.js";

const BASE = "https://eviapi.fhnw.ch/Evento/api2";

function getPersonId(auth: AuthState): string | null {
  try {
    const tokenMatch = auth.clxAuthorization.match(/access_token=([^,\s]+)/);
    if (!tokenMatch) return null;
    const payload = JSON.parse(Buffer.from(tokenMatch[1]!.split(".")[1]!, "base64").toString());
    return payload.id_person ?? null;
  } catch {
    return null;
  }
}

async function apiFetch(auth: AuthState, path: string, init?: RequestInit): Promise<Response> {
  const headers = buildHeaders(auth);
  const send = isTestMode() ? mockEventoFetch : fetch;
  const response = await send(`${BASE}${path}`, {
    ...init,
    headers: { ...headers, ...init?.headers },
  });
  if (response.status === 401) throw new Error("AUTH_EXPIRED");
  return response;
}

export async function fetchBuildings(auth: AuthState): Promise<Building[]> {
  const res = await apiFetch(auth, "/Buildings/?hasRooms=true");
  if (!res.ok) throw new Error(`Failed to fetch buildings: ${res.status}`);
  return res.json() as Promise<Building[]>;
}

export async function fetchAvailableRooms(
  auth: AuthState,
  siteId: number,
  fromUnix: number,
  toUnix: number
): Promise<AvailableRoom[]> {
  const res = await apiFetch(
    auth,
    `/RoomReservation/Rooms/Available/?availableFrom=${fromUnix}&availableTo=${toUnix}&availableOnly=1&locations=${siteId}`
  );
  if (!res.ok) throw new Error(`Failed to fetch rooms: ${res.status}`);
  const rooms = await res.json() as AvailableRoom[];
  return rooms.filter((r) => r.IsBookable && r.IsAvailable);
}

/** The reservation payload has no campus ID, so locate its room with a free adjacent slice. */
export async function findAvailableRoomSite(
  auth: AuthState,
  roomId: number,
  fromUnix: number,
  toUnix: number
): Promise<number | null> {
  for (const site of SITES) {
    if (await isRoomAvailable(auth, site.id, roomId, fromUnix, toUnix)) return site.id;
  }
  return null;
}

export async function isRoomAvailable(
  auth: AuthState,
  siteId: number,
  roomId: number,
  fromUnix: number,
  toUnix: number
): Promise<boolean> {
  const rooms = await fetchAvailableRooms(auth, siteId, fromUnix, toUnix);
  return rooms.some((room) => room.RoomId === roomId);
}

/** Fetch the room's occupancy timeline using the web app's designation filter. */
export async function fetchRoomSchedule(
  auth: AuthState,
  roomId: number,
  designation: string,
  fromUnix: number,
  toUnix: number
): Promise<{ siteId: number; room: AvailableRoom } | null> {
  if (fromUnix >= toUnix) throw new RangeError("Invalid room schedule range");

  // Evento's timeline endpoint returns 500 when a request crosses midnight.
  // Ask for each local calendar day, as the FHNW web app does.
  const days: Array<{ fromUnix: number; toUnix: number }> = [];
  const day = new Date(fromUnix * 1000);
  day.setHours(0, 0, 0, 0);
  while (day.getTime() < toUnix * 1000) {
    const start = day.getTime();
    day.setDate(day.getDate() + 1);
    days.push({ fromUnix: start / 1000, toUnix: day.getTime() / 1000 - 1 });
  }

  for (const site of SITES) {
    const schedules = await Promise.all(days.map(async (dayRange) => {
      const params = new URLSearchParams({
        availableFrom: String(dayRange.fromUnix),
        availableTo: String(dayRange.toUnix),
        availableOnly: "1",
        locations: String(site.id),
        designations: designation,
        timespan: "300", // The shortest extension is five minutes.
      });
      const res = await apiFetch(auth, `/RoomReservation/Rooms/Available/?${params}`);
      if (!res.ok) throw new Error(`Failed to fetch room schedule (${res.status})`);
      const rooms = await res.json() as AvailableRoom[];
      return rooms.find((candidate) => candidate.RoomId === roomId && candidate.IsBookable) ?? null;
    }));
    const room = schedules.find((candidate) => candidate !== null);
    if (!room) continue;
    if (schedules.some((candidate) => candidate && !Array.isArray(candidate.Occupancies))) {
      throw new Error("Room schedule has no occupancy data");
    }
    return {
      siteId: site.id,
      room: {
        ...room,
        Occupancies: schedules.flatMap((candidate, index) => candidate?.Occupancies ?? [{
          DateTimeFrom: new Date(days[index]!.fromUnix * 1000).toISOString(),
          DateTimeTo: new Date((days[index]!.toUnix + 1) * 1000).toISOString(),
          Designation: null,
          Type: 10,
        }]),
      },
    };
  }
  return null;
}

export async function createReservation(
  auth: AuthState,
  roomId: number,
  fromISO: string,
  toISO: string,
  title: string,
  numPersons: string
): Promise<Reservation> {
  const body: ReservationRequest = {
    ResourceId: roomId,
    Designation: title,
    FurtherInformation: numPersons,
    Occupancies: [{ DateTimeFrom: fromISO, DateTimeTo: toISO }],
  };

  const res = await apiFetch(auth, "/Reservations/", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Reservation failed (${res.status}): ${text}`);
  }

  // The POST already succeeded, so lookup errors must not propagate: an
  // AUTH_EXPIRED here would make withAuth() retry and book the room twice.
  const created = await findCreatedReservation(auth, res, roomId, fromISO).catch(() => null);
  if (created) return created;

  return {
    ReservationId: 0,
    ResourceId: roomId,
    Resource: "",
    Designation: title,
    Status: "Erstellt",
    StatusRemark: "Reservation created",
    IsCancelable: true,
  };
}

async function findCreatedReservation(
  auth: AuthState,
  postRes: Response,
  roomId: number,
  fromISO: string
): Promise<Reservation | null> {
  // POST returns 201 with empty body — follow the Location header if present.
  // It may be relative (like the API's HRef fields), so resolve it against BASE.
  const location = postRes.headers.get("location");
  if (location) {
    const detailRes = await apiFetch(auth, new URL(location, BASE).href.replace(BASE, ""));
    if (detailRes.ok) return detailRes.json() as Promise<Reservation>;
  }

  // Otherwise find it among the user's reservations. DateTimeFrom has no UTC
  // offset, so Date parses it as local time, like the start the user entered.
  const start = new Date(fromISO).getTime();
  const matches = (await fetchMyReservations(auth)).filter(
    (r) =>
      r.ResourceId === roomId &&
      r.Status !== "Storniert" &&
      r.Occupancies?.some((o) => new Date(o.DateTimeFrom).getTime() === start)
  );
  // A cancelled-and-rebooked slot can still match twice; the newest ID is ours.
  return matches.reduce<Reservation | null>(
    (newest, r) => (!newest || r.ReservationId > newest.ReservationId ? r : newest),
    null
  );
}

export async function cancelReservation(auth: AuthState, reservationId: number): Promise<void> {
  const res = await apiFetch(auth, `/Reservations/${reservationId}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`Cancel failed (${res.status})`);
  }
}

export async function fetchMyReservations(
  auth: AuthState,
  fromUnix = Math.floor(Date.now() / 1000)
): Promise<Reservation[]> {
  const personId = getPersonId(auth);
  const params = personId
    ? `PersonId=${personId}&DateTimeFrom=${fromUnix}`
    : `DateTimeFrom=${fromUnix}`;
  const res = await apiFetch(auth, `/Reservations/?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch reservations: ${res.status}`);
  return res.json() as Promise<Reservation[]>;
}
