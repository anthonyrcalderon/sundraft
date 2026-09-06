import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  type GroupMoveResult,
  type LngLat,
  type Module,
  type ModuleOrientation,
  type ModuleType,
  type Obstruction,
  type ObstructionShape,
  type Roof,
  findContainingRoof,
  lngLatToMeters,
  lngLatToModule,
  metersToLngLat,
  moduleRing,
  moduleToLngLat,
  modulesTouchingRect,
  obstructionRing,
  overlapsExisting,
  resolveGroupMove,
  snapToAdjacentModule,
} from "sundraft-shared";

// Esri's public World Imagery tiles — free, no API key, no card, no signup.
// Unlike Mapbox's published free tier (which now requires a card on file),
// this has no formal numeric limit, but also no guaranteed SLA — an
// acceptable trade for a low-traffic portfolio demo with zero billing risk.
// Since this is a raw raster tile endpoint (not a hosted style.json like
// Mapbox provides), we build the style object by hand.
const ESRI_WORLD_IMAGERY_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    esri: {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      // Esri's real tile resolution varies a lot by location — dense
      // US/urban areas often have true imagery well past this, but plenty
      // of other areas top out lower. Without an explicit maxzoom, MapLibre
      // keeps requesting real tiles at deeper zooms that may not exist for
      // a given spot, which is what made zooming in feel like it hits a
      // wall. Declaring one here tells MapLibre to stop requesting new
      // tiles past it and instead "overzoom" — scale up the deepest tile it
      // already has — so zooming stays smooth (just blurrier) everywhere,
      // regardless of that location's actual coverage.
      maxzoom: 19,
      attribution:
        "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    },
  },
  layers: [{ id: "esri-world-imagery", type: "raster", source: "esri" }],
};

const DEFAULT_CENTER: [number, number] = [-98.5795, 39.8283]; // center of the continental US
const DEFAULT_ZOOM = 3.5;
const ADDRESS_ZOOM = 19; // close enough to make out individual roofs
const SNAP_PX = 15; // click/cursor proximity (screen pixels) that triggers a snap while tracing a roof
// Candidate angles (degrees) an in-progress edge can snap to, measured
// relative to the previous edge's direction — 0/180 for a straight
// continuation, 90/270 for a square corner, 45/135/225/315 for diagonals.
const ANGLE_SNAP_DEGREES = [0, 45, 90, 135, 180, 225, 270, 315];
const ANGLE_SNAP_TOLERANCE_DEG = 8;
// The relative angles (to the first edge drawn) worth a closing-guide line
// through the first vertex — one entry per distinct infinite line, since a
// line at 0° from the first edge is the same line as one at 180° (and
// likewise 45°/225°, 90°/270°, 135°/315°). Mirrors ANGLE_SNAP_DEGREES so
// every angle an edge can snap to also gets a closing guide to match it.
const CLOSING_GUIDE_ANGLES = [0, 45, 90, 135];
// How far out (screen pixels) the closing-guide line shows itself — wider
// than SNAP_PX itself since the line has no length of its own to help you
// notice it, unlike a vertex or an edge. Covers the actual snap radius too,
// so the guide stays up through the snap instead of vanishing right as the
// cursor locks onto it.
const CLOSING_GUIDE_RANGE_PX = SNAP_PX * 3;
// How far (screen pixels) the guide line is drawn past the first vertex in
// each direction — just needs to comfortably outlast any reasonable
// viewport so it reads as an infinite line.
const CLOSING_GUIDE_EXTENT_PX = 8000;

// Screen-pixel distance a mousedown-then-up has to travel before it counts
// as a drag (a select-rectangle, or picking up the selection to move it)
// rather than a plain click — absorbs the couple pixels of jitter a real
// click still has.
const DRAG_MIN_PX = 6;

// Screen-pixel hit radius for grabbing a resize handle — generous relative
// to the small dot it's rendered as, since a handle is a deliberate target
// you're aiming for, not something to miss by a pixel and lose the drag.
const HANDLE_HIT_PX = 12;
// Floor on an obstruction's width/height/radius so stretching a handle
// past its opposite edge can't collapse it to a sliver or a point.
const MIN_OBSTRUCTION_SIZE_METERS = 0.2;

const ROOFS_SOURCE_ID = "roofs";
const DRAFT_LINE_SOURCE_ID = "draft-line";
const DRAFT_POINTS_SOURCE_ID = "draft-points";
const CLOSING_GUIDE_SOURCE_ID = "closing-guide-line";
const SELECT_RECT_SOURCE_ID = "select-rect";
const MODULES_SOURCE_ID = "modules";
const MODULES_FILL_LAYER_ID = "modules-fill";
const OBSTRUCTIONS_SOURCE_ID = "obstructions";
const OBSTRUCTIONS_FILL_LAYER_ID = "obstructions-fill";
const OBSTRUCTION_HANDLES_SOURCE_ID = "obstruction-handles";
const OBSTRUCTION_HANDLES_LAYER_ID = "obstruction-handles";

const emptyFC = (): GeoJSON.FeatureCollection => ({
  type: "FeatureCollection",
  features: [],
});

export interface PendingPlacement {
  moduleTypeId: string;
  orientation: ModuleOrientation;
}

export type PendingObstructionShape = "rectangle" | "circle";

// The corner of an obstruction's rectangle a resize handle sits at, or the
// single point on a circle's edge (fixed at its local +x direction) its one
// handle sits at.
type ObstructionHandle = "minXminY" | "maxXminY" | "maxXmaxY" | "minXmaxY" | "radius";

// A rectangle's four roof-local corners, keyed the same way ObstructionHandle
// names them — used both to place handle markers and, during a resize, to
// find the corner diagonally opposite whichever one is being dragged (which
// stays fixed for the whole gesture).
function obstructionRectCorners(
  x: number,
  y: number,
  width: number,
  height: number
): Record<Exclude<ObstructionHandle, "radius">, { x: number; y: number }> {
  const halfW = width / 2;
  const halfH = height / 2;
  return {
    minXminY: { x: x - halfW, y: y - halfH },
    maxXminY: { x: x + halfW, y: y - halfH },
    maxXmaxY: { x: x + halfW, y: y + halfH },
    minXmaxY: { x: x - halfW, y: y + halfH },
  };
}

const OPPOSITE_CORNER: Record<Exclude<ObstructionHandle, "radius">, Exclude<ObstructionHandle, "radius">> = {
  minXminY: "maxXmaxY",
  maxXminY: "minXmaxY",
  maxXmaxY: "minXminY",
  minXmaxY: "maxXminY",
};

// Every resize-handle position (roof-local) for an obstruction's current
// shape, each tagged with which handle it is — shared by both the handle
// rendering effect and the mousedown hit-test below, so the two can never
// disagree about where a handle actually is.
function obstructionHandlePoints(
  x: number,
  y: number,
  shape: ObstructionShape
): { handle: ObstructionHandle; x: number; y: number }[] {
  if (shape.kind === "circle") {
    return [{ handle: "radius", x: x + shape.radius, y }];
  }
  const corners = obstructionRectCorners(x, y, shape.width, shape.height);
  return (Object.keys(corners) as Exclude<ObstructionHandle, "radius">[]).map((handle) => ({
    handle,
    ...corners[handle],
  }));
}

// The closest vertex among every existing roof's outline to `screenPoint`,
// if any is within SNAP_PX — lets a new roof's outline snap onto an
// adjacent roof's corners instead of leaving a gap or overlap between them.
function findNearbyRoofVertex(
  map: maplibregl.Map,
  roofs: Roof[],
  screenPoint: maplibregl.Point
): [number, number] | null {
  let closest: [number, number] | null = null;
  let closestDist = SNAP_PX;
  for (const roof of roofs) {
    const ring = roof.roofOutline?.coordinates[0] as [number, number][] | undefined;
    if (!ring) continue;
    for (const vertex of ring) {
      const dist = screenPoint.dist(map.project(vertex));
      if (dist <= closestDist) {
        closestDist = dist;
        closest = vertex;
      }
    }
  }
  return closest;
}

// Smallest angle (degrees) between two directions, both in [0, 360).
function angleDiff(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// If there's a previous edge to measure against, and the candidate point's
// direction from the last vertex is within tolerance of one of
// ANGLE_SNAP_DEGREES relative to that edge, snap to that exact direction —
// keeping the cursor's actual distance, just correcting the angle. Makes
// square (or straight-continuation) corners easy to place precisely.
function snapToAngle(
  map: maplibregl.Map,
  draftPoints: [number, number][],
  screenPoint: maplibregl.Point
): [number, number] | null {
  if (draftPoints.length < 2) return null;
  const last = map.project(draftPoints[draftPoints.length - 1]);
  const prev = map.project(draftPoints[draftPoints.length - 2]);

  const dx = screenPoint.x - last.x;
  const dy = screenPoint.y - last.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return null;

  const refAngle = Math.atan2(last.y - prev.y, last.x - prev.x);
  const relativeDeg = (((Math.atan2(dy, dx) - refAngle) * 180) / Math.PI + 360) % 360;

  const nearestSnap = ANGLE_SNAP_DEGREES.reduce((best, deg) =>
    angleDiff(relativeDeg, deg) < angleDiff(relativeDeg, best) ? deg : best
  );
  if (angleDiff(relativeDeg, nearestSnap) > ANGLE_SNAP_TOLERANCE_DEG) return null;

  const snappedAngle = refAngle + (nearestSnap * Math.PI) / 180;
  const snappedScreen: [number, number] = [
    last.x + distance * Math.cos(snappedAngle),
    last.y + distance * Math.sin(snappedAngle),
  ];
  const ll = map.unproject(snappedScreen);
  return [ll.lng, ll.lat];
}

// One infinite line through the first vertex, at `relativeDeg` from the
// first edge drawn — a candidate target a closing vertex can land on for
// the final edge to come out at that same angle from the first one. That's
// easy for the edges in between (each just needs the right angle from the
// one before it), but the closing edge's angle is a side effect of exactly
// where the last vertex lands, not something the existing previous-edge
// angle snap alone can guarantee. Null until the first edge exists (2
// points).
function closingGuideLine(
  map: maplibregl.Map,
  draftPoints: [number, number][],
  relativeDeg: number
): { origin: maplibregl.Point; ux: number; uy: number } | null {
  if (draftPoints.length < 2) return null;
  const origin = map.project(draftPoints[0]);
  const next = map.project(draftPoints[1]);
  const dx = next.x - origin.x;
  const dy = next.y - origin.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const angle = Math.atan2(dy, dx) + (relativeDeg * Math.PI) / 180;
  return { origin, ux: Math.cos(angle), uy: Math.sin(angle) };
}

// Every closing-guide line worth considering (see CLOSING_GUIDE_ANGLES),
// each tagged with the relative angle that produced it.
function closingGuideLines(
  map: maplibregl.Map,
  draftPoints: [number, number][]
): { relativeDeg: number; origin: maplibregl.Point; ux: number; uy: number }[] {
  return CLOSING_GUIDE_ANGLES.flatMap((relativeDeg) => {
    const line = closingGuideLine(map, draftPoints, relativeDeg);
    return line ? [{ relativeDeg, ...line }] : [];
  });
}

// The closest point on any closing-guide line to `screenPoint`, and how
// far away it is — the distance decides both whether to show that guide
// line (see CLOSING_GUIDE_RANGE_PX) and whether to actually snap onto it
// (SNAP_PX). When more than one line is in range, the nearest one wins.
function projectOntoClosingGuide(
  map: maplibregl.Map,
  draftPoints: [number, number][],
  screenPoint: maplibregl.Point
): { point: [number, number]; distance: number; origin: maplibregl.Point; ux: number; uy: number } | null {
  let best: { point: [number, number]; distance: number; origin: maplibregl.Point; ux: number; uy: number } | null =
    null;
  for (const line of closingGuideLines(map, draftPoints)) {
    const t = (screenPoint.x - line.origin.x) * line.ux + (screenPoint.y - line.origin.y) * line.uy;
    const projected = new maplibregl.Point(line.origin.x + t * line.ux, line.origin.y + t * line.uy);
    const distance = screenPoint.dist(projected);
    if (!best || distance < best.distance) {
      const ll = map.unproject(projected);
      best = { point: [ll.lng, ll.lat], distance, origin: line.origin, ux: line.ux, uy: line.uy };
    }
  }
  return best;
}

// Where a closing-guide line crosses the angle-snapped direction of the
// edge currently being drawn — the exact corner a rectangle's (or a
// diagonal roof's) last vertex needs, satisfying both constraints (this
// edge's own angle snap *and* the closing edge's angle relative to the
// first one) at once. Without this, whichever constraint the cursor
// happens to be nearer to wins outright, so the preview edge snaps onto
// one line right as it'd otherwise line up with both — visibly "losing"
// whichever snap it had a moment ago instead of the two meeting. Checks
// every closing-guide line and keeps whichever produces the nearest
// corner; a line parallel to this edge's snapped direction (no single
// corner exists — most commonly while placing the vertex right after the
// first edge, where "the previous edge" and "the first edge" are the same
// edge) is skipped rather than considered.
function closingCornerSnap(
  map: maplibregl.Map,
  draftPoints: [number, number][],
  screenPoint: maplibregl.Point
): { point: [number, number]; distance: number } | null {
  if (draftPoints.length < 2) return null;
  const guideLines = closingGuideLines(map, draftPoints);
  if (guideLines.length === 0) return null;

  const last = map.project(draftPoints[draftPoints.length - 1]);
  const prev = map.project(draftPoints[draftPoints.length - 2]);
  const dx = screenPoint.x - last.x;
  const dy = screenPoint.y - last.y;
  if (dx === 0 && dy === 0) return null;

  // Same "nearest candidate angle" logic as snapToAngle, but we need the
  // resulting direction itself (as a line to intersect), not just a
  // go/no-go on the raw cursor position.
  const refAngle = Math.atan2(last.y - prev.y, last.x - prev.x);
  const relativeDeg = (((Math.atan2(dy, dx) - refAngle) * 180) / Math.PI + 360) % 360;
  const nearestSnap = ANGLE_SNAP_DEGREES.reduce((best, deg) =>
    angleDiff(relativeDeg, deg) < angleDiff(relativeDeg, best) ? deg : best
  );
  const snappedAngle = refAngle + (nearestSnap * Math.PI) / 180;
  const edgeDir = { x: Math.cos(snappedAngle), y: Math.sin(snappedAngle) };

  let best: { point: [number, number]; distance: number } | null = null;
  for (const guideLine of guideLines) {
    const guideDir = { x: guideLine.ux, y: guideLine.uy };
    // Solve last + t*edgeDir = guideLine.origin + s*guideDir for t.
    const denom = edgeDir.x * guideDir.y - edgeDir.y * guideDir.x;
    if (Math.abs(denom) < 1e-6) continue; // parallel to this guide — no single corner

    const ox = guideLine.origin.x - last.x;
    const oy = guideLine.origin.y - last.y;
    const t = (ox * guideDir.y - oy * guideDir.x) / denom;
    const corner = new maplibregl.Point(last.x + t * edgeDir.x, last.y + t * edgeDir.y);
    const distance = screenPoint.dist(corner);
    if (!best || distance < best.distance) {
      const ll = map.unproject(corner);
      best = { point: [ll.lng, ll.lat], distance };
    }
  }
  return best;
}

// Where a candidate point actually lands once every roof-tracing snap is
// applied, in priority order: an existing roof's vertex first (an exact,
// deliberate target), then the corner where the closing guide meets the
// angle-snapped edge direction, then either of those individually, then the
// raw cursor position. Used by both the click handler and the live preview
// line so what's shown is exactly what clicking would do.
function snapDraftPoint(
  map: maplibregl.Map,
  roofs: Roof[],
  draftPoints: [number, number][],
  screenPoint: maplibregl.Point
): [number, number] {
  const nearbyVertex = findNearbyRoofVertex(map, roofs, screenPoint);
  if (nearbyVertex) return nearbyVertex;

  const corner = closingCornerSnap(map, draftPoints, screenPoint);
  if (corner && corner.distance <= SNAP_PX) return corner.point;

  const closingGuide = projectOntoClosingGuide(map, draftPoints, screenPoint);
  if (closingGuide && closingGuide.distance <= SNAP_PX) return closingGuide.point;

  const angleSnapped = snapToAngle(map, draftPoints, screenPoint);
  if (angleSnapped) return angleSnapped;

  const ll = map.unproject(screenPoint);
  return [ll.lng, ll.lat];
}

interface Props {
  center: { lng: number; lat: number } | null;
  roofs: Roof[];
  drawing: boolean;
  onRoofDrawn: (outline: GeoJSON.Polygon) => void;
  onCancelDrawing: () => void;
  modules: Module[];
  moduleTypes: ModuleType[];
  pendingPlacement: PendingPlacement | null;
  onPlacementResolved: (roofId: string, x: number, y: number) => void;
  onGroupMoveResolved: (results: GroupMoveResult[]) => void;
  onCancelPlacement: () => void;
  selectedModuleIds: string[];
  onModuleClick: (id: string | null, additive: boolean) => void;
  onModuleDoubleClick: (roofId: string) => void;
  onRectSelect: (roofId: string, moduleIds: string[]) => void;
  selectedRoofId: string | null;
  onRoofClick: (id: string) => void;
  obstructions: Obstruction[];
  pendingObstructionShape: PendingObstructionShape | null;
  onObstructionDrawn: (roofId: string, shape: ObstructionShape, x: number, y: number) => void;
  onCancelObstructionDraw: () => void;
  selectedObstructionId: string | null;
  onObstructionClick: (id: string | null) => void;
  onObstructionChange: (id: string, x: number, y: number, shape: ObstructionShape) => void;
}

// A select-rectangle drag in progress: the roof it started on (the only
// roof its result can ever select from) and where it started, both as the
// drag needs to re-derive the current rectangle on every subsequent
// mousemove/mouseup.
interface BoxSelect {
  roofId: string;
  startLngLat: LngLat;
  startScreen: { x: number; y: number };
}

// A group-move drag in progress: every module riding along (the whole
// current selection, snapshotted at mousedown so it can't change mid-drag),
// where the drag started, and which one was actually grabbed — that one is
// checked against every other module's adjacent slots (see
// snapToAdjacentModule) so the whole group can snap into place the same way
// a new module snaps while being placed, with the rest of the group rigidly
// along for the ride.
interface ModuleDrag {
  moduleIds: string[];
  grabbedModuleId: string;
  startLngLat: LngLat;
  startScreen: { x: number; y: number };
}

// A new obstruction being drawn by dragging across a roof: one corner (or,
// for a circle, the center) at the drag's start, the other end following
// the cursor — the same "opposite corners" mechanic the select-rectangle
// already uses.
interface ObstructionDraft {
  roofId: string;
  kind: PendingObstructionShape;
  startLngLat: LngLat;
  startScreen: { x: number; y: number };
}

// An existing obstruction being repositioned by dragging its body. Simpler
// than ModuleDrag: always exactly one obstruction, and it stays on the roof
// it started on rather than being re-evaluated against every roof on drop.
interface ObstructionDrag {
  obstructionId: string;
  roofId: string;
  startLngLat: LngLat;
  startScreen: { x: number; y: number };
}

// An existing obstruction being resized by dragging one of its handles.
// The original shape/position are snapshotted at mousedown (not re-read
// from the live obstructions array) so the corner/center a rectangle or
// circle resizes around stays fixed for the whole gesture rather than
// drifting if it were re-derived from an already-live-updated shape.
interface ObstructionResize {
  obstructionId: string;
  roofId: string;
  handle: ObstructionHandle;
  originalX: number;
  originalY: number;
  originalShape: ObstructionShape;
}

// Where an in-progress resize's dragged handle actually is right now. A
// corner handle just puts that corner exactly under the cursor (unlike a
// body-drag, a resize handle has no grab offset to preserve) with the
// diagonally opposite corner — taken from the gesture's original snapshot,
// never the live shape — held fixed; a circle's one handle sets the radius
// to its distance from center. Both floor their result at
// MIN_OBSTRUCTION_SIZE_METERS so dragging a handle past its opposite edge
// can't collapse the shape to nothing.
function resolveObstructionResize(
  resize: ObstructionResize,
  roof: Roof,
  currentLngLat: LngLat
): { x: number; y: number; shape: ObstructionShape } | null {
  const cursorLocal = lngLatToModule(roof, currentLngLat);
  if (!cursorLocal) return null;

  if (resize.originalShape.kind === "circle") {
    const radius = Math.max(
      MIN_OBSTRUCTION_SIZE_METERS / 2,
      Math.hypot(cursorLocal.x - resize.originalX, cursorLocal.y - resize.originalY)
    );
    return { x: resize.originalX, y: resize.originalY, shape: { kind: "circle", radius } };
  }

  const corners = obstructionRectCorners(
    resize.originalX,
    resize.originalY,
    resize.originalShape.width,
    resize.originalShape.height
  );
  // Safe: a rectangle obstruction's resize gesture only ever starts from
  // one of the 4 corner handles, never "radius" — see handleMouseDown.
  const fixed = corners[OPPOSITE_CORNER[resize.handle as Exclude<ObstructionHandle, "radius">]];

  const minX = Math.min(cursorLocal.x, fixed.x);
  const maxX = Math.max(cursorLocal.x, fixed.x);
  const minY = Math.min(cursorLocal.y, fixed.y);
  const maxY = Math.max(cursorLocal.y, fixed.y);
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    shape: {
      kind: "rectangle",
      width: Math.max(MIN_OBSTRUCTION_SIZE_METERS, maxX - minX),
      height: Math.max(MIN_OBSTRUCTION_SIZE_METERS, maxY - minY),
    },
  };
}

// Where an in-progress body-drag has carried an obstruction to — the same
// "re-express current position in the drag's start frame, add the cursor's
// delta, convert back" trick the module-drag preview uses, so the obstruction
// follows the cursor's actual movement rather than snapping its center to
// wherever the cursor now is.
function resolveObstructionMove(
  drag: ObstructionDrag,
  obstruction: Obstruction,
  roof: Roof,
  currentLngLat: LngLat
): { x: number; y: number } | null {
  const currentObstructionLngLat = moduleToLngLat(roof, obstruction.x, obstruction.y);
  if (!currentObstructionLngLat) return null;
  const relative = lngLatToMeters(drag.startLngLat, currentObstructionLngLat);
  const delta = lngLatToMeters(drag.startLngLat, currentLngLat);
  const newLngLat = metersToLngLat(drag.startLngLat, relative.x + delta.x, relative.y + delta.y);
  return lngLatToModule(roof, newLngLat);
}

// A new obstruction's shape while it's still being dragged out — the same
// "opposite corners" rectangle math the select-rectangle uses, or a circle
// whose radius is the cursor's distance from the drag's start.
function resolveObstructionDraft(
  draft: ObstructionDraft,
  roof: Roof,
  currentLngLat: LngLat
): { x: number; y: number; shape: ObstructionShape } | null {
  const start = lngLatToModule(roof, draft.startLngLat);
  const cursor = lngLatToModule(roof, currentLngLat);
  if (!start || !cursor) return null;

  if (draft.kind === "circle") {
    const radius = Math.max(MIN_OBSTRUCTION_SIZE_METERS / 2, Math.hypot(cursor.x - start.x, cursor.y - start.y));
    return { x: start.x, y: start.y, shape: { kind: "circle", radius } };
  }

  const minX = Math.min(start.x, cursor.x);
  const maxX = Math.max(start.x, cursor.x);
  const minY = Math.min(start.y, cursor.y);
  const maxY = Math.max(start.y, cursor.y);
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    shape: {
      kind: "rectangle",
      width: Math.max(MIN_OBSTRUCTION_SIZE_METERS, maxX - minX),
      height: Math.max(MIN_OBSTRUCTION_SIZE_METERS, maxY - minY),
    },
  };
}

// Where a group-move drag's rigid translation actually goes, as an
// anchor/target pair ready for resolveGroupMove (and for the live preview,
// which just needs their meters delta) — the grabbed module's own current
// position and where it lands once the raw mouse-driven target snaps onto a
// nearby module's adjacent slot, exactly like a new module placement snaps
// (see snapToAdjacentModule). Snapping only ever considers modules outside
// the dragged group — a module can't snap to itself or to another one
// riding along with it. Every other module in the group is translated by
// this same anchor->target delta, which is what keeps the whole group
// rigid: the grabbed module's snap becomes the group's snap.
function resolveDragTarget(
  moduleDrag: ModuleDrag,
  modules: Module[],
  moduleTypes: ModuleType[],
  roofs: Roof[],
  currentLngLat: LngLat
): { anchorLngLat: LngLat; targetLngLat: LngLat } | null {
  const grabbed = modules.find((m) => m.id === moduleDrag.grabbedModuleId);
  const roof = grabbed && roofs.find((r) => r.id === grabbed.roofId);
  if (!grabbed || !roof) return null;

  const anchorLngLat = moduleToLngLat(roof, grabbed.x, grabbed.y);
  if (!anchorLngLat) return null;

  // The grabbed module's position under the raw (unsnapped) mouse delta,
  // re-expressed in its own roof's local frame so it can be checked against
  // that roof's other modules the same way a new placement would be.
  const rawDelta = lngLatToMeters(moduleDrag.startLngLat, currentLngLat);
  const rawTargetLngLat = metersToLngLat(anchorLngLat, rawDelta.x, rawDelta.y);
  const rawLocal = lngLatToModule(roof, rawTargetLngLat);
  if (!rawLocal) return null;

  const others = modules.filter((m) => !moduleDrag.moduleIds.includes(m.id));
  const snapped = snapToAdjacentModule(
    others,
    moduleTypes,
    roof.id,
    rawLocal.x,
    rawLocal.y,
    grabbed.orientation,
    grabbed.moduleTypeId,
    roof.tilt
  );

  const finalLocal = snapped ?? rawLocal;
  const targetLngLat = moduleToLngLat(roof, finalLocal.x, finalLocal.y);
  if (!targetLngLat) return null;

  return { anchorLngLat, targetLngLat };
}

export default function MapView({
  center,
  roofs,
  drawing,
  onRoofDrawn,
  onCancelDrawing,
  modules,
  moduleTypes,
  pendingPlacement,
  onPlacementResolved,
  onGroupMoveResolved,
  onCancelPlacement,
  selectedModuleIds,
  onModuleClick,
  onModuleDoubleClick,
  onRectSelect,
  selectedRoofId,
  onRoofClick,
  obstructions,
  pendingObstructionShape,
  onObstructionDrawn,
  onCancelObstructionDraw,
  selectedObstructionId,
  onObstructionClick,
  onObstructionChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [styleLoaded, setStyleLoaded] = useState(false);
  const [draftPoints, setDraftPoints] = useState<[number, number][]>([]);
  const [placementError, setPlacementError] = useState<string | null>(null);
  const [mouseLngLat, setMouseLngLat] = useState<LngLat | null>(null);
  const [boxSelect, setBoxSelect] = useState<BoxSelect | null>(null);
  const [obstructionDraft, setObstructionDraft] = useState<ObstructionDraft | null>(null);
  const [obstructionDrag, setObstructionDrag] = useState<ObstructionDrag | null>(null);
  const [obstructionResize, setObstructionResize] = useState<ObstructionResize | null>(null);
  const [moduleDrag, setModuleDrag] = useState<ModuleDrag | null>(null);

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: ESRI_WORLD_IMAGERY_STYLE,
      center: center ? [center.lng, center.lat] : DEFAULT_CENTER,
      zoom: center ? ADDRESS_ZOOM : DEFAULT_ZOOM,
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    // Double-click means "select all modules on this roof" (see the dblclick
    // handler below), not zoom.
    map.doubleClickZoom.disable();
    // Shift+click means "add to the module selection" (see the idle branch
    // of the click handler below) — MapLibre's default shift+drag box-zoom
    // would otherwise intercept shift-held clicks before they reach it.
    map.boxZoom.disable();

    map.on("load", () => {
      map.addSource(ROOFS_SOURCE_ID, { type: "geojson", data: emptyFC() });
      map.addLayer({
        id: "roofs-fill",
        type: "fill",
        source: ROOFS_SOURCE_ID,
        paint: { "fill-color": "#ff9800", "fill-opacity": 0.35 },
      });
      map.addLayer({
        id: "roofs-outline",
        type: "line",
        source: ROOFS_SOURCE_ID,
        paint: { "line-color": "#ff9800", "line-width": 2 },
      });

      map.addSource(MODULES_SOURCE_ID, { type: "geojson", data: emptyFC() });
      map.addLayer({
        id: MODULES_FILL_LAYER_ID,
        type: "fill",
        source: MODULES_SOURCE_ID,
        paint: { "fill-color": "#1a237e", "fill-opacity": 0.85 },
      });
      map.addLayer({
        id: "modules-outline",
        type: "line",
        source: MODULES_SOURCE_ID,
        paint: { "line-color": "#ffee58", "line-width": 1 },
      });

      // Obstructions (vents, chimneys, HVAC units) — a neutral gray/black so
      // they read as "physical object in the way," clearly distinct from
      // both a roof (orange/teal) and a module (indigo/yellow). Selected
      // gets a red outline, the universal "avoid/don't place here" cue.
      map.addSource(OBSTRUCTIONS_SOURCE_ID, { type: "geojson", data: emptyFC() });
      map.addLayer({
        id: OBSTRUCTIONS_FILL_LAYER_ID,
        type: "fill",
        source: OBSTRUCTIONS_SOURCE_ID,
        paint: { "fill-color": "#616161", "fill-opacity": 0.6 },
      });
      map.addLayer({
        id: "obstructions-outline",
        type: "line",
        source: OBSTRUCTIONS_SOURCE_ID,
        paint: { "line-color": "#212121", "line-width": 2 },
      });

      // Resize handles for the selected obstruction — small enough to read
      // as a control, not a design element, matching draft-points' style.
      map.addSource(OBSTRUCTION_HANDLES_SOURCE_ID, { type: "geojson", data: emptyFC() });
      map.addLayer({
        id: OBSTRUCTION_HANDLES_LAYER_ID,
        type: "circle",
        source: OBSTRUCTION_HANDLES_SOURCE_ID,
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffffff",
          "circle-stroke-color": "#212121",
          "circle-stroke-width": 1.5,
        },
      });

      // The marquee drawn while dragging a select-rectangle across a roof.
      // Blue reads clearly against both roof states (orange unselected,
      // teal selected) without being confused for either, and the fill is
      // solid enough to read as "an area" while still showing the roof and
      // modules underneath.
      map.addSource(SELECT_RECT_SOURCE_ID, { type: "geojson", data: emptyFC() });
      map.addLayer({
        id: "select-rect-fill",
        type: "fill",
        source: SELECT_RECT_SOURCE_ID,
        paint: { "fill-color": "#2979ff", "fill-opacity": 0.3 },
      });
      map.addLayer({
        id: "select-rect-outline",
        type: "line",
        source: SELECT_RECT_SOURCE_ID,
        paint: { "line-color": "#2979ff", "line-width": 2, "line-dasharray": [4, 2] },
      });

      // A reference line, not a real edge — kept visually subdued (thin,
      // finely dotted, semi-transparent) and beneath the draft line/points
      // so it never gets mistaken for one.
      map.addSource(CLOSING_GUIDE_SOURCE_ID, { type: "geojson", data: emptyFC() });
      map.addLayer({
        id: "closing-guide-line",
        type: "line",
        source: CLOSING_GUIDE_SOURCE_ID,
        paint: { "line-color": "#ffffff", "line-width": 1, "line-dasharray": [1, 3], "line-opacity": 0.6 },
      });

      map.addSource(DRAFT_LINE_SOURCE_ID, { type: "geojson", data: emptyFC() });
      map.addLayer({
        id: "draft-line",
        type: "line",
        source: DRAFT_LINE_SOURCE_ID,
        paint: { "line-color": "#ffee58", "line-width": 2, "line-dasharray": [2, 2] },
      });

      map.addSource(DRAFT_POINTS_SOURCE_ID, { type: "geojson", data: emptyFC() });
      map.addLayer({
        id: "draft-points",
        type: "circle",
        source: DRAFT_POINTS_SOURCE_ID,
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffee58",
          "circle-stroke-color": "#333",
          "circle-stroke-width": 1,
        },
      });

      setStyleLoaded(true);
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fly to a new address when one is selected, without recreating the map.
  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.flyTo({ center: [center.lng, center.lat], zoom: ADDRESS_ZOOM });
  }, [center]);

  // Keep the committed roof outlines in sync with the source of truth.
  useEffect(() => {
    if (!mapRef.current || !styleLoaded) return;
    const source = mapRef.current.getSource(ROOFS_SOURCE_ID) as maplibregl.GeoJSONSource;
    source?.setData({
      type: "FeatureCollection",
      features: roofs
        .filter((r) => r.roofOutline)
        .map((r) => ({ type: "Feature", properties: { id: r.id }, geometry: r.roofOutline! })),
    });
  }, [roofs, styleLoaded]);

  // Keep placed modules in sync with the source of truth. While a group is
  // being dragged, its members are drawn translated by the same
  // anchor->target delta resolveGroupMove will actually apply on release —
  // snap included — so the move (and the snap) is visible happening live
  // instead of only appearing once dropped.
  useEffect(() => {
    if (!mapRef.current || !styleLoaded) return;
    const source = mapRef.current.getSource(MODULES_SOURCE_ID) as maplibregl.GeoJSONSource;

    const dragResolution =
      moduleDrag && mouseLngLat ? resolveDragTarget(moduleDrag, modules, moduleTypes, roofs, mouseLngLat) : null;
    const dragDelta = dragResolution && lngLatToMeters(dragResolution.anchorLngLat, dragResolution.targetLngLat);

    const features: GeoJSON.Feature[] = [];
    for (const m of modules) {
      const roof = roofs.find((r) => r.id === m.roofId);
      const type = moduleTypes.find((t) => t.id === m.moduleTypeId);
      if (!roof || !type) continue;
      let ring = moduleRing(roof, m, type);
      if (!ring) continue;

      if (dragDelta && moduleDrag!.moduleIds.includes(m.id)) {
        const anchorLngLat = dragResolution!.anchorLngLat;
        ring = ring.map(([lng, lat]) => {
          const relative = lngLatToMeters(anchorLngLat, { lng, lat });
          const shifted = metersToLngLat(anchorLngLat, relative.x + dragDelta.x, relative.y + dragDelta.y);
          return [shifted.lng, shifted.lat];
        });
      }

      features.push({
        type: "Feature",
        properties: { id: m.id },
        geometry: { type: "Polygon", coordinates: [ring] },
      });
    }
    source?.setData({ type: "FeatureCollection", features });
  }, [modules, roofs, moduleTypes, styleLoaded, moduleDrag, mouseLngLat]);

  // Keep obstructions in sync with the source of truth, live-previewing
  // whichever one (if any) is currently being drawn, moved, or resized —
  // same "show it happening, not just the result" approach as the module
  // drag preview above.
  useEffect(() => {
    if (!mapRef.current || !styleLoaded) return;
    const source = mapRef.current.getSource(OBSTRUCTIONS_SOURCE_ID) as maplibregl.GeoJSONSource;

    const features: GeoJSON.Feature[] = [];
    for (const o of obstructions) {
      const roof = roofs.find((r) => r.id === o.roofId);
      if (!roof) continue;

      let live: { x: number; y: number; shape: ObstructionShape } = { x: o.x, y: o.y, shape: o.shape };
      if (obstructionDrag && obstructionDrag.obstructionId === o.id && mouseLngLat) {
        const moved = resolveObstructionMove(obstructionDrag, o, roof, mouseLngLat);
        if (moved) live = { ...live, ...moved };
      } else if (obstructionResize && obstructionResize.obstructionId === o.id && mouseLngLat) {
        const resized = resolveObstructionResize(obstructionResize, roof, mouseLngLat);
        if (resized) live = resized;
      }

      const ring = obstructionRing(roof, { ...o, x: live.x, y: live.y, shape: live.shape });
      if (!ring) continue;
      features.push({ type: "Feature", properties: { id: o.id }, geometry: { type: "Polygon", coordinates: [ring] } });
    }

    if (obstructionDraft && mouseLngLat) {
      const roof = roofs.find((r) => r.id === obstructionDraft.roofId);
      const draft = roof && resolveObstructionDraft(obstructionDraft, roof, mouseLngLat);
      if (roof && draft) {
        const ring = obstructionRing(roof, { id: "draft", roofId: roof.id, x: draft.x, y: draft.y, shape: draft.shape });
        if (ring) {
          features.push({ type: "Feature", properties: { id: "draft" }, geometry: { type: "Polygon", coordinates: [ring] } });
        }
      }
    }

    source?.setData({ type: "FeatureCollection", features });
  }, [obstructions, roofs, styleLoaded, obstructionDrag, obstructionResize, obstructionDraft, mouseLngLat]);

  // Render resize handles for the selected obstruction — hidden while it's
  // being drawn fresh (no handles for a shape that doesn't exist yet) or
  // dragged (handles would just be extra noise riding along with the move;
  // a resize and a move are already mutually exclusive gestures anyway).
  useEffect(() => {
    if (!mapRef.current || !styleLoaded) return;
    const source = mapRef.current.getSource(OBSTRUCTION_HANDLES_SOURCE_ID) as maplibregl.GeoJSONSource;

    const selected = !obstructionDraft && !obstructionDrag && obstructions.find((o) => o.id === selectedObstructionId);
    const roof = selected && roofs.find((r) => r.id === selected.roofId);

    let handlePoints: { handle: ObstructionHandle; x: number; y: number }[] = [];
    if (selected && roof) {
      let live: { x: number; y: number; shape: ObstructionShape } = { x: selected.x, y: selected.y, shape: selected.shape };
      if (obstructionResize && obstructionResize.obstructionId === selected.id && mouseLngLat) {
        const resized = resolveObstructionResize(obstructionResize, roof, mouseLngLat);
        if (resized) live = resized;
      }
      handlePoints = obstructionHandlePoints(live.x, live.y, live.shape);
    }

    const features: GeoJSON.Feature[] = [];
    for (const { handle, x, y } of handlePoints) {
      const ll = roof && moduleToLngLat(roof, x, y);
      if (ll) {
        features.push({ type: "Feature", properties: { handle }, geometry: { type: "Point", coordinates: [ll.lng, ll.lat] } });
      }
    }
    source?.setData({ type: "FeatureCollection", features });
  }, [obstructions, roofs, styleLoaded, selectedObstructionId, obstructionDraft, obstructionDrag, obstructionResize, mouseLngLat]);

  // Highlight the selected obstruction with a red outline — the universal
  // "don't place here" cue — leaving color choice free for everything else.
  useEffect(() => {
    if (!mapRef.current || !styleLoaded) return;
    mapRef.current.setPaintProperty("obstructions-outline", "line-color", [
      "case",
      ["==", ["get", "id"], selectedObstructionId ?? ""],
      "#ff5252",
      "#212121",
    ]);
    mapRef.current.setPaintProperty("obstructions-outline", "line-width", [
      "case",
      ["==", ["get", "id"], selectedObstructionId ?? ""],
      3,
      2,
    ]);
  }, [selectedObstructionId, styleLoaded]);

  // Highlight every selected module.
  useEffect(() => {
    if (!mapRef.current || !styleLoaded) return;
    mapRef.current.setPaintProperty("modules-outline", "line-color", [
      "case",
      ["in", ["get", "id"], ["literal", selectedModuleIds]],
      "#4caf50",
      "#ffee58",
    ]);
    mapRef.current.setPaintProperty("modules-outline", "line-width", [
      "case",
      ["in", ["get", "id"], ["literal", selectedModuleIds]],
      3,
      1,
    ]);
  }, [selectedModuleIds, styleLoaded]);

  // Modules being actively dragged fade out heavily — the outline (above)
  // stays fully visible so the shape and position are still clear, but a
  // near-see-through fill means whatever's underneath (another module, the
  // roof edge, bare ground past it) stays visible too, so a bad drop spot
  // is obvious before you let go rather than after.
  useEffect(() => {
    if (!mapRef.current || !styleLoaded) return;
    const draggingIds = moduleDrag?.moduleIds ?? [];
    mapRef.current.setPaintProperty(MODULES_FILL_LAYER_ID, "fill-opacity", [
      "case",
      ["in", ["get", "id"], ["literal", draggingIds]],
      0.2,
      0.85,
    ]);
  }, [moduleDrag, styleLoaded]);

  // Same fade for an obstruction being actively moved or resized, and for
  // the same reason — seeing what's underneath (a module it'd now overlap,
  // the roof edge) matters more mid-gesture than a solid fill does.
  useEffect(() => {
    if (!mapRef.current || !styleLoaded) return;
    const activeId = obstructionDrag?.obstructionId ?? obstructionResize?.obstructionId ?? null;
    mapRef.current.setPaintProperty(OBSTRUCTIONS_FILL_LAYER_ID, "fill-opacity", [
      "case",
      ["==", ["get", "id"], activeId ?? ""],
      0.2,
      0.6,
    ]);
  }, [obstructionDrag, obstructionResize, styleLoaded]);

  // Highlight the selected roof. Uses a distinct hue (orange -> teal, not
  // just a lighter/darker orange) plus a visibly thicker outline, so the
  // selection doesn't rely on color alone — orange/teal also stays
  // distinguishable under the common red-green color-vision deficiencies,
  // unlike an orange/green pairing would.
  useEffect(() => {
    if (!mapRef.current || !styleLoaded) return;
    mapRef.current.setPaintProperty("roofs-fill", "fill-color", [
      "case",
      ["==", ["get", "id"], selectedRoofId ?? ""],
      "#00acc1",
      "#ff9800",
    ]);
    mapRef.current.setPaintProperty("roofs-outline", "line-color", [
      "case",
      ["==", ["get", "id"], selectedRoofId ?? ""],
      "#00838f",
      "#ff9800",
    ]);
    mapRef.current.setPaintProperty("roofs-outline", "line-width", [
      "case",
      ["==", ["get", "id"], selectedRoofId ?? ""],
      4,
      2,
    ]);
  }, [selectedRoofId, styleLoaded]);

  // Track the cursor while a roof is being traced, a select-rectangle drag
  // is in progress, a group of already-selected modules is being dragged,
  // or an obstruction is being drawn/moved/resized, to drive the preview
  // lines/rectangle/live positions below. Listens on the canvas directly
  // (rather than MapLibre's own "mousemove" event) because these drags hold
  // the mouse button down throughout — with dragPan disabled for them and
  // no other gesture handler claiming it, MapLibre's own handler pipeline
  // doesn't forward that movement as a "mousemove" event at all, so this is
  // the one case that actually needs the raw DOM event underneath it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || (!drawing && !boxSelect && !moduleDrag && !obstructionDraft && !obstructionDrag && !obstructionResize)) {
      setMouseLngLat(null);
      return;
    }
    const canvas = map.getCanvas();
    function handleMouseMove(e: MouseEvent) {
      const rect = canvas.getBoundingClientRect();
      const ll = map!.unproject([e.clientX - rect.left, e.clientY - rect.top]);
      setMouseLngLat({ lng: ll.lng, lat: ll.lat });
    }
    canvas.addEventListener("mousemove", handleMouseMove);
    return () => {
      canvas.removeEventListener("mousemove", handleMouseMove);
    };
  }, [drawing, boxSelect, moduleDrag, obstructionDraft, obstructionDrag, obstructionResize]);

  // Reset any in-progress trace/placement error when the relevant mode starts.
  useEffect(() => {
    if (!drawing) setDraftPoints([]);
  }, [drawing]);

  useEffect(() => {
    setPlacementError(null);
  }, [pendingPlacement]);

  // If the parent cancels obstruction-draw mode (Cancel button, Escape)
  // mid-drag, clean up the drag itself rather than leaving dragPan disabled
  // and a phantom draft behind.
  useEffect(() => {
    if (pendingObstructionShape) return;
    setObstructionDraft((prev) => {
      if (prev) mapRef.current?.dragPan.enable();
      return null;
    });
  }, [pendingObstructionShape]);

  // Single click handler covering all three interaction modes: tracing a
  // roof, placing a module, or (idle) selecting one.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    map.getCanvas().style.cursor =
      moduleDrag || obstructionDrag || obstructionResize
        ? "grabbing"
        : drawing || !!pendingPlacement || !!boxSelect || !!pendingObstructionShape || !!obstructionDraft
          ? "crosshair"
          : "";

    function handleClick(e: maplibregl.MapMouseEvent) {
      if (drawing) {
        // Clicking near the first vertex closes the loop instead of adding
        // another point — same proximity check (and snap target) as the
        // preview line above, so what you see is what you get.
        //
        // TODO: this and snapDraftPoint's snaps are cases of the same
        // general snapping system — see "Roof outline drawing: future
        // CAD-like tools" in docs/FUTURE-NOTES.md for what's still planned
        // (edge-midpoint snapping, fillet, autocomplete).
        if (draftPoints.length >= 3) {
          const dist = e.point.dist(map!.project(draftPoints[0]));
          if (dist <= SNAP_PX) {
            finishDrawing(draftPoints);
            return;
          }
        }

        const clicked = snapDraftPoint(map!, roofs, draftPoints, e.point);

        setDraftPoints((prev) => {
          const last = prev[prev.length - 1];
          // A duplicate point (e.g. an accidental double-click) creates a
          // zero-length edge that gets traced twice — that silently breaks
          // ray-casting containment checks later, since every real crossing
          // along it gets counted twice and cancels itself out. Skip it.
          if (last && last[0] === clicked[0] && last[1] === clicked[1]) return prev;
          return [...prev, clicked];
        });
        return;
      }

      // Drawing an obstruction is a drag gesture end-to-end (see
      // handleMouseDown/handleMouseUp) — a plain click here has nothing to
      // do.
      if (pendingObstructionShape) return;

      if (pendingPlacement) {
        const point: [number, number] = [e.lngLat.lng, e.lngLat.lat];
        const roof = findContainingRoof(roofs, point);
        if (!roof) {
          setPlacementError("Click inside a traced roof outline");
          return;
        }
        const local = lngLatToModule(roof, { lng: point[0], lat: point[1] });
        if (!local) return;
        // A click near an existing module snaps to sit right next to it
        // (edge-to-edge, same as Fill's grid) instead of landing wherever
        // the cursor happened to be — building out a grid one placement at
        // a time without having to eyeball each gap.
        const snapped = snapToAdjacentModule(
          modules,
          moduleTypes,
          roof.id,
          local.x,
          local.y,
          pendingPlacement.orientation,
          pendingPlacement.moduleTypeId,
          roof.tilt
        );
        const { x, y } = snapped ?? local;
        if (
          overlapsExisting(
            modules,
            moduleTypes,
            roof.id,
            x,
            y,
            pendingPlacement.orientation,
            pendingPlacement.moduleTypeId,
            roof.tilt,
            obstructions
          )
        ) {
          setPlacementError("Modules can't overlap another module or obstruction — try another spot");
          return;
        }
        // Placement mode stays open for the next module (see
        // handlePlacementResolved), so — unlike before, when a fresh
        // pendingPlacement object on every "+ Add module" press reset this
        // via the effect below — a stale error from an earlier miss has to
        // be cleared explicitly on the next success, or it'd linger on
        // screen despite every placement since actually landing fine.
        setPlacementError(null);
        onPlacementResolved(roof.id, x, y);
        return;
      }

      // Idle: clicking an obstruction selects it (clearing module/roof
      // selection — see OpenedProjectView). Otherwise, clicking a module
      // adds it to the selection (shift/ctrl/cmd removes an already-
      // selected one) and clears any roof selection. Missing every module
      // but still landing inside a roof selects that roof instead (toggling
      // it off if it's already selected) and clears module selection.
      // Missing everything clears all three.
      const obstructionHits = map!.queryRenderedFeatures(e.point, { layers: [OBSTRUCTIONS_FILL_LAYER_ID] });
      const obstructionHitId = obstructionHits[0]?.properties?.id as string | undefined;
      if (obstructionHitId) {
        onObstructionClick(obstructionHitId);
        return;
      }

      const hits = map!.queryRenderedFeatures(e.point, { layers: [MODULES_FILL_LAYER_ID] });
      const hitId = hits[0]?.properties?.id as string | undefined;

      if (hitId) {
        const additive = e.originalEvent.shiftKey || e.originalEvent.metaKey || e.originalEvent.ctrlKey;
        onModuleClick(hitId, additive);
        return;
      }

      const clickedRoof = findContainingRoof(roofs, [e.lngLat.lng, e.lngLat.lat]);
      if (clickedRoof) {
        onRoofClick(clickedRoof.id);
        return;
      }

      onModuleClick(null, false);
    }

    // Double-click a module to select every module on its roof — only makes
    // sense in idle mode (not while tracing/placing/moving).
    //
    // TODO: once subarrays exist (see "Deferred: Subarrays" in
    // docs/PROJECT-OVERVIEW.md), plain double-click should narrow to
    // selecting the module's subarray instead, with this whole-roof
    // behavior demoted to a modifier, e.g. shift+double-click — not dropped.
    function handleDoubleClick(e: maplibregl.MapMouseEvent) {
      if (drawing || pendingPlacement || pendingObstructionShape) return;
      const hits = map!.queryRenderedFeatures(e.point, { layers: [MODULES_FILL_LAYER_ID] });
      const hitId = hits[0]?.properties?.id as string | undefined;
      const roofId = hitId ? modules.find((m) => m.id === hitId)?.roofId : undefined;
      if (roofId) onModuleDoubleClick(roofId);
    }

    // Starting a drag on an already-selected module picks the whole
    // selection up to move together; starting one inside a roof otherwise
    // begins a select rectangle instead of panning the map. Either way,
    // disabling dragPan here, before any movement happens, is what stops
    // MapLibre's own pan gesture from ever grabbing it.
    function handleMouseDown(e: maplibregl.MapMouseEvent) {
      if (drawing || pendingPlacement) return;

      // Drawing a new obstruction takes priority over everything else idle
      // mode would otherwise do with a drag starting inside a roof.
      if (pendingObstructionShape) {
        const roof = findContainingRoof(roofs, [e.lngLat.lng, e.lngLat.lat]);
        if (!roof) return;
        map!.dragPan.disable();
        setPlacementError(null);
        setObstructionDraft({
          roofId: roof.id,
          kind: pendingObstructionShape,
          startLngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
          startScreen: { x: e.point.x, y: e.point.y },
        });
        return;
      }

      // A resize handle (or the body, to move it) only ever grabs the
      // already-selected obstruction — same "must already be selected"
      // rule as picking up a module to move it.
      if (selectedObstructionId) {
        const selected = obstructions.find((o) => o.id === selectedObstructionId);
        const obstructionRoof = selected && roofs.find((r) => r.id === selected.roofId);
        if (selected && obstructionRoof) {
          let closestHandle: ObstructionHandle | null = null;
          let closestDist = HANDLE_HIT_PX;
          for (const point of obstructionHandlePoints(selected.x, selected.y, selected.shape)) {
            const ll = moduleToLngLat(obstructionRoof, point.x, point.y);
            if (!ll) continue;
            const dist = e.point.dist(map!.project([ll.lng, ll.lat]));
            if (dist <= closestDist) {
              closestDist = dist;
              closestHandle = point.handle;
            }
          }
          if (closestHandle) {
            map!.dragPan.disable();
            setPlacementError(null);
            setObstructionResize({
              obstructionId: selected.id,
              roofId: obstructionRoof.id,
              handle: closestHandle,
              originalX: selected.x,
              originalY: selected.y,
              originalShape: selected.shape,
            });
            return;
          }

          const bodyHits = map!.queryRenderedFeatures(e.point, { layers: [OBSTRUCTIONS_FILL_LAYER_ID] });
          const bodyHitId = bodyHits[0]?.properties?.id as string | undefined;
          if (bodyHitId === selected.id) {
            map!.dragPan.disable();
            setPlacementError(null);
            setObstructionDrag({
              obstructionId: selected.id,
              roofId: obstructionRoof.id,
              startLngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
              startScreen: { x: e.point.x, y: e.point.y },
            });
            return;
          }
        }
      }

      const hits = map!.queryRenderedFeatures(e.point, { layers: [MODULES_FILL_LAYER_ID] });
      const hitId = hits[0]?.properties?.id as string | undefined;
      if (hitId && selectedModuleIds.includes(hitId)) {
        map!.dragPan.disable();
        setPlacementError(null);
        setModuleDrag({
          moduleIds: selectedModuleIds,
          grabbedModuleId: hitId,
          startLngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
          startScreen: { x: e.point.x, y: e.point.y },
        });
        return;
      }

      const roof = findContainingRoof(roofs, [e.lngLat.lng, e.lngLat.lat]);
      if (!roof) return;
      map!.dragPan.disable();
      setPlacementError(null);
      setBoxSelect({
        roofId: roof.id,
        startLngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
        startScreen: { x: e.point.x, y: e.point.y },
      });
    }

    function handleMouseUp(e: maplibregl.MapMouseEvent) {
      const currentLngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };

      if (obstructionDraft) {
        map!.dragPan.enable();
        setObstructionDraft(null);

        // Barely moved (or didn't at all) — a real drag is how an
        // obstruction gets its size, so a stray click here just does
        // nothing rather than leaving a MIN_OBSTRUCTION_SIZE_METERS speck.
        const dragDistance = e.point.dist(
          new maplibregl.Point(obstructionDraft.startScreen.x, obstructionDraft.startScreen.y)
        );
        if (dragDistance < DRAG_MIN_PX) return;

        const roof = roofs.find((r) => r.id === obstructionDraft.roofId);
        const resolved = roof && resolveObstructionDraft(obstructionDraft, roof, currentLngLat);
        if (resolved) onObstructionDrawn(obstructionDraft.roofId, resolved.shape, resolved.x, resolved.y);
        return;
      }

      if (obstructionResize) {
        map!.dragPan.enable();
        setObstructionResize(null);
        const roof = roofs.find((r) => r.id === obstructionResize.roofId);
        const resolved = roof && resolveObstructionResize(obstructionResize, roof, currentLngLat);
        if (resolved) onObstructionChange(obstructionResize.obstructionId, resolved.x, resolved.y, resolved.shape);
        return;
      }

      if (obstructionDrag) {
        map!.dragPan.enable();
        setObstructionDrag(null);

        // Barely moved (or didn't at all) — leave it as the plain click it
        // basically is (e.g. re-selecting the same obstruction).
        const dragDistance = e.point.dist(
          new maplibregl.Point(obstructionDrag.startScreen.x, obstructionDrag.startScreen.y)
        );
        if (dragDistance < DRAG_MIN_PX) return;

        const roof = roofs.find((r) => r.id === obstructionDrag.roofId);
        const obstruction = obstructions.find((o) => o.id === obstructionDrag.obstructionId);
        const moved = roof && obstruction && resolveObstructionMove(obstructionDrag, obstruction, roof, currentLngLat);
        if (moved && obstruction) onObstructionChange(obstruction.id, moved.x, moved.y, obstruction.shape);
        return;
      }

      if (moduleDrag) {
        map!.dragPan.enable();
        setModuleDrag(null);

        // Barely moved (or didn't at all) — leave it as the plain click it
        // basically is (e.g. shift-click to deselect), rather than
        // resolving a no-op move that'd needlessly touch every selected
        // module's stored position.
        const dragDistance = e.point.dist(new maplibregl.Point(moduleDrag.startScreen.x, moduleDrag.startScreen.y));
        if (dragDistance < DRAG_MIN_PX) return;

        const resolution = resolveDragTarget(moduleDrag, modules, moduleTypes, roofs, currentLngLat);
        if (!resolution) return;
        const results = resolveGroupMove(
          modules,
          moduleTypes,
          roofs,
          obstructions,
          moduleDrag.moduleIds,
          resolution.anchorLngLat,
          resolution.targetLngLat
        );
        if (!results) {
          setPlacementError("That move would take a module off its roof or into an overlap — try a different spot");
          return;
        }
        onGroupMoveResolved(results);
        return;
      }

      if (!boxSelect) return;
      map!.dragPan.enable();
      setBoxSelect(null);

      // Barely moved (or didn't at all) — treat it as the plain click it
      // basically is, rather than an empty select-rectangle that would
      // otherwise wipe out the current selection.
      const dragDistance = e.point.dist(new maplibregl.Point(boxSelect.startScreen.x, boxSelect.startScreen.y));
      if (dragDistance < DRAG_MIN_PX) return;

      const roof = roofs.find((r) => r.id === boxSelect.roofId);
      if (!roof) return;
      const start = lngLatToModule(roof, boxSelect.startLngLat);
      const current = lngLatToModule(roof, { lng: e.lngLat.lng, lat: e.lngLat.lat });
      if (!start || !current) return;

      const rect = {
        minX: Math.min(start.x, current.x),
        maxX: Math.max(start.x, current.x),
        minY: Math.min(start.y, current.y),
        maxY: Math.max(start.y, current.y),
      };
      const touchedIds = modulesTouchingRect(modules, moduleTypes, roof.id, roof.tilt, rect);
      onRectSelect(roof.id, touchedIds);
    }

    map.on("click", handleClick);
    map.on("dblclick", handleDoubleClick);
    map.on("mousedown", handleMouseDown);
    map.on("mouseup", handleMouseUp);
    return () => {
      map.off("click", handleClick);
      map.off("dblclick", handleDoubleClick);
      map.off("mousedown", handleMouseDown);
      map.off("mouseup", handleMouseUp);
    };
  }, [
    drawing,
    pendingPlacement,
    roofs,
    modules,
    moduleTypes,
    onPlacementResolved,
    onGroupMoveResolved,
    onModuleClick,
    onModuleDoubleClick,
    onRoofClick,
    onRectSelect,
    draftPoints,
    boxSelect,
    moduleDrag,
    selectedModuleIds,
    obstructions,
    pendingObstructionShape,
    onObstructionDrawn,
    onObstructionClick,
    onObstructionChange,
    selectedObstructionId,
    obstructionDraft,
    obstructionDrag,
    obstructionResize,
  ]);

  // Render the in-progress trace: the committed points/edges, plus (while
  // drawing) a trailing preview segment from the last vertex to the cursor,
  // so the next edge is visible before it's placed. That preview segment
  // snaps the same way a click would — onto the first vertex (closing the
  // loop) or onto a nearby vertex from another roof — so what's shown is
  // exactly what clicking now would do.
  useEffect(() => {
    if (!mapRef.current || !styleLoaded) return;
    const map = mapRef.current;
    const lineSource = map.getSource(DRAFT_LINE_SOURCE_ID) as maplibregl.GeoJSONSource;
    const pointsSource = map.getSource(DRAFT_POINTS_SOURCE_ID) as maplibregl.GeoJSONSource;
    const guideSource = map.getSource(CLOSING_GUIDE_SOURCE_ID) as maplibregl.GeoJSONSource;

    let previewCoords = draftPoints;
    // Only drawn once the cursor is close enough to be worth mentioning —
    // otherwise every edge of every roof would carry a permanent line
    // through its first vertex, cluttering the map for no reason. Stays
    // visible through the actual snap too (not just the approach), so the
    // preview edge visibly locking onto it is the confirmation that it
    // worked, rather than the guide vanishing right as it'd be useful.
    let guideCoords: [[number, number], [number, number]] | null = null;
    if (drawing && mouseLngLat) {
      const cursorScreen = map.project([mouseLngLat.lng, mouseLngLat.lat]);
      const cursor: [number, number] =
        draftPoints.length >= 3 && cursorScreen.dist(map.project(draftPoints[0])) <= SNAP_PX
          ? draftPoints[0]
          : snapDraftPoint(map, roofs, draftPoints, cursorScreen);
      previewCoords = [...draftPoints, cursor];

      const guide = projectOntoClosingGuide(map, draftPoints, cursorScreen);
      if (guide && guide.distance <= CLOSING_GUIDE_RANGE_PX) {
        const a = map.unproject(
          new maplibregl.Point(guide.origin.x + guide.ux * CLOSING_GUIDE_EXTENT_PX, guide.origin.y + guide.uy * CLOSING_GUIDE_EXTENT_PX)
        );
        const b = map.unproject(
          new maplibregl.Point(guide.origin.x - guide.ux * CLOSING_GUIDE_EXTENT_PX, guide.origin.y - guide.uy * CLOSING_GUIDE_EXTENT_PX)
        );
        guideCoords = [
          [a.lng, a.lat],
          [b.lng, b.lat],
        ];
      }
    }

    lineSource?.setData(
      previewCoords.length >= 2
        ? {
            type: "FeatureCollection",
            features: [
              { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: previewCoords } },
            ],
          }
        : emptyFC()
    );
    pointsSource?.setData({
      type: "FeatureCollection",
      features: draftPoints.map((p) => ({
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: p },
      })),
    });
    guideSource?.setData(
      guideCoords
        ? {
            type: "FeatureCollection",
            features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: guideCoords } }],
          }
        : emptyFC()
    );
  }, [draftPoints, mouseLngLat, drawing, roofs, styleLoaded]);

  // Render the select-rectangle while a box-select drag is in progress: one
  // corner at the drag's start, the opposite corner at the cursor, both
  // expressed in the roof's own local frame (see snapDraftPoint's azimuth
  // notes) so the box rotates with the roof's azimuth rather than sitting
  // compass-aligned regardless of which way the roof faces.
  useEffect(() => {
    if (!mapRef.current || !styleLoaded) return;
    const map = mapRef.current;
    const rectSource = map.getSource(SELECT_RECT_SOURCE_ID) as maplibregl.GeoJSONSource;

    let coords: [number, number][] | null = null;
    const roof = boxSelect && roofs.find((r) => r.id === boxSelect.roofId);
    if (boxSelect && mouseLngLat && roof) {
      const start = lngLatToModule(roof, boxSelect.startLngLat);
      const current = lngLatToModule(roof, mouseLngLat);
      if (start && current) {
        const minX = Math.min(start.x, current.x);
        const maxX = Math.max(start.x, current.x);
        const minY = Math.min(start.y, current.y);
        const maxY = Math.max(start.y, current.y);
        coords = [
          [minX, minY],
          [maxX, minY],
          [maxX, maxY],
          [minX, maxY],
          [minX, minY],
        ].map(([x, y]) => {
          const ll = moduleToLngLat(roof, x, y)!;
          return [ll.lng, ll.lat];
        });
      }
    }

    rectSource?.setData(
      coords
        ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [coords] } }] }
        : emptyFC()
    );
  }, [boxSelect, mouseLngLat, roofs, styleLoaded]);

  function finishDrawing(points: [number, number][]) {
    if (points.length < 3) return;
    const ring = [...points, points[0]]; // GeoJSON polygons must close
    onRoofDrawn({ type: "Polygon", coordinates: [ring] });
  }

  function handleFinish() {
    finishDrawing(draftPoints);
  }

  return (
    <div className="map-view-wrap">
      <div ref={containerRef} className="map-view" />
      {drawing && (
        <div className="draw-toolbar">
          <span>
            {draftPoints.length === 0
              ? "Click the roof corners to trace its outline"
              : `${draftPoints.length} point${draftPoints.length === 1 ? "" : "s"} placed`}
          </span>
          <button onClick={handleFinish} disabled={draftPoints.length < 3}>
            Finish
          </button>
          <button onClick={onCancelDrawing}>Cancel</button>
        </div>
      )}
      {pendingPlacement && (
        <div className="draw-toolbar">
          <span>{placementError ?? "Click inside a roof to place a module"}</span>
          <button onClick={onCancelPlacement}>Cancel</button>
        </div>
      )}
      {pendingObstructionShape && (
        <div className="draw-toolbar">
          <span>
            {placementError ?? `Drag across a roof to draw the ${pendingObstructionShape}`}
          </span>
          <button onClick={onCancelObstructionDraw}>Cancel</button>
        </div>
      )}
      {!drawing && !pendingPlacement && !pendingObstructionShape && placementError && (
        <div className="draw-toolbar">
          <span>{placementError}</span>
        </div>
      )}
    </div>
  );
}
