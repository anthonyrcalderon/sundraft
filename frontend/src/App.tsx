import { useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import type { AppDispatch, RootState } from "./app/store";
import {
  fetchProjects,
  createBlankProject,
  openProject,
  updateProjectAddress,
} from "./features/projects/projectsSlice";
import type { Project } from "./api/client";
import type { GeocodeResult } from "./api/geocoding";
import AddressSearch from "./components/AddressSearch";
import MapView from "./components/MapView";
import "./App.css";

function App() {
  const dispatch = useDispatch<AppDispatch>();
  const { items, status, error } = useSelector((s: RootState) => s.projects);
  const [openedProject, setOpenedProject] = useState<Project | null>(null);

  useEffect(() => {
    dispatch(fetchProjects());
  }, [dispatch]);

  const templates = items.filter((p) => p.isTemplate);
  const myProjects = items.filter((p) => !p.isTemplate);

  async function handleOpen(project: Project) {
    const result = await dispatch(openProject(project)).unwrap();
    setOpenedProject(result);
  }

  async function handleNewBlank() {
    const result = await dispatch(
      createBlankProject("Untitled design")
    ).unwrap();
    setOpenedProject(result);
  }

  if (openedProject) {
    return (
      <OpenedProjectView
        project={openedProject}
        onBack={() => setOpenedProject(null)}
      />
    );
  }

  return (
    <div className="app">
      <h1>SunDraft</h1>
      <p className="muted">Pick an example, or start a new design from your own address.</p>

      <button onClick={handleNewBlank}>+ New blank project</button>

      {status === "loading" && <p>Loading…</p>}
      {status === "failed" && (
        <p className="error">
          {error} — is the mock server running? (`cd mock-server && npm start`)
        </p>
      )}

      {templates.length > 0 && (
        <section>
          <h2>Examples</h2>
          <ul className="project-list">
            {templates.map((p) => (
              <li key={p.id}>
                <span>{p.name}</span>
                <button onClick={() => handleOpen(p)}>Open</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {myProjects.length > 0 && (
        <section>
          <h2>Your projects</h2>
          <ul className="project-list">
            {myProjects.map((p) => (
              <li key={p.id}>
                <span>{p.name}</span>
                <button onClick={() => handleOpen(p)}>Open</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export default App;

function OpenedProjectView({
  project,
  onBack,
}: {
  project: Project;
  onBack: () => void;
}) {
  const dispatch = useDispatch<AppDispatch>();
  const [center, setCenter] = useState<{ lng: number; lat: number } | null>(
    project.lat != null && project.lng != null
      ? { lat: project.lat, lng: project.lng }
      : null
  );

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

  return (
    <div className="app app--wide">
      <button className="link" onClick={onBack}>
        ← Back to projects
      </button>
      <h1>{project.name}</h1>

      <AddressSearch onSelect={handleAddressSelect} />

      <MapView center={center} />

      {!center && (
        <p className="muted small">
          Search an address above to center the map on it — like your own
          home or work, so you're designing on something familiar. Roof
          tracing and module placement land in the next milestone.
        </p>
      )}
    </div>
  );
}
