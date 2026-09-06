import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  type GroupMoveResult,
  type LngLat,
  type Module,
  type ModuleOrientation,
  type ModuleType,
  type Roof,
  findContainingRoof,
  lngLatToMeters,
  lngLatToModule,
  metersToLngLat,
  moduleRing,
  moduleToLngLat,
  modulesTouchingRect,
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

const ROOFS_SOURCE_ID = "roofs";
const DRAFT_LINE_SOURCE_ID = "draft-line";
const DRAFT_POINTS_SOURCE_ID = "draft-points";
const CLOSING_GUIDE_SOURCE_ID = "closing-guide-line";
const SELECT_RECT_SOURCE_ID = "select-rect";
const MODULES_SOURCE_ID = "modules";
const MODULES_FILL_LAYER_ID = "modules-fill";

const emptyFC = (): GeoJSON.FeatureCollection => ({
  type: "FeatureCollection",
  features: [],
});

export interface PendingPlacement {
  moduleTypeId: string;
  orientation: ModuleOrientation;
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
// current selection, snapshotted at mousedown so it can't change mid-drag)
// and where the drag started — resolveGroupMove only needs that start
// point and the current cursor position to compute the shared real-world
// translation, not which module was actually grabbed.
interface ModuleDrag {
  moduleIds: string[];
  startLngLat: LngLat;
  startScreen: { x: number; y: number };
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
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [styleLoaded, setStyleLoaded] = useState(false);
  const [draftPoints, setDraftPoints] = useState<[number, number][]>([]);
  const [placementError, setPlacementError] = useState<string | null>(null);
  const [mouseLngLat, setMouseLngLat] = useState<LngLat | null>(null);
  const [boxSelect, setBoxSelect] = useState<BoxSelect | null>(null);
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
  // being dragged, its members are drawn translated to the cursor's current
  // offset from the drag's start — the same rigid, real-world-meters
  // translation resolveGroupMove will actually apply on release — so the
  // move is visible happening live instead of only jumping once dropped.
  useEffect(() => {
    if (!mapRef.current || !styleLoaded) return;
    const source = mapRef.current.getSource(MODULES_SOURCE_ID) as maplibregl.GeoJSONSource;

    const dragDelta =
      moduleDrag && mouseLngLat ? lngLatToMeters(moduleDrag.startLngLat, mouseLngLat) : null;

    const features: GeoJSON.Feature[] = [];
    for (const m of modules) {
      const roof = roofs.find((r) => r.id === m.roofId);
      const type = moduleTypes.find((t) => t.id === m.moduleTypeId);
      if (!roof || !type) continue;
      let ring = moduleRing(roof, m, type);
      if (!ring) continue;

      if (dragDelta && moduleDrag!.moduleIds.includes(m.id)) {
        ring = ring.map(([lng, lat]) => {
          const relative = lngLatToMeters(moduleDrag!.startLngLat, { lng, lat });
          const shifted = metersToLngLat(moduleDrag!.startLngLat, relative.x + dragDelta.x, relative.y + dragDelta.y);
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
  // is in progress, or a group of already-selected modules is being
  // dragged, to drive the preview lines/rectangle/live module positions
  // below. Listens on the canvas directly (rather than MapLibre's own
  // "mousemove" event) because both drags hold the mouse button down
  // throughout — with dragPan disabled for them and no other gesture
  // handler claiming it, MapLibre's own handler pipeline doesn't forward
  // that movement as a "mousemove" event at all, so this is the one case
  // that actually needs the raw DOM event underneath it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || (!drawing && !boxSelect && !moduleDrag)) {
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
  }, [drawing, boxSelect, moduleDrag]);

  // Reset any in-progress trace/placement error when the relevant mode starts.
  useEffect(() => {
    if (!drawing) setDraftPoints([]);
  }, [drawing]);

  useEffect(() => {
    setPlacementError(null);
  }, [pendingPlacement]);

  // Single click handler covering all three interaction modes: tracing a
  // roof, placing a module, or (idle) selecting one.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    map.getCanvas().style.cursor = moduleDrag
      ? "grabbing"
      : drawing || !!pendingPlacement || !!boxSelect
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
        if (overlapsExisting(modules, moduleTypes, roof.id, x, y, pendingPlacement.orientation, pendingPlacement.moduleTypeId, roof.tilt)) {
          setPlacementError("Modules can't overlap — try another spot");
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

      // Idle: clicking a module adds it to the selection (shift/ctrl/cmd
      // removes an already-selected one) and clears any roof selection.
      // Missing every module but still landing inside a roof selects that
      // roof instead (toggling it off if it's already selected) and clears
      // module selection. Missing everything clears both.
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
      if (drawing || pendingPlacement) return;
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

      const hits = map!.queryRenderedFeatures(e.point, { layers: [MODULES_FILL_LAYER_ID] });
      const hitId = hits[0]?.properties?.id as string | undefined;
      if (hitId && selectedModuleIds.includes(hitId)) {
        map!.dragPan.disable();
        setPlacementError(null);
        setModuleDrag({
          moduleIds: selectedModuleIds,
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
      if (moduleDrag) {
        map!.dragPan.enable();
        setModuleDrag(null);

        // Barely moved (or didn't at all) — leave it as the plain click it
        // basically is (e.g. shift-click to deselect), rather than
        // resolving a no-op move that'd needlessly touch every selected
        // module's stored position.
        const dragDistance = e.point.dist(new maplibregl.Point(moduleDrag.startScreen.x, moduleDrag.startScreen.y));
        if (dragDistance < DRAG_MIN_PX) return;

        const targetLngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };
        const results = resolveGroupMove(modules, moduleTypes, roofs, moduleDrag.moduleIds, moduleDrag.startLngLat, targetLngLat);
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
      {!drawing && !pendingPlacement && placementError && (
        <div className="draw-toolbar">
          <span>{placementError}</span>
        </div>
      )}
    </div>
  );
}
