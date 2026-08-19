// Small-scale (house-sized) geometry helpers for placing modules on a roof.
// A roof's outline is stored in real lng/lat, but module rectangles need to
// be sized in real meters and checked for overlap — easier to do in a flat
// local coordinate system than directly in lng/lat. We treat each roof's
// outline as flat and project to/from meters using a simple equirectangular
// approximation (accurate to a few centimeters at this scale, which is all
// this app needs).
//
// Lives in shared rather than frontend-only: it's pure domain logic (no
// rendering/DOM concerns), and the same containment/overlap rules will
// eventually need to run server-side too (e.g. validating a placement on
// the real backend, not just trusting whatever the client sends).
import type { Module, ModuleOrientation, ModuleType, Roof } from "./project";

const METERS_PER_DEGREE_LAT = 111_320;

function metersPerDegreeLng(lat: number): number {
  return METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
}

export interface LngLat {
  lng: number;
  lat: number;
}

// The roof-local origin for meters<->lnglat conversion: the plain average
// of the outline's vertices. Not a true polygon centroid, but close enough
// at house scale, and cheap to recompute on every render instead of storing it.
export function roofOrigin(roof: Roof): LngLat | null {
  const ring = roof.roofOutline?.coordinates[0];
  if (!ring || ring.length === 0) return null;
  const sum = ring.reduce(
    (acc, [lng, lat]) => ({ lng: acc.lng + lng, lat: acc.lat + lat }),
    { lng: 0, lat: 0 }
  );
  return { lng: sum.lng / ring.length, lat: sum.lat / ring.length };
}

export function metersToLngLat(origin: LngLat, x: number, y: number): LngLat {
  return {
    lng: origin.lng + x / metersPerDegreeLng(origin.lat),
    lat: origin.lat + y / METERS_PER_DEGREE_LAT,
  };
}

export function lngLatToMeters(origin: LngLat, point: LngLat): { x: number; y: number } {
  return {
    x: (point.lng - origin.lng) * metersPerDegreeLng(origin.lat),
    y: (point.lat - origin.lat) * METERS_PER_DEGREE_LAT,
  };
}

// Ray-casting point-in-polygon test. Purely topological, so it works the
// same in lng/lat as it would in any consistent 2D coordinate space.
export function pointInRing(point: [number, number], ring: [number, number][]): boolean {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function findContainingRoof(roofs: Roof[], point: [number, number]): Roof | null {
  for (const roof of roofs) {
    const ring = roof.roofOutline?.coordinates[0] as [number, number][] | undefined;
    if (ring && pointInRing(point, ring)) return roof;
  }
  return null;
}

// Orientation only swaps which of the type's two dimensions is "up" —
// modules have no rotation of their own beyond that (see ADR discussion:
// azimuth belongs to the roof, not the module).
function effectiveSize(type: ModuleType, orientation: ModuleOrientation) {
  return orientation === "portrait"
    ? { w: type.width, h: type.height }
    : { w: type.height, h: type.width };
}

interface Aabb {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function aabb(x: number, y: number, w: number, h: number): Aabb {
  return { minX: x - w / 2, maxX: x + w / 2, minY: y - h / 2, maxY: y + h / 2 };
}

function overlaps(a: Aabb, b: Aabb): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

// Would a module of `orientation`/`moduleTypeId` at (x, y) on `roofId`
// overlap any other module already on that roof? `excludeModuleId` lets a
// module being moved skip colliding with its own current position.
export function overlapsExisting(
  modules: Module[],
  moduleTypes: ModuleType[],
  roofId: string,
  x: number,
  y: number,
  orientation: ModuleOrientation,
  moduleTypeId: string,
  excludeModuleId?: string
): boolean {
  const type = moduleTypes.find((t) => t.id === moduleTypeId);
  if (!type) return false;
  const targetSize = effectiveSize(type, orientation);
  const target = aabb(x, y, targetSize.w, targetSize.h);

  return modules
    .filter((m) => m.roofId === roofId && m.id !== excludeModuleId)
    .some((m) => {
      const mType = moduleTypes.find((t) => t.id === m.moduleTypeId);
      if (!mType) return false;
      const { w, h } = effectiveSize(mType, m.orientation);
      return overlaps(target, aabb(m.x, m.y, w, h));
    });
}

// The closed ring of a module's rectangle, in map lng/lat, ready to become a
// GeoJSON Polygon.
export function moduleRing(roof: Roof, module: Module, type: ModuleType): [number, number][] | null {
  const origin = roofOrigin(roof);
  if (!origin) return null;
  const { w, h } = effectiveSize(type, module.orientation);
  const corners: [number, number][] = [
    [module.x - w / 2, module.y - h / 2],
    [module.x + w / 2, module.y - h / 2],
    [module.x + w / 2, module.y + h / 2],
    [module.x - w / 2, module.y + h / 2],
    [module.x - w / 2, module.y - h / 2],
  ];
  return corners.map(([x, y]) => {
    const ll = metersToLngLat(origin, x, y);
    return [ll.lng, ll.lat];
  });
}
