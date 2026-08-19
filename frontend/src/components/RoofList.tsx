import type { Roof } from "sundraft-shared";

interface Props {
  roofs: Roof[];
  onDelete: (id: string) => void;
}

export default function RoofList({ roofs, onDelete }: Props) {
  if (roofs.length === 0) return null;

  return (
    <section>
      <h2>Roofs ({roofs.length})</h2>
      <ul className="roof-list">
        {roofs.map((r) => (
          <li key={r.id}>
            <span>
              Roof — {r.tilt}° tilt, {r.azimuth}° azimuth
            </span>
            <button className="link" onClick={() => onDelete(r.id)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
      <p className="muted small">
        Module placement onto these roofs lands in the next milestone.
      </p>
    </section>
  );
}
