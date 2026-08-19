import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Roof } from "sundraft-shared";

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

const emptyFC = (): GeoJSON.FeatureCollection => ({
  type: "FeatureCollection",
  features: [],
});

interface Props {
  center: { lng: number; lat: number } | null;
  roofs: Roof[];
  drawing: boolean;
  onRoofDrawn: (outline: GeoJSON.Polygon) => void;
  onCancelDrawing: () => void;
}

export default function MapView({
  center,
  roofs,
  drawing,
  onRoofDrawn,
  onCancelDrawing,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [styleLoaded, setStyleLoaded] = useState(false);
  const [draftPoints, setDraftPoints] = useState<[number, number][]>([]);

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

  // Draw-mode click handling: each click appends a vertex.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    map.getCanvas().style.cursor = drawing ? "crosshair" : "";
    if (!drawing) return;

    function handleClick(e: maplibregl.MapMouseEvent) {
      setDraftPoints((prev) => [...prev, [e.lngLat.lng, e.lngLat.lat]]);
    }
    map.on("click", handleClick);
    return () => {
      map.off("click", handleClick);
    };
  }, [drawing]);

  // Reset the in-progress trace whenever draw mode turns off (finished or cancelled).
  useEffect(() => {
    if (!drawing) setDraftPoints([]);
  }, [drawing]);

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
    </div>
  );
}
