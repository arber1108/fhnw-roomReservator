export interface Site {
  id: number;
  name: string;
  buildingIds: number[];
}

export interface Building {
  Id: number;
  Site: string;
  SiteId: number;
  ShortName: string;
  Designation: string;
  Location: string;
  Address: string;
  Zip: string;
}

export interface AvailableRoom {
  Room: string;
  RoomId: number;
  RoomType: string;
  Building: string;
  BuildingId: number;
  Floor: string;
  NumberPersons: number;
  IsAvailable: boolean;
  IsBookable: boolean;
  Status: string;
  Occupancies: Occupancy[];
}

export interface Occupancy {
  DateTimeFrom: string;
  DateTimeTo: string;
  Designation: string | null;
  Type: number; // 10 = blocked hours, 20 = reservation
}

export interface ReservationRequest {
  ResourceId: number;
  Designation: string;
  FurtherInformation: string;
  Occupancies: Array<{
    DateTimeFrom: string;
    DateTimeTo: string;
  }>;
}

export interface Reservation {
  ReservationId: number;
  ResourceId: number;
  Resource: string;
  Designation: string;
  Status: string;
  StatusRemark: string;
  IsCancelable: boolean;
  FurtherInformation?: string; // number of persons, as entered when booking
  Occupancies?: Occupancy[];
}

export interface AuthState {
  clxAuthorization: string;
  expiresAt: number;
}

export interface Contact {
  name: string;
  email: string;
}

export interface NotifySettings {
  teamsWebhookUrl?: string;
  contacts: Contact[];
}

export interface BookingNotice {
  room: string;
  building?: string; // unknown when resending a booking loaded from the reservation list
  floor?: string;
  from: Date;
  to: Date;
  title: string;
  numPersons: string;
  reservationId: number; // 0 when the API did not reveal the new ID
}
