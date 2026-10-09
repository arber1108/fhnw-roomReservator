import assert from "node:assert/strict";
import { test } from "node:test";
import { findAvailableRoomSite, isRoomAvailable } from "../dist/api.js";
import { ExtensionSearch, findMaximumExtension } from "../dist/extension.js";
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

test("binary search finds the last contiguous available range", async () => {
  const booking = reservation("2027-01-15T09:00:00Z", "2027-01-15T10:00:00Z");
  const search = ExtensionSearch.forReservation(booking, "after", Date.parse("2027-01-15T08:00:00Z"));
  const checked = [];
  const maximum = await findMaximumExtension(search, async (range) => {
    checked.push(range.durationMinutes);
    return range.durationMinutes <= 65;
  });
  assert.equal(maximum, 13);
  assert.ok(checked.length < 10);
});

test("API probes known campuses for the exact room", async () => {
  const originalFetch = global.fetch;
  const sites = [];
  global.fetch = async (url) => {
    const parsed = new URL(url);
    sites.push(Number(parsed.searchParams.get("locations")));
    assert.equal(parsed.searchParams.get("availableOnly"), "1");
    return new Response(JSON.stringify(sites.length === 2
      ? [{ RoomId: 7, IsBookable: true, IsAvailable: true }]
      : []), { status: 200 });
  };
  try {
    const site = await findAvailableRoomSite(auth, 7, 1_800_000_000, 1_800_000_300);
    assert.equal(site, 211);
    assert.deepEqual(sites, [101, 211]);
    assert.equal(await isRoomAvailable(auth, 211, 8, 1_800_000_000, 1_800_000_300), false);
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
    findAvailableRoomSite: async () => 101,
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
  const deps = flowDependencies(booking, {
    isRoomAvailable: async (_auth, _site, _room, from, to) => {
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
