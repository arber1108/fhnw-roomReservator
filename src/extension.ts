import type { Reservation } from "./types.js";

export type ExtensionDirection = "before" | "after";
export type ExtensionRange = { fromUnix: number; toUnix: number; durationMinutes: number };

const QUARTER_HOUR = 15 * 60_000;
const FIVE_MINUTES = 5 * 60_000;
const MAX_EXTENSION = 16 * 60 * 60_000;

export function isExtendableReservation(reservation: Reservation, nowMs = Date.now()): boolean {
  if (reservation.Status === "Storniert" || reservation.ResourceId <= 0) return false;
  if (reservation.Occupancies?.length !== 1) return false;
  const { DateTimeFrom, DateTimeTo } = reservation.Occupancies[0]!;
  const from = new Date(DateTimeFrom).getTime();
  const to = new Date(DateTimeTo).getTime();
  return Number.isFinite(from) && Number.isFinite(to) && from < to && to > nowMs;
}

function nextQuarterHour(ms: number): number {
  return Math.ceil(ms / QUARTER_HOUR) * QUARTER_HOUR;
}

export class ExtensionSearch {
  private constructor(
    readonly direction: ExtensionDirection,
    readonly maxUnits: number,
    private readonly anchorMs: number,
    private readonly firstStartMs: number
  ) {}

  static forReservation(
    reservation: Reservation,
    direction: ExtensionDirection,
    nowMs = Date.now()
  ): ExtensionSearch | null {
    if (!isExtendableReservation(reservation, nowMs)) return null;
    const occupancy = reservation.Occupancies![0]!;
    const from = new Date(occupancy.DateTimeFrom).getTime();
    const to = new Date(occupancy.DateTimeTo).getTime();

    if (direction === "before") {
      const firstStart = Math.floor((from - 1) / QUARTER_HOUR) * QUARTER_HOUR;
      const earliest = nextQuarterHour(Math.max(nowMs + 1, from - MAX_EXTENSION));
      const units = Math.floor((firstStart - earliest) / QUARTER_HOUR) + 1;
      return units > 0 ? new ExtensionSearch(direction, units, from, firstStart) : null;
    }

    const firstStart = nextQuarterHour(to);
    return new ExtensionSearch(direction, MAX_EXTENSION / FIVE_MINUTES, to, firstStart);
  }

  range(units: number): ExtensionRange {
    if (!Number.isInteger(units) || units < 1 || units > this.maxUnits) {
      throw new RangeError("Invalid extension duration");
    }
    const from = this.direction === "before"
      ? this.firstStartMs - (units - 1) * QUARTER_HOUR
      : this.firstStartMs;
    const to = this.direction === "before" ? this.anchorMs : from + units * FIVE_MINUTES;
    return {
      fromUnix: Math.floor(from / 1000),
      toUnix: Math.floor(to / 1000),
      durationMinutes: (to - from) / 60_000,
    };
  }

  unitsForDuration(minutes: number, maximum: number): number | null {
    for (let units = 1; units <= maximum; units++) {
      if (this.range(units).durationMinutes === minutes) return units;
    }
    return null;
  }

  get gapMinutes(): number {
    return this.direction === "after" ? (this.firstStartMs - this.anchorMs) / 60_000 : 0;
  }
}

export async function findMaximumExtension(
  search: ExtensionSearch,
  isAvailable: (range: ExtensionRange) => Promise<boolean>
): Promise<number> {
  let available = 1; // The adjacent range was already checked while locating the campus.
  let unavailable = search.maxUnits + 1;
  while (unavailable - available > 1) {
    const middle = Math.floor((available + unavailable) / 2);
    if (await isAvailable(search.range(middle))) available = middle;
    else unavailable = middle;
  }
  return available;
}
