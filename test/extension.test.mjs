import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchRoomSchedule } from "../dist/api.js";
import { ExtensionSearch, maximumExtensionFromOccupancies } from "../dist/extension.js";
import { myReservationsFlow } from "../dist/index.js";

const auth = { clxAuthorization: "test", expiresAt: Infinity };
const back = { kind: "back" };
const value = (answer) => ({ kind: "value", value: answer });

function reservation(from, to, details = {}) {
  return {
    ReservationId: 42, ResourceId: 7, Resource: "A101", Designation: "Team",
    FurtherInformation: "3", Status: "Bestätigt", StatusRemark: "", IsCancelable: true,
    Occupancies: [{ DateTimeFrom: from, DateTimeTo: to, Designation: null, Type: 20 }],
    ...details,
  };
}

test("before extension starts on a future quarter hour and remains adjacent", () => {
  const booking = reservation("2027-01-15T13:05:00Z", "2027-01-15T14:05:00Z");
  const search = ExtensionSearch.forReservation(booking, "before", Date.parse("2027-01-15T12:31:00Z"));
  assert.ok(search);
  assert.equal(search.maxUnits, 2);
  assert.deepEqual(search.range(1), {
    fromUnix: Date.parse("2027-01-15T13:00:00Z") / 1000,
    toUnix: Date.parse("2027-01-15T13:05:00Z") / 1000,
    durationMinutes: 5,
  });
  assert.equal(search.range(2).durationMinutes, 20);
  assert.equal(search.unitsForDuration(10, 2), null);
  assert.equal(ExtensionSearch.forReservation(booking, "before", Date.parse("2027-01-15T13:01:00Z")), null);
});

test("after extension shows the gap, handles ongoing reservations and caps at 16 hours", () => {
  const booking = reservation("2027-01-15T12:00:00Z", "2027-01-15T13:05:00Z");
  const search = ExtensionSearch.forReservation(booking, "after", Date.parse("2027-01-15T12:30:00Z"));
  assert.ok(search);
  assert.equal(search.gapMinutes, 10);
  assert.equal(search.range(1).fromUnix, Date.parse("2027-01-15T13:15:00Z") / 1000);
  assert.equal(search.range(search.maxUnits).durationMinutes, 16 * 60);
  assert.equal(ExtensionSearch.forReservation(booking, "before", Date.parse("2027-01-15T12:30:00Z")), null);
  assert.equal(ExtensionSearch.forReservation(booking, "after", Date.parse("2027-01-15T13:06:00Z")), null);
});

test("extension ranges use real elapsed time across midnight and daylight saving", () => {
  for (const [from, to] of [
    ["2027-01-15T23:30:00Z", "2027-01-16T00:05:00Z"],
    ["2027-03-28T00:30:00+01:00", "2027-03-28T03:05:00+02:00"],
  ]) {
    const booking = reservation(from, to);
    const search = ExtensionSearch.forReservation(booking, "after", Date.parse(from) + 60_000);
    assert.ok(search);
    assert.equal(search.range(12).durationMinutes, 60);
    assert.equal(search.range(12).toUnix - search.range(12).fromUnix, 3600);
  }
});

test("occupancies bound the contiguous extension at the next booking", () => {
  const booking = reservation("2027-01-15T09:00:00Z", "2027-01-15T10:00:00Z");
  const search = ExtensionSearch.forReservation(booking, "after", Date.parse("2027-01-15T08:00:00Z"));
  const maximum = maximumExtensionFromOccupancies(search, [
    { DateTimeFrom: "2027-01-15T09:00:00Z", DateTimeTo: "2027-01-15T10:00:00Z" },
    { DateTimeFrom: "2027-01-15T11:05:00Z", DateTimeTo: "2027-01-15T12:00:00Z" },
  ]);
  assert.equal(maximum, 13);
  assert.equal(maximumExtensionFromOccupancies(search, [
    { DateTimeFrom: "2027-01-15T10:00:00Z", DateTimeTo: "2027-01-15T10:30:00Z" },
  ]), 0);
});

test("schedule calculation handles before and across midnight", () => {
  const booking = reservation("2027-01-16T00:05:00Z", "2027-01-16T01:00:00Z");
  const before = ExtensionSearch.forReservation(booking, "before", Date.parse("2027-01-15T21:00:00Z"));
  assert.ok(before);
  assert.equal(maximumExtensionFromOccupancies(before, [
    { DateTimeFrom: "2027-01-15T23:00:00Z", DateTimeTo: "2027-01-15T23:30:00Z" },
  ]), 3); // 23:30–00:05; the next step would overlap the earlier booking.

  const after = ExtensionSearch.forReservation(booking, "after", Date.parse("2027-01-15T21:00:00Z"));
  assert.ok(after);
  assert.equal(maximumExtensionFromOccupancies(after, [
    { DateTimeFrom: "2027-01-16T01:20:00Z", DateTimeTo: "2027-01-16T02:00:00Z" },
  ]), 4);
});

test("targeted schedule query probes campuses and verifies the room ID", async () => {
  const originalFetch = global.fetch;
  const sites = [];
  global.fetch = async (url) => {
    const parsed = new URL(url);
    sites.push(Number(parsed.searchParams.get("locations")));
    assert.equal(parsed.searchParams.get("availableOnly"), "1");
    assert.equal(parsed.searchParams.get("designations"), "A101");
    assert.equal(parsed.searchParams.get("timespan"), "300");
    return new Response(JSON.stringify(sites.length === 2
      ? [{ RoomId: 8, IsBookable: true }, { RoomId: 7, IsBookable: true, Occupancies: [] }]
      : []), { status: 200 });
  };
  try {
    const found = await fetchRoomSchedule(auth, 7, "A101", 1_800_000_000, 1_800_003_600);
    assert.equal(found.siteId, 211);
    assert.equal(found.room.RoomId, 7);
    assert.deepEqual(sites, [101, 211]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("schedule queries stay within local days across midnight", async () => {
  const originalFetch = global.fetch;
  const start = Math.floor(new Date(2027, 0, 15, 23, 30).getTime() / 1000);
  const end = Math.floor(new Date(2027, 0, 16, 1, 30).getTime() / 1000);
  const requestedDays = [];
  global.fetch = async (url) => {
    const parsed = new URL(url);
    const from = Number(parsed.searchParams.get("availableFrom"));
    const to = Number(parsed.searchParams.get("availableTo"));
    assert.equal(new Date(from * 1000).getHours(), 0);
    assert.equal(new Date((to + 1) * 1000).getHours(), 0);
    assert.equal(new Date(to * 1000).getDate(), new Date(from * 1000).getDate());
    requestedDays.push(new Date(from * 1000).getDate());
    return new Response(JSON.stringify(requestedDays.length === 1 ? [] : [
      { RoomId: 7, IsBookable: true, Occupancies: [] },
    ]), { status: 200 });
  };
  try {
    const found = await fetchRoomSchedule(auth, 7, "A101", start, end);
    assert.deepEqual(requestedDays, [15, 16]);
    assert.equal(found?.siteId, 101);
    assert.equal(found?.room.Occupancies.length, 1);
    assert.equal(new Date(found.room.Occupancies[0].DateTimeTo).getTime(),
      new Date(2027, 0, 16).getTime());
  } finally {
    global.fetch = originalFetch;
  }
});

function flowDependencies(booking, overrides = {}) {
  let selections = 0;
  return {
    fetchMyReservations: async () => [booking],
    selectReservation: async () => ++selections === 1 ? value(booking) : back,
    selectReservationAction: async () => value("extend"),
    selectExtensionDirection: async () => value("after"),
    fetchRoomSchedule: async () => ({ siteId: 101, room: { Occupancies: [
      booking.Occupancies[0],
      { DateTimeFrom: "2027-01-15T10:15:00Z", DateTimeTo: "2027-01-15T11:00:00Z" },
    ] } }),
    isRoomAvailable: async (_auth, _site, _room, from, to) => to - from <= 15 * 60,
    promptExtensionDuration: async () => value(2),
    promptExtensionPersons: async () => { throw new Error("Unexpected persons prompt"); },
    confirmExtension: async () => value(true),
    createReservation: async () => ({ ReservationId: 43 }),
    notifyBooking: async () => {},
    waitForMainMenu: async () => {},
    showResult: async () => {},
    ...overrides,
  };
}

test("confirmed extension rechecks availability and books once", async () => {
  const booking = reservation("2027-01-15T09:00:00Z", "2027-01-15T10:00:00Z");
  let creates = 0;
  let notifications = 0;
  let finalChecks = 0;
  let availabilityChecks = 0;
  const deps = flowDependencies(booking, {
    isRoomAvailable: async (_auth, _site, _room, from, to) => {
      availabilityChecks++;
      if (to - from === 10 * 60) finalChecks++;
      return to - from <= 15 * 60;
    },
    createReservation: async (_auth, roomId, fromISO, toISO, title, persons) => {
      creates++;
      assert.deepEqual([roomId, fromISO, toISO, title, persons], [
        7, "2027-01-15T10:00:00.000Z", "2027-01-15T10:10:00.000Z", "Team", "3",
      ]);
      return { ReservationId: 43 };
    },
    notifyBooking: async (_session, notice) => {
      notifications++;
      assert.equal(notice.reservationId, 43);
    },
  });
  assert.equal(await myReservationsFlow({}, auth, deps), auth);
  assert.equal(creates, 1);
  assert.equal(notifications, 1);
  assert.ok(finalChecks >= 1);
  assert.equal(availabilityChecks, 2);
});

test("API availability limits the schedule when other booking rules apply", async () => {
  const booking = reservation("2027-01-15T09:00:00Z", "2027-01-15T10:00:00Z");
  let checks = 0;
  const deps = flowDependencies(booking, {
    fetchRoomSchedule: async () => ({ siteId: 101, room: { Occupancies: [booking.Occupancies[0]] } }),
    isRoomAvailable: async (_auth, _site, _room, from, to) => {
      checks++;
      return to - from <= 15 * 60;
    },
    promptExtensionDuration: async (_session, _reservation, _search, maximum) => {
      assert.equal(maximum, 3);
      return value(2);
    },
  });
  assert.equal(await myReservationsFlow({}, auth, deps), auth);
  assert.ok(checks > 2); // The short probing fallback ran.
});

test("back, declined confirmation and changed availability never book", async () => {
  const booking = reservation("2027-01-15T09:00:00Z", "2027-01-15T10:00:00Z");
  for (const outcome of ["back", "decline", "changed"]) {
    let creates = 0;
    let directions = 0;
    const deps = flowDependencies(booking, {
      selectExtensionDirection: async () => ++directions === 1 ? value("after") : back,
      promptExtensionDuration: async () => outcome === "back" ? back : value(2),
      confirmExtension: async () => value(outcome !== "decline"),
      isRoomAvailable: async (_auth, _site, _room, from, to) => {
        return outcome !== "changed" || to - from !== 10 * 60;
      },
      createReservation: async () => { creates++; return { ReservationId: 43 }; },
    });
    assert.equal(await myReservationsFlow({}, auth, deps), auth);
    assert.equal(creates, 0);
  }
});

test("missing persons are requested and notification errors do not repeat the booking", async () => {
  const booking = reservation("2027-01-15T09:00:00Z", "2027-01-15T10:00:00Z", {
    FurtherInformation: undefined,
  });
  let personsPrompts = 0;
  let creates = 0;
  const deps = flowDependencies(booking, {
    promptExtensionPersons: async () => { personsPrompts++; return value("4"); },
    createReservation: async (_auth, _room, _from, _to, _title, persons) => {
      creates++;
      assert.equal(persons, "4");
      return { ReservationId: 43 };
    },
    notifyBooking: async () => { throw new Error("Teams unavailable"); },
  });
  assert.equal(await myReservationsFlow({}, auth, deps), auth);
  assert.equal(personsPrompts, 1);
  assert.equal(creates, 1);
});
