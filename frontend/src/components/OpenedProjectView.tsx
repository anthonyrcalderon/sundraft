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
import {
  DEFAULT_MODULE_TYPE,
  MODULE_TYPES,
  fillRoofWithModules,
  type GroupMoveResult,
  type Module,
  type Roof,
} from "sundraft-shared";
import AddressSearch from "./AddressSearch";
import MapView, { type PendingPlacement } from "./MapView";
import RoofList from "./RoofList";
import { useHotkey } from "../hooks/useHotkey";

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
  const [selectedModuleIds, setSelectedModuleIds] = useState<string[]>([]);

  useHotkey("Escape", () => setSelectedModuleIds([]));

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

  function handleFillRoof(roofId: string) {
    const roof = roofs.find((r) => r.id === roofId);
    if (!roof) return;
    const positions = fillRoofWithModules(roof, DEFAULT_MODULE_TYPE, "portrait", modules, MODULE_TYPES);
    const newModules: Module[] = positions.map((p) => ({
      id: crypto.randomUUID(),
      roofId,
      moduleTypeId: DEFAULT_MODULE_TYPE.id,
      x: p.x,
      y: p.y,
      orientation: "portrait",
    }));
    persistModules([...modules, ...newModules]);
  }

  function persistModules(next: Module[]) {
    setModules(next);
    dispatch(updateProjectModules({ id: project.id, modules: next }));
  }

  // arcTODO: Handle snapping. Handle module-to-roof collision (currently only
  // checks that the click point is inside the roof, not the module's full footprint).
  function handleAddModule() {
    setSelectedModuleIds([]);
    setPendingPlacement({ kind: "new", moduleTypeId: DEFAULT_MODULE_TYPE.id, orientation: "portrait" });
  }

  function handleModuleClick(id: string | null, additive: boolean) {
    if (!id) {
      setSelectedModuleIds([]);
      return;
    }

    setSelectedModuleIds((prev) => {
      const alreadySelected = prev.includes(id);

      // Multi-select is the default: a plain click always adds, never
      // replaces or removes. Shift/ctrl/cmd is reserved for removing one
      // already-selected module at a time.
      if (alreadySelected) {
        return additive ? prev.filter((existing) => existing !== id) : prev;
      }

      // A multi-selection only makes sense within one roof — Move/Fill
      // and (eventually) group-rotate all reason about "the roof this
      // selection is on." Clicking a module on a different roof clears
      // the selection instead of adding to it (or doing nothing) — the
      // user gets a clean slate to start selecting on the new roof from.
      //
      // TODO: this is a roof-level grouping; see "Deferred: Subarrays"
      // in docs/PROJECT-OVERVIEW.md for a finer-grained (adjacency-based)
      // grouping within a roof that this restriction would eventually
      // become, once "touching" is actually defined.
      const currentRoofId = prev.length > 0 ? modules.find((m) => m.id === prev[0])?.roofId : undefined;
      const clickedRoofId = modules.find((m) => m.id === id)?.roofId;
      if (currentRoofId && clickedRoofId !== currentRoofId) return [];
      return [...prev, id];
    });
  }

  function handleModuleDoubleClick(roofId: string) {
    setSelectedModuleIds(modules.filter((m) => m.roofId === roofId).map((m) => m.id));
  }

  function handlePlacementResolved(roofId: string, x: number, y: number) {
    const newModule: Module = {
      id: crypto.randomUUID(),
      roofId,
      moduleTypeId: DEFAULT_MODULE_TYPE.id,
      x,
      y,
      orientation: "portrait",
    };
    persistModules([...modules, newModule]);
    setPendingPlacement(null);
  }

  function handleRotateSelected() {
    // Each module rotates around its own center, so rotating a whole grid at
    // once would make neighbors collide — restrict it to a single module
    // until rotation accounts for the rest of the group's layout.
    //
    // TODO: possible future approach — rotate the whole selection together
    // around the group's centroid (avg of all module centers) instead of each
    // module's own center. That avoids neighbor-on-neighbor collisions, but
    // for a rectangular grid on a rectangular roof it tends to swing the
    // outer/"side" modules outside the roof outline, so it'd need a
    // containment check (and probably a way to handle the rejection) before
    // it's actually usable.
    if (selectedModuleIds.length !== 1) return;
    const [id] = selectedModuleIds;
    persistModules(
      modules.map((m) =>
        m.id === id ? { ...m, orientation: m.orientation === "portrait" ? "landscape" : "portrait" } : m
      )
    );
  }

  function handleMoveSelected() {
    if (selectedModuleIds.length === 0) return;
    const moduleIds = selectedModuleIds;
    setSelectedModuleIds([]);
    // Any member works as the anchor — it's just the reference point the
    // translation line and delta are measured from, not special otherwise.
    setPendingPlacement({ kind: "move", moduleIds, anchorModuleId: moduleIds[0] });
  }

  function handleGroupMoveResolved(results: GroupMoveResult[]) {
    const byId = new Map(results.map((r) => [r.moduleId, r]));
    persistModules(
      modules.map((m) => {
        const r = byId.get(m.id);
        return r ? { ...m, roofId: r.roofId, x: r.x, y: r.y } : m;
      })
    );
    setPendingPlacement(null);
  }

  function handleDeleteSelected() {
    if (selectedModuleIds.length === 0) return;
    persistModules(modules.filter((m) => !selectedModuleIds.includes(m.id)));
    setSelectedModuleIds([]);
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
        onGroupMoveResolved={handleGroupMoveResolved}
        onCancelPlacement={() => setPendingPlacement(null)}
        selectedModuleIds={selectedModuleIds}
        onModuleClick={handleModuleClick}
        onModuleDoubleClick={handleModuleDoubleClick}
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

      {selectedModuleIds.length > 0 && (
        <div className="module-controls">
          <span>
            {selectedModuleIds.length} module{selectedModuleIds.length === 1 ? "" : "s"} selected
          </span>
          <button onClick={handleRotateSelected} disabled={selectedModuleIds.length !== 1}>
            Rotate ↻
          </button>
          <button onClick={handleMoveSelected}>Move</button>
          <button onClick={handleDeleteSelected}>Delete</button>
        </div>
      )}

      <RoofList
        roofs={roofs}
        modules={modules}
        moduleTypes={MODULE_TYPES}
        disabled={drawing || !!pendingPlacement}
        onDelete={handleDeleteRoof}
        onFill={handleFillRoof}
      />
    </div>
  );
}
