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
  metersToLngLat,
  moduleRing,
  overlapsExisting,
  resolveGroupMove,
  roofOrigin,
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
      attribution:
        "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    },
  },
  layers: [{ id: "esri-world-imagery", type: "raster", source: "esri" }],
};

const DEFAULT_CENTER: [number, number] = [-98.5795, 39.8283]; // center of the continental US
const DEFAULT_ZOOM = 3.5;
const ADDRESS_ZOOM = 19; // close enough to make out individual roofs

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
  const origin = roof && roofOrigin(roof);
  if (!m || !origin) return null;
  return metersToLngLat(origin, m.x, m.y);
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

  // Track the cursor while a group move is pending, to drive the
  // translation-preview line below.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || pendingPlacement?.kind !== "move") {
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
  }, [pendingPlacement]);

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
        setDraftPoints((prev) => {
          const last = prev[prev.length - 1];
          // A duplicate point (e.g. an accidental double-click) creates a
          // zero-length edge that gets traced twice — that silently breaks
          // ray-casting containment checks later, since every real crossing
          // along it gets counted twice and cancels itself out. Skip it.
          if (last && last[0] === e.lngLat.lng && last[1] === e.lngLat.lat) return prev;
          return [...prev, [e.lngLat.lng, e.lngLat.lat]];
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
        const origin = roofOrigin(roof);
        if (!origin) return;
        const { x, y } = lngLatToMeters(origin, { lng: point[0], lat: point[1] });
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
  ]);

  // Render the in-progress trace (line between placed points + point markers).
  useEffect(() => {
    if (!mapRef.current || !styleLoaded) return;
    const lineSource = mapRef.current.getSource(
      DRAFT_LINE_SOURCE_ID
    ) as maplibregl.GeoJSONSource;
    const pointsSource = mapRef.current.getSource(
      DRAFT_POINTS_SOURCE_ID
    ) as maplibregl.GeoJSONSource;

    lineSource?.setData(
      draftPoints.length >= 2
        ? {
            type: "FeatureCollection",
            features: [
              { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: draftPoints } },
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
  }, [draftPoints, styleLoaded]);

  function handleFinish() {
    if (draftPoints.length < 3) return;
    const ring = [...draftPoints, draftPoints[0]]; // GeoJSON polygons must close
    onRoofDrawn({ type: "Polygon", coordinates: [ring] });
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
