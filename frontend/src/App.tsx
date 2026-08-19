import { useState } from "react";
import type { Project } from "./api/client";
import ProjectPicker from "./components/ProjectPicker";
import OpenedProjectView from "./components/OpenedProjectView";
import "./App.css";

function App() {
  const [openedProject, setOpenedProject] = useState<Project | null>(null);

  if (openedProject) {
    return (
      <OpenedProjectView
        project={openedProject}
        onBack={() => setOpenedProject(null)}
      />
    );
  }

  return <ProjectPicker onOpen={setOpenedProject} />;
}

export default App;
