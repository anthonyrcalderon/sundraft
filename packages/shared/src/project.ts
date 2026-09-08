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
//
// TODO: eventually a Module needs to be able to carry Module Violations
// (overlapping another module, falling outside its roof, etc.) so the UI can
// flag it instead of just silently rejecting new invalid placements. Any
// Module Violation also rolls up into a Design Violation (project-level, not
// tied to one module — e.g. "zero modules placed") of the same severity —
// see "Deferred: Module Violations & Design Violations" in
// docs/PROJECT-OVERVIEW.md for the severity tiers (Fatal/Blocking/Advisory)
// and the tradeoffs (mainly: avoiding a full re-validation pass on every edit).
export interface Module {
  id: string;
  roofId: string;
  moduleTypeId: string;
  x: number;
  y: number;
  orientation: ModuleOrientation;
}

// A roof-mounted object a module can't be placed on top of — a vent,
// chimney, HVAC unit, skylight, etc. Drawn and stretched directly on the
// map (see MapView), so its stored size is exactly the footprint the user
// drew — unlike Module, there's no real-world catalog spec to foreshorten
// from, so ObstructionShape carries no tilt-derived sizing at all.
export type ObstructionShape =
  | { kind: "rectangle"; width: number; height: number }
  | { kind: "circle"; radius: number };

// An obstruction has no azimuth of its own, same reasoning as Module: it's
// flush with whichever Roof it belongs to, and x/y live in that roof's own
// local (azimuth-rotated) frame — the same frame Module.x/y use — so
// obstruction/module overlap checks never need a coordinate conversion.
export interface Obstruction {
  id: string;
  roofId: string;
  x: number; // roof-local meters, shape center
  y: number;
  shape: ObstructionShape;
}

// The name a newly created (not yet renamed) project starts with. Also the
// sentinel a project's current name is checked against to decide whether
// setting its address should auto-name it too — once a project has any
// other name (renamed manually, or already auto-named from an address),
// picking a different address leaves the name alone.
export const DEFAULT_PROJECT_NAME = "Untitled design";

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
  obstructions: Obstruction[];
  // A small preview image shown on the project picker — currently only set
  // by hand for example templates (a path under frontend/public, e.g.
  // "/examples/1612-north-aspen-court.png"), never generated automatically.
  screenshotUrl: string | null;
  createdAt: string;
  updatedAt: string;
}
