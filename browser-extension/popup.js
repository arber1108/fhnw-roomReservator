import { AuthExpiredError, createApi, upcomingReservations } from "./lib/api.js";
import { clearAuth, getAuth, getLoginTabId, onAuthChanged, setLoginTabId } from "./lib/auth-store.js";
import { installHeaderRule } from "./lib/header-rule.js";
import { SITES } from "./lib/locations.js";
import { defaultDraft, formatPeriod, quarterHours, timeRangeFromForm } from "./lib/time.js";

const SILENT_LOGIN_TIMEOUT = 15_000; // Same as the CLI's headless refresh.
const DEFAULT_DETAILS = { title: "Gruppenarbeit", persons: "1" };

const $ = (id) => document.getElementById(id);

let auth = null;
let search = null; // { siteName, range, rooms }
let selectedRoom = null;

// ---------- Sign-in ----------

async function start() {
  await installHeaderRule().catch(() => {});
  await setupForm();
  onAuthChanged(refreshAuth);
  await refreshAuth();
  if (!auth) await signIn({ silent: true });
}

async function refreshAuth() {
  auth = await getAuth();
  $("signed-out").hidden = Boolean(auth);
  $("app").hidden = !auth;
  $("account").textContent = auth ? `Signed in until ${timeOf(auth.expiresAt)}` : "Not signed in";
}

/**
 * Opens raum.fhnw.ch in a background tab so the web app calls the API and the
 * background worker captures its token, then closes the tab. If the SSO session
 * has expired, the tab is brought forward so the user can log in there.
 */
async function signIn({ silent }) {
  const button = $("signin");
  button.hidden = true;
  $("signin-message").textContent = "Signing in through raum.fhnw.ch…";

  let tabId = await getLoginTabId();
  const existing = tabId === null ? null : await chrome.tabs.get(tabId).catch(() => null);
  if (!existing) {
    const tab = await chrome.tabs.create({ url: "https://raum.fhnw.ch/", active: false });
    tabId = tab.id;
    await setLoginTabId(tabId);
  }

  if (await waitForAuth(silent ? SILENT_LOGIN_TIMEOUT : 0)) return;

  $("signin-message").textContent =
    "Log in with your FHNW account in the raum.fhnw.ch tab. It closes by itself once you are signed in; then open this popup again.";
  button.textContent = "Go to the sign-in tab";
  button.hidden = false;
  button.onclick = async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return signIn({ silent: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true }); // Closes the popup.
  };
}

function waitForAuth(timeoutMs) {
  return new Promise((resolve) => {
    if (auth) return resolve(true);
    if (timeoutMs <= 0) return resolve(false);
    const timer = setTimeout(() => resolve(Boolean(auth)), timeoutMs);
    onAuthChanged(async () => {
      if (await getAuth()) {
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
}

/** Runs an API call; a 401 drops the token and starts a new sign-in, like the CLI's withAuth(). */
async function withApi(operation) {
  try {
    return await operation(createApi(auth));
  } catch (error) {
    if (error instanceof AuthExpiredError) {
      await clearAuth();
      await refreshAuth();
      void signIn({ silent: true });
      throw new Error("Your FHNW session expired. Signing in again; try once more afterwards.");
    }
    throw error;
  }
}

// ---------- Tabs ----------

function showTab(name) {
  $("tab-book").setAttribute("aria-selected", String(name === "book"));
  $("tab-mine").setAttribute("aria-selected", String(name === "mine"));
  $("book").hidden = name !== "book";
  $("mine").hidden = name !== "mine";
  if (name === "mine") void loadReservations();
}

// ---------- Book a room ----------

async function setupForm() {
  $("tab-book").onclick = () => showTab("book");
  $("tab-mine").onclick = () => showTab("mine");

  const stored = await chrome.storage.local.get(["siteId", "title", "persons"]);
  for (const site of SITES) $("campus").add(new Option(site.name, String(site.id)));
  if (stored.siteId) $("campus").value = String(stored.siteId);
  for (const time of quarterHours()) $("start").add(new Option(time, time));

  const draft = defaultDraft();
  $("date").value = draft.date;
  $("start").value = draft.startTime;
  $("end").value = draft.endInput;
  $("title").value = stored.title ?? DEFAULT_DETAILS.title;
  $("persons").value = stored.persons ?? DEFAULT_DETAILS.persons;

  $("search").onsubmit = (event) => {
    event.preventDefault();
    void findRooms();
  };
  $("filter").oninput = renderRooms;
  $("details").onsubmit = (event) => {
    event.preventDefault();
    void book();
  };
  $("details-back").onclick = () => showBookStep("results");
  $("booked-another").onclick = () => showBookStep("search");
  $("booked-mine").onclick = () => showTab("mine");
  $("mine-refresh").onclick = () => void loadReservations();
}

function showBookStep(step) {
  $("search").hidden = step === "details" || step === "booked";
  $("results").hidden = step !== "results";
  $("details").hidden = step !== "details";
  $("booked").hidden = step !== "booked";
}

async function findRooms() {
  const error = $("search-error");
  error.textContent = "";
  const parsed = timeRangeFromForm($("date").value, $("start").value, $("end").value);
  if ("error" in parsed) {
    error.textContent = parsed.error;
    return;
  }

  const siteId = Number($("campus").value);
  const site = SITES.find((s) => s.id === siteId);
  await chrome.storage.local.set({ siteId });

  const submit = $("search").querySelector("button[type=submit]");
  submit.disabled = true;
  submit.textContent = "Searching…";
  try {
    const { range } = parsed;
    const rooms = await withApi((api) => api.fetchAvailableRooms(siteId, range.fromUnix, range.toUnix));
    search = { siteName: site?.name ?? "", range, rooms };
    $("filter").value = "";
    renderRooms();
    showBookStep("results");
  } catch (e) {
    error.textContent = e.message;
  } finally {
    submit.disabled = false;
    submit.textContent = "Find free rooms";
  }
}

function renderRooms() {
  if (!search) return;
  const { range, rooms } = search;
  const query = $("filter").value.trim().toLowerCase();
  const shown = rooms.filter((room) =>
    !query || [room.Room, room.Building, room.Floor, room.RoomType].some((v) => String(v ?? "").toLowerCase().includes(query))
  );

  $("results-summary").textContent =
    `${rooms.length} free · ${formatPeriod(new Date(range.fromUnix * 1000), new Date(range.toUnix * 1000))}`;

  const list = $("rooms");
  list.replaceChildren();
  if (shown.length === 0) {
    list.append(item("empty", rooms.length ? "No room matches the filter." : "No rooms are free at this time."));
    return;
  }
  for (const room of shown) {
    const li = item("", room.Room, [room.Building, room.Floor, `${room.NumberPersons} people`, room.RoomType]);
    const button = document.createElement("button");
    button.className = "primary";
    button.textContent = "Book";
    button.onclick = () => openDetails(room);
    li.append(button);
    list.append(li);
  }
}

function openDetails(room) {
  selectedRoom = room;
  const { range, siteName } = search;
  $("details-room").textContent = room.Room;
  $("details-meta").textContent =
    `${formatPeriod(new Date(range.fromUnix * 1000), new Date(range.toUnix * 1000))} · ${room.Building}, ${room.Floor} · ${siteName}`;
  $("details-error").textContent = "";
  showBookStep("details");
  $("title").focus();
}

async function book() {
  const title = $("title").value.trim();
  const persons = $("persons").value.trim();
  const error = $("details-error");
  error.textContent = "";
  if (!title) return void (error.textContent = "Enter a title");
  if (!/^\d+$/.test(persons) || Number(persons) < 1) return void (error.textContent = "Enter the number of persons");
  await chrome.storage.local.set({ title, persons });

  const confirm = $("details-confirm");
  confirm.disabled = true;
  confirm.textContent = "Booking…";
  try {
    const { range } = search;
    const reservation = await withApi((api) =>
      api.createReservation(selectedRoom.RoomId, range.fromISO, range.toISO, title, persons)
    );
    $("booked-text").textContent =
      `${selectedRoom.Room}, ${formatPeriod(new Date(range.fromUnix * 1000), new Date(range.toUnix * 1000))}. ` +
      `Status: ${reservation.Status}${reservation.StatusRemark ? ` (${reservation.StatusRemark})` : ""}.`;
    // The booked room is no longer free for this slot.
    search.rooms = search.rooms.filter((room) => room.RoomId !== selectedRoom.RoomId);
    showBookStep("booked");
  } catch (e) {
    error.textContent = e.message;
  } finally {
    confirm.disabled = false;
    confirm.textContent = "Confirm booking";
  }
}

// ---------- My reservations ----------

async function loadReservations() {
  const list = $("reservations");
  const error = $("mine-error");
  error.textContent = "";
  $("mine-summary").textContent = "Loading…";
  try {
    // Include reservations already in progress, as the CLI does.
    const fromUnix = Math.floor((Date.now() - 24 * 3600_000) / 1000);
    const reservations = upcomingReservations(await withApi((api) => api.fetchMyReservations(fromUnix)));
    $("mine-summary").textContent = `${reservations.length} upcoming`;
    list.replaceChildren();
    if (reservations.length === 0) list.append(item("empty", "No upcoming reservations."));
    for (const reservation of reservations) list.append(reservationItem(reservation));
  } catch (e) {
    $("mine-summary").textContent = "";
    error.textContent = e.message;
  }
}

function reservationItem(reservation) {
  const occupancy = reservation.Occupancies?.[0];
  const when = occupancy
    ? formatPeriod(new Date(occupancy.DateTimeFrom), new Date(occupancy.DateTimeTo))
    : "No time listed";
  const li = item("", `${reservation.Resource} · ${reservation.Designation}`, [when, reservation.Status]);
  if (!reservation.IsCancelable) return li;

  const cancel = document.createElement("button");
  cancel.className = "danger";
  cancel.textContent = "Cancel";
  cancel.onclick = () => {
    const confirm = document.createElement("div");
    confirm.className = "confirm";
    const yes = document.createElement("button");
    yes.className = "danger";
    yes.textContent = "Yes, cancel";
    const no = document.createElement("button");
    no.textContent = "Keep";
    no.onclick = () => confirm.replaceWith(cancel);
    yes.onclick = async () => {
      yes.disabled = no.disabled = true;
      yes.textContent = "Cancelling…";
      try {
        await withApi((api) => api.cancelReservation(reservation.ReservationId));
        await loadReservations();
      } catch (e) {
        $("mine-error").textContent = e.message;
        confirm.replaceWith(cancel);
      }
    };
    confirm.append(no, yes);
    cancel.replaceWith(confirm);
  };
  li.append(cancel);
  return li;
}

// ---------- Helpers ----------

function item(className, title, details = []) {
  const li = document.createElement("li");
  if (className) li.className = className;
  const main = document.createElement("div");
  main.className = "main";
  const strong = document.createElement(className === "empty" ? "span" : "strong");
  strong.textContent = title;
  main.append(strong);
  const sub = details.filter((d) => d !== undefined && d !== null && d !== "").join(" · ");
  if (sub) {
    const span = document.createElement("span");
    span.className = "sub";
    span.textContent = sub;
    main.append(span);
  }
  li.append(main);
  return li;
}

function timeOf(ms) {
  return new Date(ms).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });
}

void start();
