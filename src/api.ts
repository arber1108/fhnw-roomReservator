import type { AuthState, AvailableRoom, Building, ReservationRequest, Reservation } from "./types.js";
import { buildHeaders } from "./auth.js";

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
  const response = await fetch(`${BASE}${path}`, {
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

  // POST returns 201 with empty body — fetch the reservation to get details
  const location = res.headers.get("location");
  if (location) {
    const detailRes = await apiFetch(auth, location.replace(BASE, "").replace("https://eviapi.fhnw.ch/Evento/api2", ""));
    if (detailRes.ok) return detailRes.json() as Promise<Reservation>;
  }

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

export async function cancelReservation(auth: AuthState, reservationId: number): Promise<void> {
  const res = await apiFetch(auth, `/Reservations/${reservationId}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`Cancel failed (${res.status})`);
  }
}

export async function fetchMyReservations(auth: AuthState): Promise<Reservation[]> {
  const nowUnix = Math.floor(Date.now() / 1000);
  const personId = getPersonId(auth);
  const params = personId
    ? `PersonId=${personId}&DateTimeFrom=${nowUnix}`
    : `DateTimeFrom=${nowUnix}`;
  const res = await apiFetch(auth, `/Reservations/?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch reservations: ${res.status}`);
  return res.json() as Promise<Reservation[]>;
}
