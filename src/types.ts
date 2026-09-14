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
  Occupancies?: Occupancy[];
}

export interface AuthState {
  clxAuthorization: string;
  expiresAt: number;
}
