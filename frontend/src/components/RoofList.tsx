import type { Module, ModuleType, Roof } from "sundraft-shared";

interface Props {
  roofs: Roof[];
  modules: Module[];
  moduleTypes: ModuleType[];
  disabled: boolean;
  onDelete: (id: string) => void;
  onFill: (id: string) => void;
}

export default function RoofList({ roofs, modules, moduleTypes, disabled, onDelete, onFill }: Props) {
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
                Roof — {r.tilt}° tilt, {r.azimuth}° azimuth
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
