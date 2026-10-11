import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, beforeEach } from "node:test";

// Keep the log and settings away from the real data folder, and fail loudly on any real request.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "roomreserve-test-"));
process.env.HOME = home;
delete process.env.APPDATA;
process.env.ROOMRESERVE_TEST_MODE = "1";
globalThis.fetch = async (url) => { throw new Error(`Real request in test mode: ${url}`); };

const { authenticate } = await import("../dist/auth.js");
const api = await import("../dist/api.js");
const notify = await import("../dist/notify.js");
const testMode = await import("../dist/test-mode.js");

const hour = 3600;
const start = Math.floor(Date.now() / 1000 / hour + 48) * hour;

beforeEach(() => testMode.resetMockEvento());

test("test mode turns on with the env var or a CLI flag", () => {
  assert.equal(testMode.isTestMode(), true);
  process.env.ROOMRESERVE_TEST_MODE = "0";
  assert.equal(testMode.isTestMode(), false);
  process.argv.push("--dry-run");
  assert.equal(testMode.isTestMode(), true);
  process.argv.pop();
  process.env.ROOMRESERVE_TEST_MODE = "1";
});

test("login returns a fake token without opening a browser", async () => {
  const auth = await authenticate(true);
  assert.match(auth.clxAuthorization, /^access_token=/);
  assert.ok(auth.expiresAt > Date.now());
});

test("booking, listing and cancelling only change mock data", async () => {
  const auth = await authenticate();
  const rooms = await api.fetchAvailableRooms(auth, 101, start, start + hour);
  assert.ok(rooms.length > 0);
  const room = rooms[0];

  const fromISO = new Date(start * 1000).toISOString();
  const toISO = new Date((start + hour) * 1000).toISOString();
  const created = await api.createReservation(auth, room.RoomId, fromISO, toISO, "Team", "3");
  assert.ok(created.ReservationId > 0);
  assert.equal(created.Resource, room.Room);
  assert.match(testMode.lastMockedRequest(), /^POST \/Reservations\/ /);

  const busy = await api.fetchAvailableRooms(auth, 101, start, start + hour);
  assert.ok(!busy.some((r) => r.RoomId === room.RoomId));
  assert.equal(await api.findAvailableRoomSite(auth, room.RoomId, start + hour, start + 2 * hour), 101);

  const mine = await api.fetchMyReservations(auth);
  assert.ok(mine.some((r) => r.ReservationId === created.ReservationId));

  await api.cancelReservation(auth, created.ReservationId);
  assert.equal(testMode.lastMockedRequest(), `DELETE /Reservations/${created.ReservationId}`);
  const free = await api.fetchAvailableRooms(auth, 101, start, start + hour);
  assert.ok(free.some((r) => r.RoomId === room.RoomId));

  const log = fs.readFileSync(testMode.TEST_LOG_FILE, "utf-8");
  assert.match(log, /POST \/Reservations\//);
  assert.match(log, /DELETE \/Reservations\//);
});

test("Teams posts and settings stay local", async () => {
  notify.saveNotifySettings({ teamsWebhookUrl: "https://example.invalid/hook", contacts: [] });
  assert.equal(notify.loadNotifySettings().teamsWebhookUrl, "https://example.invalid/hook");
  assert.equal(fs.existsSync(path.join(home, ".config", "roomreservator", "notify.json")), false);

  await notify.postToTeams("https://example.invalid/hook", "Room booked", [["A101"]]);
  const last = testMode.lastMockedRequest();
  assert.match(last, /^POST Teams webhook /);
  assert.doesNotMatch(last, /example\.invalid/);
});
