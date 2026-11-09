import { useEffect, useState } from "react";
import { api, type Project } from "./api/client";
import { isAdminMode } from "./api/adminAuth";
import ProjectPicker from "./components/ProjectPicker";
import AdminPage from "./components/AdminPage";
import OpenedProjectView from "./components/OpenedProjectView";
import "./App.css";

function isAdminPath(pathname: string): boolean {
  return /^\/admin\/?$/.test(pathname);
}

function projectIdFromPath(pathname: string): string | null {
  return pathname.match(/^\/projects\/([^/]+)\/?$/)?.[1] ?? null;
}

// A template should never be opened raw except by an admin — direct-URL
// visits (a saved link, a refresh) otherwise bypass the fork-on-open logic
// that ProjectPicker's "Clone" action normally guarantees. Forking here too
// keeps that guarantee ("editing an example never affects the next visitor")
// true regardless of how a template's URL was reached.
async function resolveProjectForUrl(id: string): Promise<Project> {
  const project = await api.getProject(id);
  if (project.isTemplate && !isAdminMode()) {
    const forked = await api.forkProject(project.id);
    window.history.replaceState(null, "", `/projects/${forked.id}`);
    return forked;
  }
  return project;
}

function App() {
  const [openedProject, setOpenedProject] = useState<Project | null>(null);
  const [onAdminPage, setOnAdminPage] = useState(() => isAdminPath(window.location.pathname));
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
    resolveProjectForUrl(id)
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
      setOnAdminPage(isAdminPath(window.location.pathname));
      const id = projectIdFromPath(window.location.pathname);
      if (!id) {
        setOpenedProject(null);
        return;
      }
      resolveProjectForUrl(id).then(setOpenedProject).catch(() => setOpenedProject(null));
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  function handleOpen(project: Project) {
    window.history.pushState(null, "", `/projects/${project.id}`);
    setOpenedProject(project);
  }

  // An admin who opened a template straight from /admin goes back there;
  // everyone else goes back to the public picker.
  function handleBack() {
    const toAdmin = openedProject?.isTemplate === true && isAdminMode();
    window.history.pushState(null, "", toAdmin ? "/admin" : "/");
    setOnAdminPage(toAdmin);
    setOpenedProject(null);
  }

  function handleExitAdmin() {
    window.history.pushState(null, "", "/");
    setOnAdminPage(false);
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

  if (onAdminPage) {
    return <AdminPage onOpen={handleOpen} onExit={handleExitAdmin} />;
  }

  return <ProjectPicker onOpen={handleOpen} />;
}

export default App;
