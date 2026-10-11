// Same rules as the CLI (src/ui.ts): start on a 15-minute step; end as HH:mm
// (5-minute steps, next day if not after the start) or a duration such as
// 90m, 1h 30m, 1.5h or 1,5h; 5 minutes to 16 hours in 5-minute steps.

const MAX_MINUTES = 16 * 60;

const pad = (n) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` for an <input type="date">, in local time. */
export function toDateInput(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function toTimeInput(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The CLI's default: the next quarter hour, ending one hour later. */
export function defaultDraft(now = new Date()) {
  const start = new Date(now);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 15 - (start.getMinutes() % 15));
  const end = new Date(start.getTime() + 60 * 60_000);
  return { date: toDateInput(start), startTime: toTimeInput(start), endInput: toTimeInput(end) };
}

/** Every quarter hour of a day, for the start time list. */
export function quarterHours() {
  const times = [];
  for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
    times.push(`${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`);
  }
  return times;
}

/** Parses the date (`YYYY-MM-DD`) and start time (`HH:mm`) as local time. */
export function parseStart(dateValue, startTime) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue ?? "");
  if (!dateMatch) return { error: "Choose a date" };
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(startTime ?? "");
  if (!timeMatch) return { error: "Use HH:mm for the start time" };

  const [year, month, day] = dateMatch.slice(1).map(Number);
  const [hours, minutes] = timeMatch.slice(1).map(Number);
  if (hours > 23 || minutes > 59) return { error: "Invalid start time" };
  if (minutes % 15 !== 0) return { error: "Start time must use 15-minute steps" };

  const start = new Date(year, month - 1, day, hours, minutes);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
    return { error: "Invalid date" };
  }
  if (start.getHours() !== hours || start.getMinutes() !== minutes) {
    return { error: "Start time does not exist on this date" };
  }
  return { start };
}

export function parseEndTimeOrDuration(value, start) {
  const input = value.trim();
  const endTimeMatch = /^(\d{1,2}):(\d{2})$/.exec(input);

  if (endTimeMatch) {
    const hours = Number(endTimeMatch[1]);
    const minutes = Number(endTimeMatch[2]);
    if (hours > 23 || minutes > 59) return { error: "Use a valid time in HH:mm format" };
    if (minutes % 5 !== 0) return { error: "End time must use 5-minute steps" };

    const end = new Date(start);
    end.setHours(hours, minutes, 0, 0);
    if (end <= start) end.setDate(end.getDate() + 1);
    if (end.getHours() !== hours || end.getMinutes() !== minutes) {
      return { error: "End time does not exist on this date" };
    }
    if (end.getTime() - start.getTime() > MAX_MINUTES * 60_000) {
      return { error: "End time must be within 16 hours of the start" };
    }
    return { end };
  }

  let durationMinutes;
  const decimalHoursMatch = /^(\d+(?:[,.]\d+)?)\s*(?:h|hours?)?$/i.exec(input);
  if (decimalHoursMatch) {
    durationMinutes = Number(decimalHoursMatch[1].replace(",", ".")) * 60;
  } else {
    const durationMatch = /^(?:(\d+)\s*h(?:ours?)?\s*)?(?:(\d+)\s*m(?:in(?:utes?)?)?\s*)?$/i.exec(input);
    if (!durationMatch || (!durationMatch[1] && !durationMatch[2])) {
      return { error: "Use HH:mm or a duration such as 90m, 1h 30m, or 1,5h" };
    }
    durationMinutes = Number(durationMatch[1] ?? 0) * 60 + Number(durationMatch[2] ?? 0);
  }

  const roundedMinutes = Math.round(durationMinutes);
  if (
    !Number.isFinite(durationMinutes) ||
    Math.abs(durationMinutes - roundedMinutes) > Number.EPSILON ||
    roundedMinutes <= 0 ||
    roundedMinutes > MAX_MINUTES ||
    roundedMinutes % 5 !== 0
  ) {
    return { error: "Duration must be 5-minute steps between 5 minutes and 16 hours" };
  }
  return { end: new Date(start.getTime() + roundedMinutes * 60_000) };
}

/** Validates the whole form and returns the range in the shapes the API expects. */
export function timeRangeFromForm(dateValue, startTime, endInput) {
  const parsedStart = parseStart(dateValue, startTime);
  if ("error" in parsedStart) return parsedStart;
  const parsedEnd = parseEndTimeOrDuration(endInput, parsedStart.start);
  if ("error" in parsedEnd) return parsedEnd;
  const { start } = parsedStart;
  const { end } = parsedEnd;
  return {
    range: {
      fromUnix: Math.floor(start.getTime() / 1000),
      toUnix: Math.floor(end.getTime() / 1000),
      fromISO: start.toISOString(),
      toISO: end.toISOString(),
    },
  };
}

const dateFormat = new Intl.DateTimeFormat("de-CH", { day: "2-digit", month: "2-digit", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat("de-CH", { hour: "2-digit", minute: "2-digit" });
const weekdayFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short" });

/** `Mon 15.01.2027 13:00 – 14:00`, with the end date only when it differs. */
export function formatPeriod(from, to) {
  const sameDay = from.toDateString() === to.toDateString();
  const end = sameDay ? timeFormat.format(to) : `${dateFormat.format(to)} ${timeFormat.format(to)}`;
  return `${weekdayFormat.format(from)} ${dateFormat.format(from)} ${timeFormat.format(from)} – ${end}`;
}
