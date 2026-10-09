import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { PromptSession } from "../dist/prompt-session.js";
import {
  selectAction,
  promptDate,
  promptStartTime,
  promptEndTime,
  selectRoom,
  selectReservation,
  selectReservationAction,
  selectExtensionDirection,
  selectNotifyAction,
  selectContactsToNotify,
  confirmRemoveWebhook,
  promptWebhookUrl,
} from "../dist/ui.js";

class FakeTerminal extends PassThrough {
  isTTY = true;
  isRaw = false;
  rawModes = [];

  setRawMode(mode) {
    this.isRaw = mode;
    this.rawModes.push(mode);
    return this;
  }
}

async function press(terminal, bytes) {
  await delay(20);
  terminal.write(Buffer.from(bytes));
}

test("raw s and w keys move one menu item each", async () => {
  const terminal = new FakeTerminal();
  const session = new PromptSession(terminal);
  try {
    const selection = selectAction(session);
    await press(terminal, "s");
    await press(terminal, "s");
    await press(terminal, "w");
    await press(terminal, "\r");
    assert.equal(await selection, "my-reservations");
  } finally {
    session.close();
  }
  assert.deepEqual(terminal.rawModes, [true, false]);
  assert.equal(terminal.listenerCount("data"), 0);
});

test("Enter, Esc, Enter, Esc remains responsive with retained defaults", async () => {
  const terminal = new FakeTerminal();
  const session = new PromptSession(terminal);
  const draft = { date: "08.10.2026", startTime: "12:00", endInput: "13:00" };
  try {
    let selection = promptDate(session, "Test", draft);
    await press(terminal, "\r");
    assert.deepEqual(await selection, { kind: "value", value: draft.date });

    selection = promptStartTime(session, "Test", draft);
    await press(terminal, "\r");
    assert.deepEqual(await selection, { kind: "value", value: draft.startTime });

    selection = promptEndTime(session, "Test", draft);
    await press(terminal, "\x1b");
    assert.deepEqual(await selection, { kind: "back" });

    selection = promptStartTime(session, "Test", draft);
    await press(terminal, "\r");
    assert.deepEqual(await selection, { kind: "value", value: draft.startTime });

    selection = promptEndTime(session, "Test", draft);
    await press(terminal, "\x1b");
    assert.deepEqual(await selection, { kind: "back" });

    selection = promptStartTime(session, "Test", draft);
    await press(terminal, "\x1b");
    assert.deepEqual(await selection, { kind: "back" });
    selection = promptDate(session, "Test", draft);
    await press(terminal, "\x1b");
    assert.deepEqual(await selection, { kind: "back" });

    selection = promptDate(session, "Test", draft);
    await press(terminal, "\r");
    assert.deepEqual(await selection, { kind: "value", value: draft.date });
  } finally {
    session.close();
  }
  assert.deepEqual(terminal.rawModes, [true, false]);
  assert.equal(terminal.listenerCount("data"), 0);
});

test("Esc backs out of a submenu and Ctrl+C still exits its prompt", async () => {
  const terminal = new FakeTerminal();
  const session = new PromptSession(terminal);
  try {
    let selection = selectNotifyAction(session, { contacts: [] });
    await press(terminal, "\x1b");
    assert.deepEqual(await selection, { kind: "back" });

    selection = selectContactsToNotify(session, [{ name: "A", email: "a@fhnw.ch" }]);
    await press(terminal, "\x1b");
    assert.deepEqual(await selection, { kind: "back" });

    selection = confirmRemoveWebhook(session);
    await press(terminal, "\x1b");
    assert.deepEqual(await selection, { kind: "back" });

    selection = promptWebhookUrl(session);
    await press(terminal, "\x1b");
    assert.deepEqual(await selection, { kind: "back" });

    selection = selectAction(session);
    await press(terminal, "\x1b");
    await delay(550);
    await press(terminal, "\x03");
    await assert.rejects(selection, (error) => error.name === "ExitPromptError");
  } finally {
    session.close();
  }
  assert.deepEqual(terminal.rawModes, [true, false]);
  assert.equal(terminal.listenerCount("data"), 0);
});

test("returning from details keeps the previously selected room highlighted", async () => {
  const terminal = new FakeTerminal();
  const session = new PromptSession(terminal);
  const rooms = [
    { RoomId: 10, Room: "A101", Building: "A", Floor: "1", NumberPersons: 4, RoomType: "Study" },
    { RoomId: 20, Room: "B202", Building: "B", Floor: "2", NumberPersons: 6, RoomType: "Group" },
  ];
  try {
    let selection = selectRoom(session, rooms, "Test", 1_800_000_000, 1_800_003_600);
    await press(terminal, "s");
    await press(terminal, "\r");
    assert.equal((await selection).value.RoomId, 20);

    selection = selectRoom(session, rooms, "Test", 1_800_000_000, 1_800_003_600, 20);
    await press(terminal, "\r");
    assert.equal((await selection).value.RoomId, 20);
  } finally {
    session.close();
  }
  assert.deepEqual(terminal.rawModes, [true, false]);
  assert.equal(terminal.listenerCount("data"), 0);
});

test("reservation menu reaches extension and Esc returns from direction selection", async () => {
  const terminal = new FakeTerminal();
  const session = new PromptSession(terminal);
  const booking = {
    ReservationId: 42, ResourceId: 7, Resource: "A101", Designation: "Team",
    Status: "Bestätigt", IsCancelable: true,
    Occupancies: [{ DateTimeFrom: "2027-01-15T09:00:00Z", DateTimeTo: "2027-01-15T10:00:00Z" }],
  };
  try {
    let selection = selectReservation(session, [booking]);
    await press(terminal, "\r");
    assert.equal((await selection).value.ReservationId, 42);

    selection = selectReservationAction(session, booking);
    await press(terminal, "\r");
    assert.deepEqual(await selection, { kind: "value", value: "extend" });

    selection = selectExtensionDirection(session, booking);
    await press(terminal, "\x1b");
    assert.deepEqual(await selection, { kind: "back" });
  } finally {
    session.close();
  }
});
