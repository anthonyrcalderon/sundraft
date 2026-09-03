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

// Modules are routinely packed edge-to-edge with zero gap (Fill, grid
// layouts in general), so two AABBs that are meant to just touch are common,
// not an edge case. Round-tripping a position through lng/lat and back
// introduces sub-micrometer floating-point noise, which is enough to flip an
// exactly-touching pair into a falsely-detected overlap under a strict `<`.
// Requiring the overlap to exceed a small real-world tolerance (well below
// any meaningful physical overlap, comfortably above float noise) fixes that
// without weakening genuine overlap detection.
const OVERLAP_EPSILON_METERS = 0.001; // 1mm

function overlaps(a: Aabb, b: Aabb): boolean {
  return (
    a.minX + OVERLAP_EPSILON_METERS < b.maxX &&
    b.minX + OVERLAP_EPSILON_METERS < a.maxX &&
    a.minY + OVERLAP_EPSILON_METERS < b.maxY &&
    b.minY + OVERLAP_EPSILON_METERS < a.maxY
  );
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

// Fills a roof with as many non-overlapping modules as fit, packed
// edge-to-edge in a simple grid aligned to the roof-local east/north axes
// (modules don't rotate to match roof azimuth — see effectiveSize above).
// Returns just the {x, y} anchor points (roof-local meters); the caller
// assigns ids and builds full Module records, same as a manual placement.
//
// Containment is corner-only: a candidate is accepted if all four of its
// corners land inside the roof outline. That's an approximation — a very
// concave roof could let an edge bulge outside the boundary between two
// corners without any single corner failing — but it's a solid trade for a
// simple, fast fill on the roof shapes this app actually produces.
export function fillRoofWithModules(
  roof: Roof,
  moduleType: ModuleType,
  orientation: ModuleOrientation,
  modules: Module[],
  moduleTypes: ModuleType[]
): { x: number; y: number }[] {
  const origin = roofOrigin(roof);
  const outlineRing = roof.roofOutline?.coordinates[0] as [number, number][] | undefined;
  if (!origin || !outlineRing) return [];

  // Work in the roof's local meters so the grid step and containment check
  // don't need to round-trip through lng/lat for every candidate.
  const localRing = outlineRing.map(([lng, lat]) => {
    const p = lngLatToMeters(origin, { lng, lat });
    return [p.x, p.y] as [number, number];
  });

  const { w, h } = effectiveSize(moduleType, orientation);
  const xs = localRing.map(([x]) => x);
  const ys = localRing.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const existingAabbs: Aabb[] = [];
  for (const m of modules) {
    if (m.roofId !== roof.id) continue;
    const mType = moduleTypes.find((t) => t.id === m.moduleTypeId);
    if (!mType) continue;
    const size = effectiveSize(mType, m.orientation);
    existingAabbs.push(aabb(m.x, m.y, size.w, size.h));
  }

  const placed: { x: number; y: number }[] = [];
  const placedAabbs: Aabb[] = [];

  for (let y = minY + h / 2; y <= maxY - h / 2; y += h) {
    for (let x = minX + w / 2; x <= maxX - w / 2; x += w) {
      const corners: [number, number][] = [
        [x - w / 2, y - h / 2],
        [x + w / 2, y - h / 2],
        [x + w / 2, y + h / 2],
        [x - w / 2, y + h / 2],
      ];
      if (!corners.every((c) => pointInRing(c, localRing))) continue;

      const candidate = aabb(x, y, w, h);
      const collides = [...existingAabbs, ...placedAabbs].some((other) => overlaps(candidate, other));
      if (collides) continue;

      placed.push({ x, y });
      placedAabbs.push(candidate);
    }
  }

  return placed;
}

export interface GroupMoveResult {
  moduleId: string;
  roofId: string;
  x: number;
  y: number;
}

// Translates every module in `moduleIds` together by the same real-world
// delta (anchor's current position -> targetLngLat), preserving their
// relative layout — a rigid-body move, not independent per-module
// placements. Each module lands on whatever roof its new position falls on
// (not necessarily the same one for every module in the group). Returns
// null if the move is invalid for ANY module — off every roof, or
// overlapping something outside the moving group — since the whole move is
// atomic, not partial.
//
// TODO: this is a stand-in for a real "pick up and carry" interaction —
// see the OpenedProjectView notes on temporary drag state. For now the
// group only ever "lands" once, on the second click; there's no live
// per-module preview while the target is still being chosen.
export function resolveGroupMove(
  modules: Module[],
  moduleTypes: ModuleType[],
  roofs: Roof[],
  moduleIds: string[],
  anchorLngLat: LngLat,
  targetLngLat: LngLat
): GroupMoveResult[] | null {
  const delta = lngLatToMeters(anchorLngLat, targetLngLat);
  const movingSet = new Set(moduleIds);

  const results: GroupMoveResult[] = [];
  for (const id of moduleIds) {
    const m = modules.find((mod) => mod.id === id);
    const roof = m && roofs.find((r) => r.id === m.roofId);
    const origin = roof && roofOrigin(roof);
    if (!m || !roof || !origin) return null;

    // Re-express this module's current position in the anchor's local
    // frame, apply the shared delta, then convert back to lng/lat — that
    // keeps every module's translation identical in real-world terms
    // regardless of which roof (and therefore which local origin) it
    // started on.
    const currentLngLat = metersToLngLat(origin, m.x, m.y);
    const currentInAnchorFrame = lngLatToMeters(anchorLngLat, currentLngLat);
    const newLngLat = metersToLngLat(
      anchorLngLat,
      currentInAnchorFrame.x + delta.x,
      currentInAnchorFrame.y + delta.y
    );

    const targetRoof = findContainingRoof(roofs, [newLngLat.lng, newLngLat.lat]);
    const targetOrigin = targetRoof && roofOrigin(targetRoof);
    if (!targetRoof || !targetOrigin) return null;

    const { x, y } = lngLatToMeters(targetOrigin, newLngLat);
    results.push({ moduleId: id, roofId: targetRoof.id, x, y });
  }

  // A rigid translation preserves each moving module's position relative to
  // the others, so if they didn't overlap each other before the move, they
  // won't after — only check against modules outside the moving group.
  for (const r of results) {
    const m = modules.find((mod) => mod.id === r.moduleId)!;
    const type = moduleTypes.find((t) => t.id === m.moduleTypeId);
    if (!type) return null;
    const size = effectiveSize(type, m.orientation);
    const target = aabb(r.x, r.y, size.w, size.h);

    const collides = modules
      .filter((other) => other.roofId === r.roofId && !movingSet.has(other.id))
      .some((other) => {
        const otherType = moduleTypes.find((t) => t.id === other.moduleTypeId);
        if (!otherType) return false;
        const otherSize = effectiveSize(otherType, other.orientation);
        return overlaps(target, aabb(other.x, other.y, otherSize.w, otherSize.h));
      });
    if (collides) return null;
  }

  return results;
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
