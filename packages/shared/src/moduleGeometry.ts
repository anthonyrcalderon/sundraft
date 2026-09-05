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

// The local origin for meters<->lnglat conversion: the plain average of a
// ring's vertices (closing point included, so it carries a hair more
// weight than the rest — negligible at house scale). Not a true polygon
// centroid, but close enough, and cheap to recompute on every render
// instead of storing it.
function ringOrigin(ring: [number, number][]): LngLat | null {
  if (ring.length === 0) return null;
  const sum = ring.reduce(
    (acc, [lng, lat]) => ({ lng: acc.lng + lng, lat: acc.lat + lat }),
    { lng: 0, lat: 0 }
  );
  return { lng: sum.lng / ring.length, lat: sum.lat / ring.length };
}

export function roofOrigin(roof: Roof): LngLat | null {
  const ring = roof.roofOutline?.coordinates[0] as [number, number][] | undefined;
  if (!ring) return null;
  return ringOrigin(ring);
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

// Rotates a point from a roof's own local frame (x = across the roof face,
// y = "up" the roof face, i.e. along the azimuth direction) into plain
// east/north meters relative to the roof's origin.
function rotateForAzimuth(x: number, y: number, azimuthDeg: number): { x: number; y: number } {
  const theta = (azimuthDeg * Math.PI) / 180;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { x: x * c + y * s, y: -x * s + y * c };
}

// The inverse of rotateForAzimuth: plain east/north meters -> the roof's
// own local (across-the-face, up-the-face) frame.
function unrotateForAzimuth(x: number, y: number, azimuthDeg: number): { x: number; y: number } {
  const theta = (azimuthDeg * Math.PI) / 180;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { x: x * c - y * s, y: x * s + y * c };
}

// A module's real-world position, given its coordinates in its roof's own
// local frame (not plain east/north — see rotateForAzimuth). Modules are
// stored rotated to their roof's azimuth rather than to compass north, so a
// "portrait" panel visually runs up the slope of whichever roof it's on,
// instead of always pointing due north regardless of the roof beneath it.
export function moduleToLngLat(roof: Roof, x: number, y: number): LngLat | null {
  const origin = roofOrigin(roof);
  if (!origin) return null;
  const plain = rotateForAzimuth(x, y, roof.azimuth);
  return metersToLngLat(origin, plain.x, plain.y);
}

// The inverse of moduleToLngLat: a real-world position, converted into the
// given roof's local frame, ready to store as a Module's x/y.
export function lngLatToModule(roof: Roof, point: LngLat): { x: number; y: number } | null {
  const origin = roofOrigin(roof);
  if (!origin) return null;
  const plain = lngLatToMeters(origin, point);
  return unrotateForAzimuth(plain.x, plain.y, roof.azimuth);
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

// Derives a roof's azimuth (compass bearing, degrees clockwise from north)
// from its own 2D outline, as a stand-in for real 3D roof-plane data (e.g.
// from imagery) that would give this directly. Assumes the first edge drawn
// is the roof's bottom (eave) edge, and points the azimuth perpendicular to
// it, away from the outline's interior.
export function deriveAzimuthFromOutline(outline: GeoJSON.Polygon): number {
  const ring = outline.coordinates[0] as [number, number][];
  const origin = ringOrigin(ring);
  if (!origin || ring.length < 3) return 180; // not enough shape to derive a direction from

  // Local east/north meters, so "perpendicular" and "away from center" are
  // plain 2D vector math instead of lng/lat-flavored geometry.
  const local = ring.map(([lng, lat]) => {
    const p = lngLatToMeters(origin, { lng, lat });
    return [p.x, p.y] as [number, number];
  });

  const [x0, y0] = local[0];
  const [x1, y1] = local[1];
  const midX = (x0 + x1) / 2;
  const midY = (y0 + y1) / 2;
  const edgeX = x1 - x0;
  const edgeY = y1 - y0;

  // The outline's centroid sits at the local origin (0, 0) by construction
  // — see ringOrigin. Of the two directions perpendicular to the first
  // edge, pick whichever points away from it.
  const perp: [number, number] = [-edgeY, edgeX];
  const towardCentroid: [number, number] = [-midX, -midY];
  const dot = perp[0] * towardCentroid[0] + perp[1] * towardCentroid[1];
  const away = dot < 0 ? perp : ([-perp[0], -perp[1]] as [number, number]);

  const azimuthRad = Math.atan2(away[0], away[1]); // atan2(east, north) = bearing from north, clockwise
  return Math.round(((azimuthRad * 180) / Math.PI + 360) % 360);
}

// Orientation swaps which of the type's two physical dimensions runs "up"
// the roof (h, the roof-local y-axis — see rotateForAzimuth) versus across
// it (w). A module's width/height are its true, flat panel dimensions, but
// the roof outline itself was traced from directly overhead — the same
// reason true slope length can't be recovered from a traced outline (see
// docs/FUTURE-NOTES.md's tilt discussion) means a tilted roof's up-slope
// direction is foreshortened in that same top-down view. Scaling h by
// cos(tilt) keeps a module's footprint in the same projected units as the
// roof outline it has to fit inside: flat (0° tilt) applies no
// foreshortening; a steeper tilt shrinks the up-slope dimension further,
// down toward zero as the roof approaches vertical. The across-the-roof
// dimension (w) isn't foreshortened — a horizontal line on a tilted plane
// still looks full-length from above.
function effectiveSize(type: ModuleType, orientation: ModuleOrientation, tiltDeg: number) {
  const foreshorten = Math.cos((tiltDeg * Math.PI) / 180);
  return orientation === "portrait"
    ? { w: type.width, h: type.height * foreshorten }
    : { w: type.height, h: type.width * foreshorten };
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

// Would a module of `orientation`/`moduleTypeId` at (x, y) on a roof with
// `tiltDeg` overlap any other module already on that roof? `excludeModuleId`
// lets a module being moved skip colliding with its own current position.
export function overlapsExisting(
  modules: Module[],
  moduleTypes: ModuleType[],
  roofId: string,
  x: number,
  y: number,
  orientation: ModuleOrientation,
  moduleTypeId: string,
  tiltDeg: number,
  excludeModuleId?: string
): boolean {
  const type = moduleTypes.find((t) => t.id === moduleTypeId);
  if (!type) return false;
  const targetSize = effectiveSize(type, orientation, tiltDeg);
  const target = aabb(x, y, targetSize.w, targetSize.h);

  return modules
    .filter((m) => m.roofId === roofId && m.id !== excludeModuleId)
    .some((m) => {
      const mType = moduleTypes.find((t) => t.id === m.moduleTypeId);
      if (!mType) return false;
      const { w, h } = effectiveSize(mType, m.orientation, tiltDeg);
      return overlaps(target, aabb(m.x, m.y, w, h));
    });
}

// Fills a roof with as many non-overlapping modules as fit, packed
// edge-to-edge in a simple grid aligned to the roof's own azimuth-rotated
// axes (see rotateForAzimuth) — rows run along the roof's facing direction,
// like a real solar array, rather than along compass east/north regardless
// of which way the roof faces. Returns just the {x, y} anchor points (in
// that same roof-local frame); the caller assigns ids and builds full
// Module records, same as a manual placement.
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

  // Work in the roof's own local (azimuth-rotated) frame so the grid step
  // and containment check don't need to round-trip through lng/lat for
  // every candidate, and so the positions generated are directly valid
  // Module.x/y values in that same frame.
  const localRing = outlineRing.map(([lng, lat]) => {
    const plain = lngLatToMeters(origin, { lng, lat });
    const rotated = unrotateForAzimuth(plain.x, plain.y, roof.azimuth);
    return [rotated.x, rotated.y] as [number, number];
  });

  const { w, h } = effectiveSize(moduleType, orientation, roof.tilt);
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
    const size = effectiveSize(mType, m.orientation, roof.tilt);
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
    if (!m || !roof) return null;

    // Re-express this module's current real-world position in the anchor's
    // local frame, apply the shared delta, then convert back to lng/lat —
    // that keeps every module's translation identical in real-world terms
    // regardless of which roof (and therefore which origin/azimuth) it
    // started on.
    const currentLngLat = moduleToLngLat(roof, m.x, m.y);
    if (!currentLngLat) return null;
    const currentInAnchorFrame = lngLatToMeters(anchorLngLat, currentLngLat);
    const newLngLat = metersToLngLat(
      anchorLngLat,
      currentInAnchorFrame.x + delta.x,
      currentInAnchorFrame.y + delta.y
    );

    const targetRoof = findContainingRoof(roofs, [newLngLat.lng, newLngLat.lat]);
    if (!targetRoof) return null;
    // Rotated into the target roof's own frame — which may have a
    // different azimuth than the roof the module started on.
    const local = lngLatToModule(targetRoof, newLngLat);
    if (!local) return null;

    results.push({ moduleId: id, roofId: targetRoof.id, x: local.x, y: local.y });
  }

  // A rigid translation preserves each moving module's position relative to
  // the others, so if they didn't overlap each other before the move, they
  // won't after — only check against modules outside the moving group.
  for (const r of results) {
    const m = modules.find((mod) => mod.id === r.moduleId)!;
    const type = moduleTypes.find((t) => t.id === m.moduleTypeId);
    const targetRoofTilt = roofs.find((rf) => rf.id === r.roofId)?.tilt;
    if (!type || targetRoofTilt === undefined) return null;
    const size = effectiveSize(type, m.orientation, targetRoofTilt);
    const target = aabb(r.x, r.y, size.w, size.h);

    const collides = modules
      .filter((other) => other.roofId === r.roofId && !movingSet.has(other.id))
      .some((other) => {
        const otherType = moduleTypes.find((t) => t.id === other.moduleTypeId);
        if (!otherType) return false;
        const otherSize = effectiveSize(otherType, other.orientation, targetRoofTilt);
        return overlaps(target, aabb(other.x, other.y, otherSize.w, otherSize.h));
      });
    if (collides) return null;
  }

  return results;
}

// The closed ring of a module's rectangle, in map lng/lat, ready to become a
// GeoJSON Polygon. Rotated to the roof's azimuth (via moduleToLngLat), so a
// portrait panel renders running up the slope of its own roof rather than
// always pointing due north, and foreshortened by the roof's tilt (see
// effectiveSize) so a steeply-pitched roof's modules render visibly
// shorter along that same up-slope axis.
export function moduleRing(roof: Roof, module: Module, type: ModuleType): [number, number][] | null {
  const { w, h } = effectiveSize(type, module.orientation, roof.tilt);
  const corners: [number, number][] = [
    [module.x - w / 2, module.y - h / 2],
    [module.x + w / 2, module.y - h / 2],
    [module.x + w / 2, module.y + h / 2],
    [module.x - w / 2, module.y + h / 2],
    [module.x - w / 2, module.y - h / 2],
  ];
  const ring: [number, number][] = [];
  for (const [x, y] of corners) {
    const ll = moduleToLngLat(roof, x, y);
    if (!ll) return null;
    ring.push([ll.lng, ll.lat]);
  }
  return ring;
}
