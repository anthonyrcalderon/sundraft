import type { Module, ModuleType, Roof } from "sundraft-shared";

interface Props {
  roofs: Roof[];
  modules: Module[];
  moduleTypes: ModuleType[];
  disabled: boolean;
  onDelete: (id: string) => void;
  onFill: (id: string) => void;
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
      onBlur={(e) => onCommit(Number(e.target.value))}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

export default function RoofList({ roofs, modules, moduleTypes, disabled, onDelete, onFill, onUpdate }: Props) {
  if (roofs.length === 0) return null;

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

          return (
            <li key={r.id}>
              <span>
                Roof —{" "}
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
                {roofModules.length > 0 && (
                  <>
                    {" "}
                    · {roofModules.length} module{roofModules.length === 1 ? "" : "s"} ·{" "}
                    {totalWatts.toLocaleString()} W
                  </>
                )}
              </span>
              <span>
                <button onClick={() => onFill(r.id)} disabled={disabled}>
                  Fill
                </button>
                <button onClick={() => onDelete(r.id)} disabled={disabled}>
                  Delete
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
