export const DEVICE_KINDS = ['mosfet', 'diode', 'igbt'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** Metadata `type` per kind, as the core filtered `/api/models/<kind>`. */
export const KIND_TYPE: Record<DeviceKind, string> = {
  // Legacy plain 'MOSFET' models (no body diode) are never offered.
  mosfet: 'MOSFET with Diode',
  diode: 'Diode',
  igbt: 'IGBT',
};

/** One row of `GET /devices?kind=` (core `/api/models/<kind>`). */
export interface DeviceModel {
  part_number: string;
  type: string;
  v_rating: unknown;
  i_rating: unknown;
}

/** One usable part of `GET /devices/catalogue` (core `device_selection.catalogue()`). */
export interface CataloguePart {
  part: string;
  type: string;
  kind: 'switch' | 'diode';
  family: string;
  v_rating: number;
  i_rating: number;
  i_lut: number;
}

export interface DeviceLibrary {
  models: Readonly<Record<DeviceKind, readonly DeviceModel[]>>;
  catalogue: readonly CataloguePart[];
  /** Total model files read. */
  files: number;
}
