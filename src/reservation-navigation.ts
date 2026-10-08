export type ReservationStep =
  | "site"
  | "date"
  | "start"
  | "end"
  | "room"
  | "title"
  | "persons"
  | "confirm";

const previous: Record<ReservationStep, ReservationStep | null> = {
  site: null,
  date: "site",
  start: "date",
  end: "start",
  room: "end",
  title: "room",
  persons: "title",
  confirm: "persons",
};

export function previousReservationStep(step: ReservationStep): ReservationStep | null {
  return previous[step];
}
