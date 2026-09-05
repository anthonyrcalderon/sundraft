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
  lngLatToModule,
  moduleRing,
  moduleToLngLat,
  overlapsExisting,
  resolveGroupMove,
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

const ROOFS_SOURCE_ID = "roofs";
const DRAFT_LINE_SOURCE_ID = "draft-line";
const DRAFT_POINTS_SOURCE_ID = "draft-points";
const MODULES_SOURCE_ID = "modules";
const MODULES_FILL_LAYER_ID = "modules-fill";
const TRANSLATE_LINE_SOURCE_ID = "translate-line";

const emptyFC = (): GeoJSON.FeatureCollection => ({
  type: "FeatureCollection",
  features: [],
});

export type PendingPlacement =
  | { kind: "new"; moduleTypeId: string; orientation: ModuleOrientation }
  | { kind: "move"; moduleIds: string[]; anchorModuleId: string };

// A module's current real-world position — needed to anchor the group-move
// translation line, and as the reference frame for resolveGroupMove.
function moduleLngLat(modules: Module[], roofs: Roof[], moduleId: string): LngLat | null {
  const m = modules.find((mod) => mod.id === moduleId);
  const roof = m && roofs.find((r) => r.id === m.roofId);
  if (!m || !roof) return null;
  return moduleToLngLat(roof, m.x, m.y);
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

// Where a candidate point actually lands once every roof-tracing snap is
// applied, in priority order: an existing roof's vertex first (an exact,
// deliberate target), then the angle snap, then the raw cursor position.
// Used by both the click handler and the live preview line so what's shown
// is exactly what clicking would do.
function snapDraftPoint(
  map: maplibregl.Map,
  roofs: Roof[],
  draftPoints: [number, number][],
  screenPoint: maplibregl.Point
): [number, number] {
  const nearbyVertex = findNearbyRoofVertex(map, roofs, screenPoint);
  if (nearbyVertex) return nearbyVertex;

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
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [styleLoaded, setStyleLoaded] = useState(false);
  const [draftPoints, setDraftPoints] = useState<[number, number][]>([]);
  const [placementError, setPlacementError] = useState<string | null>(null);
  const [mouseLngLat, setMouseLngLat] = useState<LngLat | null>(null);

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

      // Shared "translation" preview during a group move — one line from an
      // anchor module's center to the cursor, standing in for the vector
      // that'll be applied to every selected module on the next click.
      map.addSource(TRANSLATE_LINE_SOURCE_ID, { type: "geojson", data: emptyFC() });
      map.addLayer({
        id: "translate-line",
        type: "line",
        source: TRANSLATE_LINE_SOURCE_ID,
        paint: { "line-color": "#4caf50", "line-width": 2, "line-dasharray": [2, 2] },
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

  // Keep placed modules in sync with the source of truth.
  useEffect(() => {
    if (!mapRef.current || !styleLoaded) return;
    const source = mapRef.current.getSource(MODULES_SOURCE_ID) as maplibregl.GeoJSONSource;
    const features: GeoJSON.Feature[] = [];
    for (const m of modules) {
      const roof = roofs.find((r) => r.id === m.roofId);
      const type = moduleTypes.find((t) => t.id === m.moduleTypeId);
      if (!roof || !type) continue;
      const ring = moduleRing(roof, m, type);
      if (!ring) continue;
      features.push({
        type: "Feature",
        properties: { id: m.id },
        geometry: { type: "Polygon", coordinates: [ring] },
      });
    }
    source?.setData({ type: "FeatureCollection", features });
  }, [modules, roofs, moduleTypes, styleLoaded]);

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

  // Track the cursor while a group move is pending or a roof is being
  // traced, to drive the preview lines below.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || (!drawing && pendingPlacement?.kind !== "move")) {
      setMouseLngLat(null);
      return;
    }
    function handleMouseMove(e: maplibregl.MapMouseEvent) {
      setMouseLngLat({ lng: e.lngLat.lng, lat: e.lngLat.lat });
    }
    map.on("mousemove", handleMouseMove);
    return () => {
      map.off("mousemove", handleMouseMove);
    };
  }, [drawing, pendingPlacement]);

  // Render the shared translation line: anchor module's center -> cursor.
  useEffect(() => {
    if (!mapRef.current || !styleLoaded) return;
    const source = mapRef.current.getSource(TRANSLATE_LINE_SOURCE_ID) as maplibregl.GeoJSONSource;

    const anchorLngLat =
      pendingPlacement?.kind === "move"
        ? moduleLngLat(modules, roofs, pendingPlacement.anchorModuleId)
        : null;

    if (!anchorLngLat || !mouseLngLat) {
      source?.setData(emptyFC());
      return;
    }

    source?.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [anchorLngLat.lng, anchorLngLat.lat],
              [mouseLngLat.lng, mouseLngLat.lat],
            ],
          },
        },
      ],
    });
  }, [pendingPlacement, mouseLngLat, modules, roofs, styleLoaded]);

  // Reset any in-progress trace/placement error when the relevant mode starts.
  useEffect(() => {
    if (!drawing) setDraftPoints([]);
  }, [drawing]);

  useEffect(() => {
    setPlacementError(null);
  }, [pendingPlacement]);

  // Single click handler covering all three interaction modes: tracing a
  // roof, placing/moving a module, or (idle) selecting one.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const active = drawing || !!pendingPlacement;
    map.getCanvas().style.cursor = active ? "crosshair" : "";

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

      if (pendingPlacement?.kind === "move") {
        const anchorLngLat = moduleLngLat(modules, roofs, pendingPlacement.anchorModuleId);
        if (!anchorLngLat) return;
        const targetLngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };
        const results = resolveGroupMove(
          modules,
          moduleTypes,
          roofs,
          pendingPlacement.moduleIds,
          anchorLngLat,
          targetLngLat
        );
        if (!results) {
          setPlacementError(
            "That move would take a module off its roof or into an overlap — try a different spot"
          );
          return;
        }
        onGroupMoveResolved(results);
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
        const { x, y } = local;
        if (overlapsExisting(modules, moduleTypes, roof.id, x, y, pendingPlacement.orientation, pendingPlacement.moduleTypeId)) {
          setPlacementError("Modules can't overlap — try another spot");
          return;
        }
        onPlacementResolved(roof.id, x, y);
        return;
      }

      // Idle: clicking a module adds it to the selection (shift/ctrl/cmd
      // removes an already-selected one). A miss — no module hit — clears
      // the selection, unless it still lands inside the roof the current
      // selection is already on: a near-miss next to a module you meant to
      // click shouldn't cost you your selection.
      const hits = map!.queryRenderedFeatures(e.point, { layers: [MODULES_FILL_LAYER_ID] });
      const hitId = hits[0]?.properties?.id as string | undefined;
      const additive = e.originalEvent.shiftKey || e.originalEvent.metaKey || e.originalEvent.ctrlKey;

      if (!hitId && selectedModuleIds.length > 0) {
        const selectionRoofId = modules.find((m) => m.id === selectedModuleIds[0])?.roofId;
        const clickedRoof = findContainingRoof(roofs, [e.lngLat.lng, e.lngLat.lat]);
        if (selectionRoofId && clickedRoof?.id === selectionRoofId) return;
      }

      onModuleClick(hitId ?? null, additive);
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

    map.on("click", handleClick);
    map.on("dblclick", handleDoubleClick);
    return () => {
      map.off("click", handleClick);
      map.off("dblclick", handleDoubleClick);
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
    selectedModuleIds,
    draftPoints,
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

    let previewCoords = draftPoints;
    if (drawing && mouseLngLat) {
      const cursorScreen = map.project([mouseLngLat.lng, mouseLngLat.lat]);
      const cursor: [number, number] =
        draftPoints.length >= 3 && cursorScreen.dist(map.project(draftPoints[0])) <= SNAP_PX
          ? draftPoints[0]
          : snapDraftPoint(map, roofs, draftPoints, cursorScreen);
      previewCoords = [...draftPoints, cursor];
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
  }, [draftPoints, mouseLngLat, drawing, roofs, styleLoaded]);

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
          <span>
            {placementError ??
              (pendingPlacement.kind === "move"
                ? `Click where ${
                    pendingPlacement.moduleIds.length === 1
                      ? "this module"
                      : `these ${pendingPlacement.moduleIds.length} modules`
                  } should land`
                : "Click inside a roof to place a module")}
          </span>
          <button onClick={onCancelPlacement}>Cancel</button>
        </div>
      )}
    </div>
  );
}
