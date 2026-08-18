// The single source of truth for the Project shape. frontend, mock-server,
// and infra/lambda all import this instead of each defining their own copy —
// that's the whole point: a field added/renamed here is a compile error
// everywhere it's used, instead of a silent mismatch discovered at runtime.

export interface ModulePlacement {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

export interface Project {
  id: string;
  sessionId: string | null;
  isTemplate: boolean;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  roofOutline: GeoJSON.Polygon | null;
  modules: ModulePlacement[];
  createdAt: string;
  updatedAt: string;
}
