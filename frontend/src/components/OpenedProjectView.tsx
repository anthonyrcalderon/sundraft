import { useState } from "react";
import { useDispatch } from "react-redux";
import type { AppDispatch } from "../app/store";
import {
  updateProjectAddress,
  updateProjectRoofs,
  updateProjectModules,
} from "../features/projects/projectsSlice";
import type { Project } from "../api/client";
import type { GeocodeResult } from "../api/geocoding";
import { DEFAULT_MODULE_TYPE, MODULE_TYPES, type Module, type Roof } from "sundraft-shared";
import AddressSearch from "./AddressSearch";
import MapView, { type PendingPlacement } from "./MapView";
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

  const [modules, setModules] = useState<Module[]>(project.modules);
  const [pendingPlacement, setPendingPlacement] = useState<PendingPlacement | null>(null);
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);

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
    // Modules only make sense attached to a roof — drop any that were on it.
    persistModules(modules.filter((m) => m.roofId !== id));
  }

  function persistModules(next: Module[]) {
    setModules(next);
    dispatch(updateProjectModules({ id: project.id, modules: next }));
  }

  function handleAddModule() {
    setSelectedModuleId(null);
    setPendingPlacement({ moduleTypeId: DEFAULT_MODULE_TYPE.id, orientation: "portrait" });
  }

  function handlePlacementResolved(roofId: string, x: number, y: number) {
    if (pendingPlacement?.excludeModuleId) {
      const movingId = pendingPlacement.excludeModuleId;
      persistModules(
        modules.map((m) => (m.id === movingId ? { ...m, roofId, x, y } : m))
      );
    } else {
      const newModule: Module = {
        id: crypto.randomUUID(),
        roofId,
        moduleTypeId: DEFAULT_MODULE_TYPE.id,
        x,
        y,
        orientation: "portrait",
      };
      persistModules([...modules, newModule]);
    }
    setPendingPlacement(null);
  }

  function handleRotateSelected() {
    if (!selectedModuleId) return;
    persistModules(
      modules.map((m) =>
        m.id === selectedModuleId
          ? { ...m, orientation: m.orientation === "portrait" ? "landscape" : "portrait" }
          : m
      )
    );
  }

  function handleMoveSelected() {
    const selected = modules.find((m) => m.id === selectedModuleId);
    if (!selected) return;
    setSelectedModuleId(null);
    setPendingPlacement({
      moduleTypeId: selected.moduleTypeId,
      orientation: selected.orientation,
      excludeModuleId: selected.id,
    });
  }

  function handleDeleteSelected() {
    if (!selectedModuleId) return;
    persistModules(modules.filter((m) => m.id !== selectedModuleId));
    setSelectedModuleId(null);
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
        modules={modules}
        moduleTypes={MODULE_TYPES}
        pendingPlacement={pendingPlacement}
        onPlacementResolved={handlePlacementResolved}
        onCancelPlacement={() => setPendingPlacement(null)}
        selectedModuleId={selectedModuleId}
        onSelectModule={setSelectedModuleId}
      />

      {!center && (
        <p className="muted small">
          Search an address above to center the map on it — like your own
          home or work, so you're designing on something familiar.
        </p>
      )}

      <div className="roof-controls">
        <button onClick={() => setDrawing(true)} disabled={drawing || !!pendingPlacement}>
          + Trace roof outline
        </button>
        <button
          onClick={handleAddModule}
          disabled={drawing || !!pendingPlacement || roofs.length === 0}
        >
          + Add module
        </button>
      </div>

      {selectedModuleId && (
        <div className="module-controls">
          <span>Module selected</span>
          <button onClick={handleRotateSelected}>Rotate ↻</button>
          <button onClick={handleMoveSelected}>Move</button>
          <button className="link" onClick={handleDeleteSelected}>
            Delete
          </button>
        </div>
      )}

      <RoofList roofs={roofs} modules={modules} moduleTypes={MODULE_TYPES} onDelete={handleDeleteRoof} />
    </div>
  );
}
