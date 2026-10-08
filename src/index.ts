import { authenticate } from "./auth.js";
import dayjs from "dayjs";
import { fetchAvailableRooms, createReservation, fetchMyReservations, cancelReservation } from "./api.js";
import {
  selectAction,
  selectSite,
  createTimeRangeDraft,
  promptDate,
  promptStartTime,
  applyStartTime,
  promptEndTime,
  formatPeriod,
  selectRoom,
  promptReservationTitle,
  promptReservationPersons,
  confirmReservation,
  selectReservationToCancel,
  confirmCancel,
  selectNotifyAction,
  promptWebhookUrl,
  confirmRemoveWebhook,
  promptContactName,
  promptContactEmail,
  selectContactToRemove,
  selectContactsToNotify,
  selectBookingsToShare,
  showStep,
  showResult,
  waitForMainMenu,
} from "./ui.js";
import {
  loadNotifySettings,
  saveNotifySettings,
  formatBookingLines,
  postToTeams,
  buildTeamsChatLink,
  openUrl,
} from "./notify.js";
import { PromptSession, PromptInterruptedError } from "./prompt-session.js";
import { previousReservationStep } from "./reservation-navigation.js";
import type { ReservationStep } from "./reservation-navigation.js";
import type { AuthState, AvailableRoom, BookingNotice, Reservation, Site } from "./types.js";
import type { TimeRange } from "./ui.js";

const CONFIRMED_STATUS = "Bestätigt";

function isPromptExit(error: unknown): boolean {
  return error instanceof PromptInterruptedError ||
    (error instanceof Error && error.name === "ExitPromptError");
}

export const reservationFlowDependencies = {
  selectSite,
  promptDate,
  promptStartTime,
  promptEndTime,
  selectRoom,
  promptReservationTitle,
  promptReservationPersons,
  confirmReservation,
  fetchAvailableRooms,
  createReservation,
  notifyBooking,
  waitForMainMenu,
};
export type ReservationFlowDependencies = typeof reservationFlowDependencies;

export const cancellationFlowDependencies = {
  fetchMyReservations,
  selectReservationToCancel,
  confirmCancel,
  cancelReservation,
  showResult,
};
export type CancellationFlowDependencies = typeof cancellationFlowDependencies;

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

export async function reserveFlow(
  session: PromptSession,
  auth: AuthState,
  overrides: Partial<ReservationFlowDependencies> = {}
): Promise<AuthState> {
  const deps = { ...reservationFlowDependencies, ...overrides };
  const timeDraft = createTimeRangeDraft();
  let step: ReservationStep | null = "site";
  let site: Site | undefined;
  let timeRange: TimeRange | undefined;
  let rooms: AvailableRoom[] = [];
  let room: AvailableRoom | undefined;
  const details = { title: "Gruppenarbeit", numPersons: "1" };

  while (step !== null) {
    if (step === "site") {
      const choice = await deps.selectSite(session, site?.id);
      if (choice.kind === "back") return auth;
      if (site?.id !== choice.value.id) {
        timeRange = undefined;
        rooms = [];
        room = undefined;
      }
      site = choice.value;
      step = "date";
      continue;
    }
    if (!site) throw new Error("Missing campus in reservation flow");

    if (step === "date") {
      const choice = await deps.promptDate(session, site.name, timeDraft);
      if (choice.kind === "back") {
        step = previousReservationStep(step);
      } else {
        if (choice.value !== timeDraft.date) {
          timeRange = undefined;
          rooms = [];
          room = undefined;
        }
        timeDraft.date = choice.value;
        step = "start";
      }
      continue;
    }

    if (step === "start") {
      const choice = await deps.promptStartTime(session, site.name, timeDraft);
      if (choice.kind === "back") {
        step = previousReservationStep(step);
      } else {
        if (choice.value !== timeDraft.startTime) {
          timeRange = undefined;
          rooms = [];
          room = undefined;
        }
        applyStartTime(timeDraft, choice.value);
        step = "end";
      }
      continue;
    }

    if (step === "end") {
      const choice = await deps.promptEndTime(session, site.name, timeDraft);
      if (choice.kind === "back") {
        step = previousReservationStep(step);
        continue;
      }
      if (choice.value.endInput !== timeDraft.endInput) timeDraft.endInputEdited = true;
      timeDraft.endInput = choice.value.endInput;
      const rangeChanged = !timeRange ||
        timeRange.fromUnix !== choice.value.range.fromUnix ||
        timeRange.toUnix !== choice.value.range.toUnix;
      timeRange = choice.value.range;
      const selectedSite = site;
      const selectedRange = timeRange;
      if (rangeChanged) room = undefined;
      showStep("Searching rooms", [
        `Campus: ${site.name}`,
        `Time: ${formatPeriod(timeRange.fromUnix, timeRange.toUnix)}`,
      ]);
      console.log("  Fetching available rooms...");
      const fetched = await withAuth(auth, (a) =>
        deps.fetchAvailableRooms(a, selectedSite.id, selectedRange.fromUnix, selectedRange.toUnix)
      );
      auth = fetched.auth;
      rooms = fetched.result;
      room = rooms.find((available) => available.RoomId === room?.RoomId);
      step = "room";
      continue;
    }

    if (!timeRange) throw new Error("Missing time range in reservation flow");
    const { fromUnix, toUnix, fromISO, toISO } = timeRange;

    if (step === "room") {
      const choice = await deps.selectRoom(session, rooms, site.name, fromUnix, toUnix, room?.RoomId);
      if (choice.kind === "back") {
        step = previousReservationStep(step);
      } else {
        room = choice.value;
        step = "title";
      }
      continue;
    }

    if (!room) throw new Error("Missing room in reservation flow");
    const context = { siteName: site.name, room, fromUnix, toUnix };

    if (step === "title") {
      const choice = await deps.promptReservationTitle(session, context, details.title);
      if (choice.kind === "back") {
        step = previousReservationStep(step);
      } else {
        details.title = choice.value;
        step = "persons";
      }
      continue;
    }

    if (step === "persons") {
      const choice = await deps.promptReservationPersons(session, context, details.title, details.numPersons);
      if (choice.kind === "back") {
        step = previousReservationStep(step);
      } else {
        details.numPersons = choice.value;
        step = "confirm";
      }
      continue;
    }

    const confirmation = await deps.confirmReservation(
      session, room, fromUnix, toUnix, details.title, details.numPersons
    );
    if (confirmation.kind === "back") {
      step = previousReservationStep("confirm");
      continue;
    }
    if (confirmation.value === "cancel") return auth;

    showStep("Reserving room", [
      `Room: ${room.Room}`,
      `Time: ${formatPeriod(fromUnix, toUnix)}`,
    ]);
    console.log("  Sending reservation...");
    const { result: reservation, auth: updatedAuth } = await withAuth(auth, (a) =>
      deps.createReservation(a, room!.RoomId, fromISO, toISO, details.title, details.numPersons)
    );

    showStep("Room reserved", [
      `Status: ${reservation.Status} — ${reservation.StatusRemark || "OK"}`,
      `Room: ${reservation.Resource || room.Room}`,
      `ID: ${reservation.ReservationId}`,
    ]);

    // A notification failure must never trigger another reservation.
    try {
      await deps.notifyBooking(session, {
        room: room.Room,
        building: room.Building,
        floor: room.Floor,
        from: new Date(fromUnix * 1000),
        to: new Date(toUnix * 1000),
        title: details.title,
        numPersons: details.numPersons,
        reservationId: reservation.ReservationId,
      });
    } catch (err) {
      if (isPromptExit(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  Booking is saved, but the notification was skipped: ${message}\n`);
    }
    await deps.waitForMainMenu(session);
    return updatedAuth;
  }
  return auth;
}

async function notifyBooking(session: PromptSession, notice: BookingNotice): Promise<void> {
  await shareToTeams(session, "Room booked", [formatBookingLines(notice)]);
}

/** Posts via the webhook; falls back to a pre-filled Teams chat the user sends. */
async function shareToTeams(session: PromptSession, title: string, sections: string[][]): Promise<"done" | "back"> {
  const settings = loadNotifySettings();

  if (settings.teamsWebhookUrl) {
    try {
      await postToTeams(settings.teamsWebhookUrl, title, sections);
      console.log("  Posted to Teams.\n");
      return "done";
    } catch (err: any) {
      console.log(`  Could not post to Teams: ${err.message}`);
    }
  }

  if (settings.contacts.length === 0) {
    console.log("  Nothing sent: set a Teams webhook or add contacts under Notification settings.\n");
    return "done";
  }
  const recipients = await selectContactsToNotify(session, settings.contacts);
  if (recipients.kind === "back") return "back";
  if (recipients.value.length === 0) return "done";

  const message = [title, ...sections.map((lines) => lines.join("\n"))].join("\n\n");
  const link = buildTeamsChatLink(recipients.value.map((c) => c.email), message);
  try {
    await openUrl(link);
    console.log("  Opened Teams. Press Send there to share the booking.\n");
  } catch {
    console.log(`  Open this link to message them in Teams:\n  ${link}\n`);
  }
  return "done";
}

async function notificationSettingsFlow(session: PromptSession): Promise<void> {
  while (true) {
    const settings = loadNotifySettings();
    const selection = await selectNotifyAction(session, settings);
    if (selection.kind === "back") return;
    const action = selection.value;

    if (action === "set-webhook") {
      const url = await promptWebhookUrl(session);
      if (url.kind === "back") continue;
      settings.teamsWebhookUrl = url.value;
      saveNotifySettings(settings);
      console.log("  Webhook saved. Use \"Send test message\" to check it.");
    }
    if (action === "test-webhook" && settings.teamsWebhookUrl) {
      await postToTeams(settings.teamsWebhookUrl, "Room Reservator test", [
        ["Booking notifications are set up for this chat."],
      ]);
      console.log("  Test message sent. It should appear in the chat within a few seconds.");
    }
    if (action === "remove-webhook") {
      const answer = await confirmRemoveWebhook(session);
      if (answer.kind === "value" && answer.value) {
        delete settings.teamsWebhookUrl;
        saveNotifySettings(settings);
        console.log("  Webhook removed.");
      }
    }
    if (action === "add-contact") {
      let name = "";
      while (true) {
        const enteredName = await promptContactName(session, name);
        if (enteredName.kind === "back") break;
        name = enteredName.value;
        const email = await promptContactEmail(session, settings.contacts);
        if (email.kind === "back") continue;
        settings.contacts.push({ name, email: email.value });
        saveNotifySettings(settings);
        console.log(`  Added ${name}.`);
        break;
      }
    }
    if (action === "remove-contact") {
      const contact = await selectContactToRemove(session, settings.contacts);
      if (contact.kind === "value") {
        settings.contacts = settings.contacts.filter((c) => c.email !== contact.value.email);
        saveNotifySettings(settings);
        console.log(`  Removed ${contact.value.name}.`);
      }
    }
  }
}

export async function myReservationsFlow(
  session: PromptSession,
  auth: AuthState,
  overrides: Partial<CancellationFlowDependencies> = {}
): Promise<AuthState> {
  const deps = { ...cancellationFlowDependencies, ...overrides };
  showStep("My reservations");
  console.log("  Loading reservations...");
  const { result: reservations, auth: a1 } = await withAuth(auth, deps.fetchMyReservations);
  auth = a1;

  while (true) {
    const toCancel = await deps.selectReservationToCancel(session, reservations);
    if (toCancel.kind === "back") return auth;

    const ok = await deps.confirmCancel(session, toCancel.value);
    if (ok.kind === "back" || !ok.value) continue;

    showStep("Cancelling reservation");
    console.log("  Cancelling...");
    const { auth: a2 } = await withAuth(auth, (a) =>
      deps.cancelReservation(a, toCancel.value.ReservationId)
    );
    await deps.showResult(session, "Reservation cancelled", [
      `Reservation ${toCancel.value.ReservationId} was cancelled.`,
    ]);
    return a2;
  }
}

function toBookingNotice(r: Reservation): BookingNotice | null {
  const occ = r.Occupancies?.[0];
  if (!occ) return null;
  return {
    room: r.Resource,
    from: new Date(occ.DateTimeFrom),
    to: new Date(occ.DateTimeTo),
    title: r.Designation,
    numPersons: r.FurtherInformation ?? "",
    reservationId: r.ReservationId,
  };
}

/** Re-posts today's and tomorrow's confirmed bookings that haven't ended yet. */
async function shareBookingsFlow(session: PromptSession, auth: AuthState, pickBookings: boolean): Promise<AuthState> {
  console.log("\n  Loading today's and tomorrow's bookings...");
  // Query from midnight so bookings that are already running are included.
  const startOfToday = dayjs().startOf("day").unix();
  const { result: reservations, auth: a1 } = await withAuth(auth, (a) =>
    fetchMyReservations(a, startOfToday)
  );

  const now = new Date();
  const endOfTomorrow = dayjs().add(1, "day").endOf("day").toDate();
  const current = reservations
    .filter((r) => r.Status === CONFIRMED_STATUS)
    .map(toBookingNotice)
    .filter((b): b is BookingNotice => b !== null && b.to > now && b.from <= endOfTomorrow)
    .sort((a, b) => a.from.getTime() - b.from.getTime());

  if (current.length === 0) {
    console.log("  No confirmed bookings left for today or tomorrow.\n");
    if (pickBookings) await waitForMainMenu(session);
    return a1;
  }

  let previousChoice: BookingNotice[] | undefined;
  while (true) {
    const chosen = pickBookings
      ? await selectBookingsToShare(session, current, previousChoice)
      : { kind: "value" as const, value: current };
    if (chosen.kind === "back" || chosen.value.length === 0) return a1;
    previousChoice = chosen.value;

    const outcome = await shareToTeams(
      session,
      chosen.value.length === 1 ? "Our booking" : "Our bookings",
      chosen.value.map(formatBookingLines)
    );
    if (outcome === "back" && pickBookings) continue;
    if (pickBookings) await waitForMainMenu(session);
    return a1;
  }
}

async function main() {
  console.log("\n  FHNW Room Reservator\n  ────────────────────\n");

  if (process.argv.includes("--login")) {
    await authenticate(true);
    return;
  }

  let auth = await authenticate();
  const session = new PromptSession();
  try {
    if (process.argv.includes("--share")) {
      try {
        await shareBookingsFlow(session, auth, false);
      } catch (error) {
        if (!isPromptExit(error)) throw error;
      }
      return;
    }

    while (true) {
      try {
        const action = await selectAction(session);

        if (action === "exit") break;
        if (action === "reserve") auth = await reserveFlow(session, auth);
        if (action === "my-reservations") auth = await myReservationsFlow(session, auth);
        if (action === "share") auth = await shareBookingsFlow(session, auth, true);
        if (action === "notifications") await notificationSettingsFlow(session);
      } catch (err) {
        if (isPromptExit(err)) break;
        const message = err instanceof Error ? err.message : String(err);
        try {
          await showResult(session, "Error", [message]);
        } catch (promptError) {
          if (isPromptExit(promptError)) break;
          throw promptError;
        }
      }
    }
  } finally {
    session.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}
