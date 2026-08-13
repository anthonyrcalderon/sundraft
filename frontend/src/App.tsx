import { useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import type { AppDispatch, RootState } from "./app/store";
import {
  fetchProjects,
  createBlankProject,
  openProject,
} from "./features/projects/projectsSlice";
import type { Project } from "./api/client";
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
    // The map / roof-outline / module-placement canvas is Milestones 2-4.
    // For now, opening a project just confirms the plumbing worked end to end.
    return (
      <div className="app">
        <button className="link" onClick={() => setOpenedProject(null)}>
          ← Back to projects
        </button>
        <h1>{openedProject.name}</h1>
        <p className="muted">
          Project id: {openedProject.id} — owned by session{" "}
          {openedProject.sessionId ?? "(template, unowned)"}
        </p>
        <p className="placeholder">
          The design canvas isn't built yet — this is just confirming that
          creating/opening a project round-trips through the API correctly.
        </p>
      </div>
    );
  }

  return (
    <div className="app">
      <h1>SunDraft</h1>
      <p className="muted">Foundation milestone — project list &amp; persistence plumbing.</p>

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
