import { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import type { AppDispatch, RootState } from "../app/store";
import {
  fetchProjects,
  createBlankProject,
  openProject,
} from "../features/projects/projectsSlice";
import type { Project } from "../api/client";

interface Props {
  onOpen: (project: Project) => void;
}

export default function ProjectPicker({ onOpen }: Props) {
  const dispatch = useDispatch<AppDispatch>();
  const { items, status, error } = useSelector((s: RootState) => s.projects);

  useEffect(() => {
    dispatch(fetchProjects());
  }, [dispatch]);

  const templates = items.filter((p) => p.isTemplate);
  const myProjects = items.filter((p) => !p.isTemplate);

  async function handleOpen(project: Project) {
    const result = await dispatch(openProject(project)).unwrap();
    onOpen(result);
  }

  async function handleNewBlank() {
    const result = await dispatch(
      createBlankProject("Untitled design")
    ).unwrap();
    onOpen(result);
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

      <ProjectListSection title="Examples" projects={templates} onOpen={handleOpen} />
      <ProjectListSection title="Your projects" projects={myProjects} onOpen={handleOpen} />
    </div>
  );
}

function ProjectListSection({
  title,
  projects,
  onOpen,
}: {
  title: string;
  projects: Project[];
  onOpen: (project: Project) => void;
}) {
  if (projects.length === 0) return null;

  return (
    <section>
      <h2>{title}</h2>
      <ul className="project-list">
        {projects.map((p) => (
          <li key={p.id}>
            <span>{p.name}</span>
            <button onClick={() => onOpen(p)}>Open</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
