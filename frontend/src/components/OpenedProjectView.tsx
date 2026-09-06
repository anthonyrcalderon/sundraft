import { useState } from "react";
import { useDispatch } from "react-redux";
import type { AppDispatch } from "../app/store";
import {
  updateProjectAddress,
  updateProjectName,
  updateProjectRoofs,
  updateProjectModules,
} from "../features/projects/projectsSlice";
import type { Project } from "../api/client";
import { streetAddressFromPlaceName, type GeocodeResult } from "../api/geocoding";
import {
  DEFAULT_MODULE_TYPE,
  DEFAULT_PROJECT_NAME,
  MODULE_TYPES,
  deriveAzimuthFromOutline,
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
  const [name, setName] = useState(project.name);
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
  const [selectedRoofId, setSelectedRoofId] = useState<string | null>(null);
  // Tilt/azimuth determine every module's size and position on a roof (see
  // moduleGeometry's foreshortening/rotation math), so editing them once
  // modules exist would invalidate those modules' geometry with nothing to
  // recompute it — RoofList already refuses to enable Edit in that case.
  // Also folded into `busy` below so starting a new roof trace or module
  // placement mid-edit isn't possible either.
  const [isEditingRoof, setIsEditingRoof] = useState(false);

  const busy = drawing || !!pendingPlacement || isEditingRoof;

  useHotkey("Escape", () => {
    setSelectedModuleIds([]);
    setSelectedRoofId(null);
    // "+ Add module" stays active across placements (see
    // handlePlacementResolved) so it needs its own way out besides the
    // toolbar's Cancel button.
    setPendingPlacement(null);
  });

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
    // Still on the default name (never renamed, and no earlier address
    // already named it) — the address the project is actually about is a
    // far more useful title than a generic placeholder.
    if (name === DEFAULT_PROJECT_NAME) {
      persistName(streetAddressFromPlaceName(result.placeName));
    }
  }

  function persistName(next: string) {
    const trimmed = next.trim();
    if (!trimmed || trimmed === name) return;
    setName(trimmed);
    dispatch(updateProjectName({ id: project.id, name: trimmed }));
  }

  function persistRoofs(next: Roof[]) {
    setRoofs(next);
    dispatch(updateProjectRoofs({ id: project.id, roofs: next }));
  }

  function handleRoofDrawn(outline: GeoJSON.Polygon) {
    const newRoof: Roof = {
      id: crypto.randomUUID(),
      roofOutline: outline,
      // Derived from the outline itself (first edge drawn = bottom/eave
      // edge) until we have real 3D roof-plane data to pull this from.
      azimuth: deriveAzimuthFromOutline(outline),
      tilt: 20, // moderate pitch default
    };
    persistRoofs([...roofs, newRoof]);
    setDrawing(false);
  }

  function handleDeleteRoof(id: string) {
    persistRoofs(roofs.filter((r) => r.id !== id));
    // Modules only make sense attached to a roof — drop any that were on it.
    persistModules(modules.filter((m) => m.roofId !== id));
    // Delete Roof only ever targets the currently-selected roof, so this is
    // always that roof going away — clear its selection/edit state with it.
    setSelectedRoofId(null);
    setIsEditingRoof(false);
  }

  function handleUpdateRoof(id: string, changes: Partial<Pick<Roof, "tilt" | "azimuth">>) {
    persistRoofs(roofs.map((r) => (r.id === id ? { ...r, ...changes } : r)));
  }

  function handleRoofClick(id: string) {
    setSelectedModuleIds([]);
    setSelectedRoofId((prev) => (prev === id ? null : id));
    setIsEditingRoof(false);
  }

  function handleToggleEditRoof() {
    if (!selectedRoofId) return;
    // RoofList already disables the Edit button once the roof has modules,
    // but re-check here too rather than trusting the UI alone.
    if (!isEditingRoof && modules.some((m) => m.roofId === selectedRoofId)) return;
    setIsEditingRoof((prev) => !prev);
  }

  function handleClearRoof(roofId: string) {
    persistModules(modules.filter((m) => m.roofId !== roofId));
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
    setPendingPlacement({ moduleTypeId: DEFAULT_MODULE_TYPE.id, orientation: "portrait" });
  }

  function handleModuleClick(id: string | null, additive: boolean) {
    // Modules and a selected roof are alternate focuses — picking one
    // clears the other, so the two control panels never show at once.
    setSelectedRoofId(null);

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

  function handleRectSelect(_roofId: string, moduleIds: string[]) {
    // Modules and a selected roof are alternate focuses, same as a plain
    // module click — and unlike that click's "always adds," a drag
    // rectangle replaces the selection outright with exactly what it
    // caught (including catching nothing), since it's a single deliberate
    // gesture rather than a series of individual picks to accumulate.
    setSelectedRoofId(null);
    setSelectedModuleIds(moduleIds);
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
    // Placement mode stays active (unlike the one-shot move above) so
    // placing a whole row/grid doesn't mean re-clicking "+ Add module"
    // before every single one — Cancel or Escape is how you leave it.
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

  // Called once a drag-move on the map (see MapView: mousedown on an
  // already-selected module picks the whole selection up) resolves to a
  // valid drop — selection is left alone since the modules were already
  // selected the whole time, never explicitly deselected mid-gesture.
  function handleGroupMoveResolved(results: GroupMoveResult[]) {
    const byId = new Map(results.map((r) => [r.moduleId, r]));
    persistModules(
      modules.map((m) => {
        const r = byId.get(m.id);
        return r ? { ...m, roofId: r.roofId, x: r.x, y: r.y } : m;
      })
    );
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
      <input
        key={name}
        className="project-name-input"
        defaultValue={name}
        onBlur={(e) => persistName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        aria-label="Project name"
      />

      {roofs.length === 0 ? (
        <AddressSearch onSelect={handleAddressSelect} />
      ) : (
        <p className="muted small">
          Address locked once a roof is traced — a project's roofs all need to
          be on the same site.
        </p>
      )}

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
        onRectSelect={handleRectSelect}
        selectedRoofId={selectedRoofId}
        onRoofClick={handleRoofClick}
      />

      {!center && (
        <p className="muted small">
          Search an address above to center the map on it — like your own
          home or work, so you're designing on something familiar.
        </p>
      )}

      <div className="roof-controls">
        <button onClick={() => setDrawing(true)} disabled={busy}>
          + Trace roof outline
        </button>
        <button onClick={handleAddModule} disabled={busy || roofs.length === 0}>
          + Add module
        </button>
      </div>

      {selectedModuleIds.length > 0 && (
        <div className="module-controls">
          <span>
            {selectedModuleIds.length} module{selectedModuleIds.length === 1 ? "" : "s"} selected{" "}
            <span className="muted small">— drag a selected module to move the group</span>
          </span>
          <button onClick={handleRotateSelected} disabled={selectedModuleIds.length !== 1}>
            Rotate ↻
          </button>
          <button onClick={handleDeleteSelected}>Delete</button>
        </div>
      )}

      <RoofList
        roofs={roofs}
        modules={modules}
        moduleTypes={MODULE_TYPES}
        disabled={drawing || !!pendingPlacement}
        selectedRoofId={selectedRoofId}
        onSelectRoof={handleRoofClick}
        isEditingRoof={isEditingRoof}
        onToggleEditRoof={handleToggleEditRoof}
        onDelete={handleDeleteRoof}
        onFill={handleFillRoof}
        onClear={handleClearRoof}
        onUpdate={handleUpdateRoof}
      />
    </div>
  );
}
