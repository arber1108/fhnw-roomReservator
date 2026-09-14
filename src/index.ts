import { authenticate } from "./auth.js";
import { fetchAvailableRooms, createReservation, fetchMyReservations, cancelReservation } from "./api.js";
import {
  selectAction,
  selectSite,
  getTimeRange,
  displayRooms,
  selectRoom,
  getReservationDetails,
  confirmReservation,
  displayReservations,
  selectReservationToCancel,
  confirmCancel,
} from "./ui.js";
import type { AuthState } from "./types.js";

async function withAuth<T>(
  auth: AuthState,
  fn: (a: AuthState) => Promise<T>
): Promise<{ result: T; auth: AuthState }> {
  try {
    return { result: await fn(auth), auth };
  } catch (err: any) {
    if (err.message === "AUTH_EXPIRED") {
      console.log("  Session expired, re-authenticating...");
      const newAuth = await authenticate(true);
      return { result: await fn(newAuth), auth: newAuth };
    }
    throw err;
  }
}

async function reserveFlow(auth: AuthState): Promise<AuthState> {
  const site = await selectSite();
  const { fromUnix, toUnix, fromISO, toISO } = await getTimeRange();

  console.log(`\n  Fetching rooms at ${site.name}...`);
  const { result: rooms, auth: a1 } = await withAuth(auth, (a) =>
    fetchAvailableRooms(a, site.id, fromUnix, toUnix)
  );
  auth = a1;

  displayRooms(rooms, fromUnix, toUnix);

  const selected = await selectRoom(rooms);
  if (!selected) return auth;

  const { title, numPersons } = await getReservationDetails();
  const ok = await confirmReservation(selected, fromUnix, toUnix, title, numPersons);
  if (!ok) {
    console.log("  Cancelled.\n");
    return auth;
  }

  console.log("\n  Reserving...");
  const { result: reservation, auth: a2 } = await withAuth(auth, (a) =>
    createReservation(a, selected.RoomId, fromISO, toISO, title, numPersons)
  );

  console.log(`\n  Reserved! ${reservation.Status} — ${reservation.StatusRemark || "OK"}`);
  console.log(`  Room: ${reservation.Resource || selected.Room}`);
  console.log(`  ID:   ${reservation.ReservationId}\n`);
  return a2;
}

async function myReservationsFlow(auth: AuthState): Promise<AuthState> {
  console.log("\n  Loading reservations...");
  const { result: reservations, auth: a1 } = await withAuth(auth, fetchMyReservations);
  auth = a1;

  displayReservations(reservations);

  const toCancel = await selectReservationToCancel(reservations);
  if (!toCancel) return auth;

  const ok = await confirmCancel(toCancel);
  if (!ok) {
    console.log("  Kept.\n");
    return auth;
  }

  console.log("\n  Cancelling...");
  const { auth: a2 } = await withAuth(auth, (a) =>
    cancelReservation(a, toCancel.ReservationId)
  );
  console.log(`  Reservation ${toCancel.ReservationId} cancelled.\n`);
  return a2;
}

async function main() {
  console.log("\n  FHNW Room Reservator\n  ────────────────────\n");

  if (process.argv.includes("--login")) {
    await authenticate(true);
    return;
  }

  let auth = await authenticate();

  while (true) {
    try {
      const action = await selectAction();

      if (action === "exit") break;
      if (action === "reserve") auth = await reserveFlow(auth);
      if (action === "my-reservations") auth = await myReservationsFlow(auth);
    } catch (err: any) {
      if (err.message?.includes("force closed") || err.message?.includes("ExitPrompt")) break;
      console.error(`\n  Error: ${err.message}\n`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
