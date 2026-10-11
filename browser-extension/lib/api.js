// Browser port of src/api.ts. Same endpoints, payloads and 401 handling; the
// Referer/Origin headers come from the session rule in header-rule.js.
import { personIdFromAuth } from "./token.js";

export const BASE = "https://eviapi.fhnw.ch/Evento/api2";
export const CANCELLED_STATUS = "Storniert";

export class AuthExpiredError extends Error {
  constructor() {
    super("AUTH_EXPIRED");
    this.name = "AuthExpiredError";
  }
}

export function createApi(auth, fetchImpl = fetch) {
  async function apiFetch(path, init = {}) {
    const response = await fetchImpl(`${BASE}${path}`, {
      ...init,
      headers: {
        "accept": "application/json, text/plain, */*",
        "content-type": "application/json",
        "clx-authorization": auth.clxAuthorization,
        ...init.headers,
      },
    });
    if (response.status === 401) throw new AuthExpiredError();
    return response;
  }

  async function fetchAvailableRooms(siteId, fromUnix, toUnix) {
    const res = await apiFetch(
      `/RoomReservation/Rooms/Available/?availableFrom=${fromUnix}&availableTo=${toUnix}&availableOnly=1&locations=${siteId}`
    );
    if (!res.ok) throw new Error(`Failed to fetch rooms (${res.status})`);
    const rooms = await res.json();
    return rooms.filter((room) => room.IsBookable && room.IsAvailable);
  }

  async function fetchMyReservations(fromUnix = Math.floor(Date.now() / 1000)) {
    const personId = personIdFromAuth(auth);
    const params = personId
      ? `PersonId=${personId}&DateTimeFrom=${fromUnix}`
      : `DateTimeFrom=${fromUnix}`;
    const res = await apiFetch(`/Reservations/?${params}`);
    if (!res.ok) throw new Error(`Failed to fetch reservations (${res.status})`);
    return res.json();
  }

  async function createReservation(roomId, fromISO, toISO, title, numPersons) {
    const body = {
      ResourceId: roomId,
      Designation: title,
      FurtherInformation: numPersons,
      Occupancies: [{ DateTimeFrom: fromISO, DateTimeTo: toISO }],
    };
    const res = await apiFetch("/Reservations/", { method: "POST", body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Reservation failed (${res.status}): ${text}`);
    }

    // The POST already succeeded, so a failed lookup must not look like a failed booking.
    const created = await findCreatedReservation(res, roomId, fromISO).catch(() => null);
    return created ?? {
      ReservationId: 0,
      ResourceId: roomId,
      Resource: "",
      Designation: title,
      Status: "Erstellt",
      StatusRemark: "Reservation created",
      IsCancelable: true,
    };
  }

  async function findCreatedReservation(postRes, roomId, fromISO) {
    // Location may be relative to the API root; anything outside it is ignored.
    const location = postRes.headers.get("location");
    const detailUrl = location ? new URL(location, `${BASE}/`).href : "";
    if (detailUrl.startsWith(`${BASE}/`)) {
      const detailRes = await apiFetch(detailUrl.slice(BASE.length));
      if (detailRes.ok) return detailRes.json();
    }

    // DateTimeFrom has no UTC offset, so Date parses it as local time, like the chosen start.
    const start = new Date(fromISO).getTime();
    const matches = (await fetchMyReservations()).filter(
      (r) =>
        r.ResourceId === roomId &&
        r.Status !== CANCELLED_STATUS &&
        r.Occupancies?.some((o) => new Date(o.DateTimeFrom).getTime() === start)
    );
    return matches.reduce(
      (newest, r) => (!newest || r.ReservationId > newest.ReservationId ? r : newest),
      null
    );
  }

  async function cancelReservation(reservationId) {
    const res = await apiFetch(`/Reservations/${reservationId}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) throw new Error(`Cancel failed (${res.status})`);
  }

  return { fetchAvailableRooms, fetchMyReservations, createReservation, cancelReservation };
}

/** Like the CLI's "My reservations": include ones in progress, drop cancelled and finished ones. */
export function upcomingReservations(reservations, nowMs = Date.now()) {
  return reservations
    .filter((r) => {
      if (r.Status === CANCELLED_STATUS) return false;
      const occupancies = r.Occupancies;
      return !occupancies?.length || occupancies.some((o) => new Date(o.DateTimeTo).getTime() > nowMs);
    })
    .sort((a, b) => startOf(a) - startOf(b));
}

function startOf(reservation) {
  const from = reservation.Occupancies?.[0]?.DateTimeFrom;
  return from ? new Date(from).getTime() : Number.POSITIVE_INFINITY;
}
