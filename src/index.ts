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
  selectNotifyAction,
  promptWebhookUrl,
  confirmRemoveWebhook,
  promptContact,
  selectContactToRemove,
  selectContactsToNotify,
} from "./ui.js";
import {
  loadNotifySettings,
  saveNotifySettings,
  formatBookingLines,
  postToTeams,
  buildTeamsChatLink,
  openUrl,
} from "./notify.js";
import type { AuthState, BookingNotice } from "./types.js";

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

  // Runs after withAuth() so a failing notification can never trigger a re-booking.
  try {
    await notifyBooking({
      room: selected.Room,
      building: selected.Building,
      floor: selected.Floor,
      from: new Date(fromUnix * 1000),
      to: new Date(toUnix * 1000),
      title,
      numPersons,
      reservationId: reservation.ReservationId,
    });
  } catch (err: any) {
    console.log(`  Booking is saved, but the notification was skipped: ${err.message}\n`);
  }
  return a2;
}

async function notifyBooking(notice: BookingNotice): Promise<void> {
  await shareToTeams("Room booked", [formatBookingLines(notice)]);
}

/** Posts via the webhook; falls back to a pre-filled Teams chat the user sends. */
async function shareToTeams(title: string, sections: string[][]): Promise<void> {
  const settings = loadNotifySettings();

  if (settings.teamsWebhookUrl) {
    try {
      await postToTeams(settings.teamsWebhookUrl, title, sections);
      console.log("  Posted to Teams.\n");
      return;
    } catch (err: any) {
      console.log(`  Could not post to Teams: ${err.message}`);
    }
  }

  if (settings.contacts.length === 0) {
    console.log("  Nothing sent: set a Teams webhook or add contacts under Notification settings.\n");
    return;
  }
  const recipients = await selectContactsToNotify(settings.contacts);
  if (recipients.length === 0) return;

  const message = [title, ...sections.map((lines) => lines.join("\n"))].join("\n\n");
  const link = buildTeamsChatLink(recipients.map((c) => c.email), message);
  try {
    await openUrl(link);
    console.log("  Opened Teams. Press Send there to share the booking.\n");
  } catch {
    console.log(`  Open this link to message them in Teams:\n  ${link}\n`);
  }
}

async function notificationSettingsFlow(): Promise<void> {
  while (true) {
    const settings = loadNotifySettings();
    const action = await selectNotifyAction(settings);

    if (action === "back") return;
    if (action === "set-webhook") {
      settings.teamsWebhookUrl = await promptWebhookUrl();
      saveNotifySettings(settings);
      console.log("  Webhook saved. Use \"Send test message\" to check it.");
    }
    if (action === "test-webhook" && settings.teamsWebhookUrl) {
      await postToTeams(settings.teamsWebhookUrl, "Room Reservator test", [
        ["Booking notifications are set up for this chat."],
      ]);
      console.log("  Test message sent. It should appear in the chat within a few seconds.");
    }
    if (action === "remove-webhook" && (await confirmRemoveWebhook())) {
      delete settings.teamsWebhookUrl;
      saveNotifySettings(settings);
      console.log("  Webhook removed.");
    }
    if (action === "add-contact") {
      const contact = await promptContact(settings.contacts);
      settings.contacts.push(contact);
      saveNotifySettings(settings);
      console.log(`  Added ${contact.name}.`);
    }
    if (action === "remove-contact") {
      const contact = await selectContactToRemove(settings.contacts);
      if (contact) {
        settings.contacts = settings.contacts.filter((c) => c.email !== contact.email);
        saveNotifySettings(settings);
        console.log(`  Removed ${contact.name}.`);
      }
    }
  }
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
      if (action === "notifications") await notificationSettingsFlow();
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
