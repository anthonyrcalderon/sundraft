import { useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import type { AppDispatch, RootState } from "../app/store";
import {
  fetchProjects,
  createBlankProject,
  openProject,
  deleteProject,
} from "../features/projects/projectsSlice";
import type { Project } from "../api/client";
import { DEFAULT_PROJECT_NAME } from "sundraft-shared";

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
    const result = await dispatch(createBlankProject(DEFAULT_PROJECT_NAME)).unwrap();
    onOpen(result);
  }

  function handleDelete(id: string) {
    dispatch(deleteProject(id));
  }

  return (
    <div className="app">
      <div className="brand">
        <img src="/favicon.svg" alt="" className="brand-icon" />
        <h1>
          <span className="brand-sun">Sun</span>
          <span className="brand-draft">Draft</span>
        </h1>
      </div>
      <p className="muted">Pick an example, or start a new design from your own address.</p>

      <button className="primary-button" onClick={handleNewBlank}>
        + New blank project
      </button>

      {status === "loading" && (
        <p className="loading-row">
          <span className="spinner" /> Loading…
        </p>
      )}
      {status === "failed" && (
        <p className="error">
          {import.meta.env.DEV
            ? `${error} — is the mock server running? (\`cd mock-server && npm start\`)`
            : "Couldn't load your projects. Try refreshing the page."}
        </p>
      )}

      <ProjectListSection title="Examples" projects={templates} actionLabel="Clone" onOpen={handleOpen} />
      <ProjectListSection
        title="Your projects"
        projects={myProjects}
        actionLabel="Open"
        onOpen={handleOpen}
        onDelete={handleDelete}
        emptyMessage={
          status === "succeeded"
            ? "You haven't started a design yet — clone an example above, or start a new blank project."
            : undefined
        }
      />
    </div>
  );
}

function ProjectListSection({
  title,
  projects,
  actionLabel,
  onOpen,
  onDelete,
  emptyMessage,
}: {
  title: string;
  projects: Project[];
  actionLabel: string;
  onOpen: (project: Project) => void;
  onDelete?: (id: string) => void;
  emptyMessage?: string;
}) {
  // Deleting a project throws away every roof and module in it with no way
  // back, same stakes as deleting a roof — so it gets the same "are you
  // sure?" confirm step instead of acting immediately.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  if (projects.length === 0) {
    if (!emptyMessage) return null;
    return (
      <section>
        <h2>{title}</h2>
        <p className="muted small empty-state">{emptyMessage}</p>
      </section>
    );
  }

  return (
    <section>
      <h2>{title}</h2>
      <ul className="project-list">
        {projects.map((p) => (
          <li key={p.id}>
            <div className="project-list-row">
              <span>{p.name}</span>
              {onDelete && confirmingDeleteId === p.id ? (
                <span className="project-list-confirm">
                  <span className="muted small">Delete this project?</span>
                  <button
                    className="danger-button"
                    onClick={() => {
                      onDelete(p.id);
                      setConfirmingDeleteId(null);
                    }}
                  >
                    Yes
                  </button>
                  <button onClick={() => setConfirmingDeleteId(null)}>Cancel</button>
                </span>
              ) : (
                <span className="project-list-actions">
                  <button className="primary-button" onClick={() => onOpen(p)}>
                    {actionLabel}
                  </button>
                  {onDelete && (
                    <button className="danger-button" onClick={() => setConfirmingDeleteId(p.id)}>
                      Delete
                    </button>
                  )}
                </span>
              )}
            </div>
            {p.isTemplate && p.screenshotUrl && (
              <img className="project-thumb" src={p.screenshotUrl} alt={`Preview of ${p.name}`} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
