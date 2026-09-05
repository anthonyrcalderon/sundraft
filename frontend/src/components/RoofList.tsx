import { useEffect, useState } from "react";
import type { Module, ModuleType, Roof } from "sundraft-shared";

interface Props {
  roofs: Roof[];
  modules: Module[];
  moduleTypes: ModuleType[];
  disabled: boolean;
  selectedRoofId: string | null;
  onSelectRoof: (id: string) => void;
  isEditingRoof: boolean;
  onToggleEditRoof: () => void;
  onDelete: (id: string) => void;
  onFill: (id: string) => void;
  onClear: (id: string) => void;
  onUpdate: (id: string, changes: Partial<Pick<Roof, "tilt" | "azimuth">>) => void;
}

function clampTilt(value: number): number | null {
  if (Number.isNaN(value)) return null;
  return Math.min(90, Math.max(0, value));
}

// Azimuth is a compass bearing — out-of-range input wraps instead of
// clamping (370° is just 10°, not an error).
function normalizeAzimuth(value: number): number | null {
  if (Number.isNaN(value)) return null;
  return ((value % 360) + 360) % 360;
}

// Commits on blur or Enter rather than every keystroke, so editing doesn't
// fire a save on every digit typed. Uncontrolled (defaultValue) — a
// `key` tied to the roof's current value forces React to remount (and
// reset the field) if it changes from outside this input, e.g. after the
// save round-trips or another tab edits the same project.
function RoofNumberField({
  value,
  disabled,
  onCommit,
}: {
  value: number;
  disabled: boolean;
  onCommit: (next: number) => void;
}) {
  return (
    <input
      key={value}
      className="roof-field"
      type="number"
      defaultValue={value}
      disabled={disabled}
      // The field lives inside a clickable roof row (selecting/toggling
      // the roof) — without this, focusing the input to type would bubble
      // up and immediately toggle the roof's selection off.
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => onCommit(Number(e.target.value))}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

export default function RoofList({
  roofs,
  modules,
  moduleTypes,
  disabled,
  selectedRoofId,
  onSelectRoof,
  isEditingRoof,
  onToggleEditRoof,
  onDelete,
  onFill,
  onClear,
  onUpdate,
}: Props) {
  // Deleting a roof is easy to hit by accident, and throws away the traced
  // outline itself (not just its modules) with no quick way back — so it
  // gets a confirm step. Reset whenever the selection or edit state changes
  // so a stale "are you sure?" can't resurface out of context.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => {
    setConfirmingDelete(false);
  }, [selectedRoofId, isEditingRoof]);

  if (roofs.length === 0) return null;

  const selectedRoof = roofs.find((r) => r.id === selectedRoofId) ?? null;
  const selectedRoofModules = selectedRoof ? modules.filter((m) => m.roofId === selectedRoof.id) : [];

  return (
    <section>
      <h2>Roofs ({roofs.length})</h2>
      <ul className="roof-list">
        {roofs.map((r) => {
          const roofModules = modules.filter((m) => m.roofId === r.id);
          const totalWatts = roofModules.reduce((sum, m) => {
            const type = moduleTypes.find((t) => t.id === m.moduleTypeId);
            return sum + (type?.watts ?? 0);
          }, 0);
          const isSelected = r.id === selectedRoofId;
          const showEditFields = isSelected && isEditingRoof;

          return (
            <li
              key={r.id}
              className={isSelected ? "roof-list-item roof-list-item--selected" : "roof-list-item"}
              onClick={() => onSelectRoof(r.id)}
            >
              <span>
                Roof —{" "}
                {showEditFields ? (
                  <>
                    <RoofNumberField
                      value={r.tilt}
                      disabled={disabled}
                      onCommit={(next) => {
                        const tilt = clampTilt(next);
                        if (tilt !== null && tilt !== r.tilt) onUpdate(r.id, { tilt });
                      }}
                    />
                    ° tilt,{" "}
                    <RoofNumberField
                      value={r.azimuth}
                      disabled={disabled}
                      onCommit={(next) => {
                        const azimuth = normalizeAzimuth(next);
                        if (azimuth !== null && azimuth !== r.azimuth) onUpdate(r.id, { azimuth });
                      }}
                    />
                    ° azimuth
                  </>
                ) : (
                  <>
                    {r.tilt}° tilt, {r.azimuth}° azimuth
                  </>
                )}
                {roofModules.length > 0 && (
                  <>
                    {" "}
                    · {roofModules.length} module{roofModules.length === 1 ? "" : "s"} ·{" "}
                    {totalWatts.toLocaleString()} W
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      {selectedRoof && (
        <div className="roof-detail-controls">
          <span className="muted small">Selected roof</span>
          {isEditingRoof ? (
            confirmingDelete ? (
              <>
                <span className="muted small">Delete this roof?</span>
                <button
                  className="danger-button"
                  onClick={() => {
                    onDelete(selectedRoof.id);
                    setConfirmingDelete(false);
                  }}
                >
                  Yes
                </button>
                <button onClick={() => setConfirmingDelete(false)}>Cancel</button>
              </>
            ) : (
              <>
                <button onClick={onToggleEditRoof} disabled={disabled}>
                  Done
                </button>
                <button className="danger-button" onClick={() => setConfirmingDelete(true)} disabled={disabled}>
                  Delete Roof
                </button>
              </>
            )
          ) : (
            <>
              <button onClick={onToggleEditRoof} disabled={disabled || selectedRoofModules.length > 0}>
                Edit
              </button>
              <button onClick={() => onFill(selectedRoof.id)} disabled={disabled}>
                Fill
              </button>
              <button onClick={() => onClear(selectedRoof.id)} disabled={disabled || selectedRoofModules.length === 0}>
                Clear
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
