import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthExpiredError, BASE, createApi, upcomingReservations } from "../browser-extension/lib/api.js";
import { defaultDraft, parseEndTimeOrDuration, timeRangeFromForm } from "../browser-extension/lib/time.js";
import { authStateFromHeader, isAuthValid, personIdFromAuth } from "../browser-extension/lib/token.js";

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const header = (payload) => `access_token=${base64url({ alg: "none" })}.${base64url(payload)}.sig, token_type=Bearer`;

test("token expiry and person ID come from the JWT", () => {
  const auth = authStateFromHeader(header({ exp: 1_900_000_000, id_person: 1234 }));
  assert.equal(auth.expiresAt, 1_900_000_000_000);
  assert.equal(personIdFromAuth(auth), 1234);
  assert.equal(isAuthValid(auth, 1_899_999_999_000), true);
  assert.equal(isAuthValid(auth, 1_900_000_000_000), false);
  assert.equal(authStateFromHeader("garbage", 1000).expiresAt, 1000 + 600_000);
  assert.equal(personIdFromAuth({ clxAuthorization: "garbage" }), null);
});

test("end time and duration follow the CLI rules", () => {
  const start = new Date(2027, 0, 15, 13, 0);
  const minutes = (input) => {
    const parsed = parseEndTimeOrDuration(input, start);
    return "error" in parsed ? parsed.error : (parsed.end - start) / 60_000;
  };
  assert.equal(minutes("14:30"), 90);
  assert.equal(minutes("90m"), 90);
  assert.equal(minutes("1h 30m"), 90);
  assert.equal(minutes("1,5h"), 90);
  assert.equal(minutes("1.5"), 90);
  assert.equal(minutes("02:00"), 13 * 60); // rolls over to the next day
  assert.match(minutes("14:32"), /5-minute steps/);
  assert.match(minutes("17h"), /between 5 minutes and 16 hours/);
  assert.match(minutes("0m"), /between 5 minutes and 16 hours/);
  assert.match(minutes("soon"), /Use HH:mm/);
});

test("form range rejects off-step starts and returns unix and ISO times", () => {
  assert.match(timeRangeFromForm("2027-01-15", "13:10", "1h").error, /15-minute steps/);
  assert.match(timeRangeFromForm("2027-02-30", "13:00", "1h").error, /Invalid date/);
  const { range } = timeRangeFromForm("2027-01-15", "13:00", "14:00");
  const from = new Date(2027, 0, 15, 13, 0);
  assert.equal(range.fromUnix, from.getTime() / 1000);
  assert.equal(range.toUnix - range.fromUnix, 3600);
  assert.equal(range.fromISO, from.toISOString());
});

test("default draft starts at the next quarter hour for one hour", () => {
  assert.deepEqual(defaultDraft(new Date(2027, 0, 15, 13, 7)), {
    date: "2027-01-15", startTime: "13:15", endInput: "14:15",
  });
  assert.deepEqual(defaultDraft(new Date(2027, 0, 15, 23, 50)), {
    date: "2027-01-16", startTime: "00:00", endInput: "01:00",
  });
});

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

test("API requests carry the token and filter bookable rooms", async () => {
  const auth = authStateFromHeader(header({ exp: 1_900_000_000, id_person: 77 }));
  const rooms = [
    { RoomId: 1, IsBookable: true, IsAvailable: true },
    { RoomId: 2, IsBookable: false, IsAvailable: true },
    { RoomId: 3, IsBookable: true, IsAvailable: false },
  ];
  const { calls, fetchImpl } = fakeFetch(() => Response.json(rooms));
  const api = createApi(auth, fetchImpl);

  assert.deepEqual((await api.fetchAvailableRooms(101, 10, 20)).map((r) => r.RoomId), [1]);
  assert.equal(
    calls[0].url,
    `${BASE}/RoomReservation/Rooms/Available/?availableFrom=10&availableTo=20&availableOnly=1&locations=101`
  );
  assert.equal(calls[0].init.headers["clx-authorization"], auth.clxAuthorization);

  await api.fetchMyReservations(30);
  assert.equal(calls[1].url, `${BASE}/Reservations/?PersonId=77&DateTimeFrom=30`);
});

test("a 401 becomes AuthExpiredError", async () => {
  const { fetchImpl } = fakeFetch(() => new Response("", { status: 401 }));
  await assert.rejects(createApi({ clxAuthorization: "x" }, fetchImpl).fetchMyReservations(), AuthExpiredError);
});

test("booking follows the Location header after a 201", async () => {
  const created = { ReservationId: 99, Status: "Bestätigt" };
  let location = "Reservations/99";
  const { calls, fetchImpl } = fakeFetch((url, init) =>
    init.method === "POST"
      ? new Response(null, { status: 201, headers: { location } })
      : Response.json(created)
  );
  const api = createApi({ clxAuthorization: "x" }, fetchImpl);
  assert.deepEqual(await api.createReservation(5, "2027-01-15T12:00:00.000Z", "2027-01-15T13:00:00.000Z", "Team", "3"), created);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    ResourceId: 5, Designation: "Team", FurtherInformation: "3",
    Occupancies: [{ DateTimeFrom: "2027-01-15T12:00:00.000Z", DateTimeTo: "2027-01-15T13:00:00.000Z" }],
  });
  assert.equal(calls[1].url, `${BASE}/Reservations/99`);

  calls.length = 0;
  location = "/Evento/api2/Reservations/99";
  await api.createReservation(5, "2027-01-15T12:00:00.000Z", "2027-01-15T13:00:00.000Z", "Team", "3");
  assert.equal(calls[1].url, `${BASE}/Reservations/99`);
});

test("a failed lookup after a successful booking still reports success", async () => {
  const { fetchImpl } = fakeFetch((url, init) =>
    init.method === "POST" ? new Response(null, { status: 201 }) : new Response("", { status: 401 })
  );
  const result = await createApi({ clxAuthorization: "x" }, fetchImpl)
    .createReservation(5, "2027-01-15T12:00:00.000Z", "2027-01-15T13:00:00.000Z", "Team", "3");
  assert.equal(result.Status, "Erstellt");
});

test("upcoming reservations drop cancelled and finished ones, sorted by start", () => {
  const r = (id, from, to, status = "Bestätigt") => ({
    ReservationId: id, Status: status, Occupancies: [{ DateTimeFrom: from, DateTimeTo: to }],
  });
  const now = Date.parse("2027-01-15T12:00:00Z");
  const result = upcomingReservations([
    r(1, "2027-01-16T08:00:00Z", "2027-01-16T09:00:00Z"),
    r(2, "2027-01-15T08:00:00Z", "2027-01-15T09:00:00Z"),
    r(3, "2027-01-15T11:00:00Z", "2027-01-15T13:00:00Z"),
    r(4, "2027-01-15T14:00:00Z", "2027-01-15T15:00:00Z", "Storniert"),
  ], now);
  assert.deepEqual(result.map((x) => x.ReservationId), [3, 1]);
});
