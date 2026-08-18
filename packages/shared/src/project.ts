// The single source of truth for the Project shape. frontend, mock-server,
// and infra/lambda all import this instead of each defining their own copy —
// that's the whole point: a field added/renamed here is a compile error
// everywhere it's used, instead of a silent mismatch discovered at runtime.

export interface Roof {
  id: string;
  roofOutline: GeoJSON.Polygon | null;
  azimuth: number; // degrees, 0-359
  tilt: number; // degrees, 0-90 (extremely unlikely to be >~50)
}

export type ModuleOrientation = "portrait" | "landscape";

// A specific panel model — width/height/watts live here once per model
// instead of being repeated on every placed Module.
export interface ModuleType {
  id: string;
  name: string; // manufacturer + model
  width: number;
  height: number;
  watts: number;
}

// A module has no azimuth of its own — it's flush-mounted to whichever Roof
// it belongs to and shares that roof's azimuth. Orientation only captures
// how it's laid out relative to the roof, not which way it faces.
export interface Module {
  id: string;
  roofId: string;
  moduleTypeId: string;
  x: number;
  y: number;
  orientation: ModuleOrientation;
}

export interface Project {
  id: string;
  sessionId: string | null;
  isTemplate: boolean;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  roofs: Roof[];
  modules: Module[];
  createdAt: string;
  updatedAt: string;
}
