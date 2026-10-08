import assert from "node:assert/strict";
import { test } from "node:test";
import { myReservationsFlow, reserveFlow } from "../dist/index.js";
import { previousReservationStep } from "../dist/reservation-navigation.js";
import { applyStartTime } from "../dist/ui.js";

const back = { kind: "back" };
const value = (answer) => ({ kind: "value", value: answer });
const auth = { clxAuthorization: "test", expiresAt: 0 };
const site = { id: 101, name: "Test campus", buildingIds: [] };
const room = {
  Room: "A101", RoomId: 10, RoomType: "Study", Building: "A", BuildingId: 1,
  Floor: "1", NumberPersons: 4, IsAvailable: true, IsBookable: true,
  Status: "Free", Occupancies: [],
};
const range = {
  fromUnix: 1_800_000_000, toUnix: 1_800_003_600,
  fromISO: "2027-01-15T08:00:00.000Z", toISO: "2027-01-15T09:00:00.000Z",
};
const reservation = {
  ReservationId: 20, ResourceId: 10, Resource: "A101", Designation: "Team",
  Status: "Bestätigt", StatusRemark: "", IsCancelable: true,
};

function dependencies() {
  return {
    selectSite: async () => value(site),
    promptDate: async () => value("08.10.2026"),
    promptStartTime: async () => value("12:00"),
    promptEndTime: async () => value({ range, endInput: "13:00" }),
    selectRoom: async () => value(room),
    promptReservationTitle: async () => value("Team"),
    promptReservationPersons: async () => value("3"),
    confirmReservation: async () => value("cancel"),
    fetchAvailableRooms: async () => [room],
    createReservation: async () => { throw new Error("Unexpected booking"); },
    notifyBooking: async () => {},
    waitForMainMenu: async () => {},
  };
}

test("each reservation step has exactly one predecessor", () => {
  assert.deepEqual(
    ["site", "date", "start", "end", "room", "title", "persons", "confirm"]
      .map(previousReservationStep),
    [null, "site", "date", "start", "end", "room", "title", "persons"]
  );
});

test("room Back revisits end time and confirmation Back revisits persons", async () => {
  const calls = { end: 0, room: 0, persons: 0, confirm: 0, fetch: 0 };
  const deps = {
    ...dependencies(),
    promptEndTime: async (_session, _siteName, draft) => {
      calls.end++;
      assert.equal(draft.endInput, "13:00");
      return value({ range, endInput: "13:00" });
    },
    fetchAvailableRooms: async () => { calls.fetch++; return [room]; },
    selectRoom: async () => ++calls.room === 1 ? back : value(room),
    promptReservationPersons: async () => { calls.persons++; return value("3"); },
    confirmReservation: async () => ++calls.confirm === 1 ? back : value("cancel"),
  };

  assert.equal(await reserveFlow({}, auth, deps), auth);
  assert.deepEqual(calls, { end: 2, room: 2, persons: 2, confirm: 2, fetch: 2 });
});

test("unchanged time retains a room suggestion only while it remains available", async () => {
  for (const stillAvailable of [true, false]) {
    const selectedRoomIds = [];
    let roomCalls = 0;
    let titleCalls = 0;
    let fetches = 0;
    const replacement = { ...room, RoomId: 30, Room: "B301" };
    const deps = {
      ...dependencies(),
      fetchAvailableRooms: async () => {
        fetches++;
        return fetches === 1 || stillAvailable ? [room] : [replacement];
      },
      selectRoom: async (_session, rooms, _siteName, _from, _to, selectedRoomId) => {
        selectedRoomIds.push(selectedRoomId);
        roomCalls++;
        return roomCalls === 2 ? back : value(rooms[0]);
      },
      promptReservationTitle: async () => ++titleCalls === 1 ? back : value("Team"),
    };

    assert.equal(await reserveFlow({}, auth, deps), auth);
    assert.deepEqual(selectedRoomIds, [undefined, room.RoomId, stillAvailable ? room.RoomId : undefined]);
  }
});

test("only explicit confirmation books once, even when notification fails", async () => {
  let bookings = 0;
  let confirmations = 0;
  let resultShown = 0;
  const deps = {
    ...dependencies(),
    confirmReservation: async () => ++confirmations === 1 ? back : value("confirm"),
    createReservation: async () => { bookings++; return reservation; },
    notifyBooking: async () => { throw new Error("Notification failed"); },
    waitForMainMenu: async () => { resultShown++; },
  };

  assert.equal(await reserveFlow({}, auth, deps), auth);
  assert.equal(bookings, 1);
  assert.equal(resultShown, 1);
});

test("entered end time survives a start change; generated end time follows it", () => {
  const entered = { date: "08.10.2026", startTime: "12:00", endInput: "14:30", endInputEdited: true };
  applyStartTime(entered, "12:30");
  assert.equal(entered.endInput, "14:30");

  const generated = { date: "08.10.2026", startTime: "12:00", endInput: "13:00", endInputEdited: false };
  applyStartTime(generated, "12:30");
  assert.equal(generated.endInput, "13:30");
});

test("going back to change campus reloads rooms and keeps entered suggestions", async () => {
  const otherSite = { ...site, id: 202, name: "Other campus" };
  const otherRoom = { ...room, RoomId: 30, Room: "B301" };
  const fetchedSites = [];
  const roomLists = [];
  const siteDefaults = [];
  const siteChoices = [site, otherSite];
  let dateCalls = 0;
  let startCalls = 0;
  let endCalls = 0;
  const deps = {
    ...dependencies(),
    selectSite: async (_session, defaultId) => {
      siteDefaults.push(defaultId);
      return value(siteChoices.shift());
    },
    promptDate: async (_session, _siteName, draft) => {
      dateCalls++;
      if (dateCalls === 2) return back;
      if (dateCalls === 3) assert.equal(draft.date, "08.10.2026");
      return value("08.10.2026");
    },
    promptStartTime: async (_session, _siteName, draft) => {
      startCalls++;
      if (startCalls === 2) return back;
      if (startCalls === 3) assert.equal(draft.startTime, "12:00");
      return value("12:00");
    },
    promptEndTime: async (_session, _siteName, draft) => {
      endCalls++;
      if (endCalls === 2) return back;
      if (endCalls === 3) assert.equal(draft.endInput, "13:00");
      return value({ range, endInput: "13:00" });
    },
    fetchAvailableRooms: async (_auth, siteId) => {
      fetchedSites.push(siteId);
      return siteId === site.id ? [room] : [otherRoom];
    },
    selectRoom: async (_session, rooms) => {
      roomLists.push(rooms.map((item) => item.RoomId));
      return roomLists.length === 1 ? back : value(otherRoom);
    },
  };

  assert.equal(await reserveFlow({}, auth, deps), auth);
  assert.deepEqual(siteDefaults, [undefined, site.id]);
  assert.deepEqual(fetchedSites, [site.id, otherSite.id]);
  assert.deepEqual(roomLists, [[room.RoomId], [otherRoom.RoomId]]);
});

test("cancellation Back never deletes and explicit confirmation deletes once", async () => {
  let selected = 0;
  let confirmed = 0;
  let deleted = 0;
  let resultShown = 0;
  const deps = {
    fetchMyReservations: async () => [reservation],
    selectReservationToCancel: async () => { selected++; return value(reservation); },
    confirmCancel: async () => ++confirmed === 1 ? back : value(true),
    cancelReservation: async (_auth, id) => {
      assert.equal(id, reservation.ReservationId);
      deleted++;
    },
    showResult: async () => { resultShown++; },
  };

  assert.equal(await myReservationsFlow({}, auth, deps), auth);
  assert.equal(selected, 2);
  assert.equal(deleted, 1);
  assert.equal(resultShown, 1);
});
