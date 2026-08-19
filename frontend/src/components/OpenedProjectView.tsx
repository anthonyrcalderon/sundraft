import { useState } from "react";
import { useDispatch } from "react-redux";
import type { AppDispatch } from "../app/store";
import {
  updateProjectAddress,
  updateProjectRoofs,
} from "../features/projects/projectsSlice";
import type { Project } from "../api/client";
import type { GeocodeResult } from "../api/geocoding";
import type { Roof } from "sundraft-shared";
import AddressSearch from "./AddressSearch";
import MapView from "./MapView";
import RoofList from "./RoofList";

interface Props {
  project: Project;
  onBack: () => void;
}

export default function OpenedProjectView({ project, onBack }: Props) {
  const dispatch = useDispatch<AppDispatch>();
  const [center, setCenter] = useState<{ lng: number; lat: number } | null>(
    project.lat != null && project.lng != null
      ? { lat: project.lat, lng: project.lng }
      : null
  );
  const [roofs, setRoofs] = useState<Roof[]>(project.roofs);
  const [drawing, setDrawing] = useState(false);

  async function handleAddressSelect(result: GeocodeResult) {
    setCenter({ lng: result.lng, lat: result.lat });
    await dispatch(
      updateProjectAddress({
        id: project.id,
        address: result.placeName,
        lat: result.lat,
        lng: result.lng,
      })
    );
  }

  function persistRoofs(next: Roof[]) {
    setRoofs(next);
    dispatch(updateProjectRoofs({ id: project.id, roofs: next }));
  }

  function handleRoofDrawn(outline: GeoJSON.Polygon) {
    const newRoof: Roof = {
      id: crypto.randomUUID(),
      roofOutline: outline,
      azimuth: 180, // south-facing default — editing per-roof lands later
      tilt: 20, // moderate pitch default
    };
    persistRoofs([...roofs, newRoof]);
    setDrawing(false);
  }

  function handleDeleteRoof(id: string) {
    persistRoofs(roofs.filter((r) => r.id !== id));
  }

  return (
    <div className="app app--wide">
      <button className="link" onClick={onBack}>
        ← Back to projects
      </button>
      <h1>{project.name}</h1>

      <AddressSearch onSelect={handleAddressSelect} />

      <MapView
        center={center}
        roofs={roofs}
        drawing={drawing}
        onRoofDrawn={handleRoofDrawn}
        onCancelDrawing={() => setDrawing(false)}
      />

      {!center && (
        <p className="muted small">
          Search an address above to center the map on it — like your own
          home or work, so you're designing on something familiar.
        </p>
      )}

      <div className="roof-controls">
        <button onClick={() => setDrawing(true)} disabled={drawing}>
          + Trace roof outline
        </button>
      </div>

      <RoofList roofs={roofs} onDelete={handleDeleteRoof} />
    </div>
  );
}
