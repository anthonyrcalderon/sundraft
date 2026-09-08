import { useEffect, useState } from "react";
import { api, type Project } from "./api/client";
import ProjectPicker from "./components/ProjectPicker";
import OpenedProjectView from "./components/OpenedProjectView";
import "./App.css";

function projectIdFromPath(pathname: string): string | null {
  return pathname.match(/^\/projects\/([^/]+)\/?$/)?.[1] ?? null;
}

function App() {
  const [openedProject, setOpenedProject] = useState<Project | null>(null);
  // Only matters for the very first render — whether that's a deep link (a
  // direct visit, or a refresh while a project was open) that needs its
  // project fetched before anything can render.
  const [loading, setLoading] = useState(() => projectIdFromPath(window.location.pathname) !== null);

  // The URL, not in-memory state, is the source of truth for which project
  // is open — state alone would forget it on every refresh, sending a
  // refresh back to the picker instead of the project you were just on.
  useEffect(() => {
    const id = projectIdFromPath(window.location.pathname);
    if (!id) return;
    api
      .getProject(id)
      .then(setOpenedProject)
      .catch(() => {
        // Gone, or the link was bad — fall back to the picker rather than
        // getting stuck on a project that can't load.
        window.history.replaceState(null, "", "/");
      })
      .finally(() => setLoading(false));
  }, []);

  // Follow the browser's own back/forward between the picker and a project.
  useEffect(() => {
    function handlePopState() {
      const id = projectIdFromPath(window.location.pathname);
      if (!id) {
        setOpenedProject(null);
        return;
      }
      api.getProject(id).then(setOpenedProject).catch(() => setOpenedProject(null));
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  function handleOpen(project: Project) {
    window.history.pushState(null, "", `/projects/${project.id}`);
    setOpenedProject(project);
  }

  function handleBack() {
    window.history.pushState(null, "", "/");
    setOpenedProject(null);
  }

  if (loading) {
    return (
      <div className="app app--centered">
        <span className="spinner spinner--large" />
      </div>
    );
  }

  if (openedProject) {
    return <OpenedProjectView project={openedProject} onBack={handleBack} />;
  }

  return <ProjectPicker onOpen={handleOpen} />;
}

export default App;
