import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { api, type Project } from "../../api/client";

interface ProjectsState {
  items: Project[];
  status: "idle" | "loading" | "succeeded" | "failed";
  error: string | null;
}

const initialState: ProjectsState = {
  items: [],
  status: "idle",
  error: null,
};

export const fetchProjects = createAsyncThunk("projects/fetchAll", () =>
  api.listProjects()
);

export const createBlankProject = createAsyncThunk(
  "projects/createBlank",
  (name: string) => api.createProject({ name })
);

// Opening a template always forks it — this is the one rule the whole demo
// depends on, so it lives here rather than being left to call sites.
export const openProject = createAsyncThunk(
  "projects/open",
  async (project: Project) => {
    if (project.isTemplate) {
      return api.forkProject(project.id);
    }
    return project;
  }
);

export const updateProjectAddress = createAsyncThunk(
  "projects/updateAddress",
  (args: { id: string; address: string; lat: number; lng: number }) =>
    api.updateProject(args.id, {
      address: args.address,
      lat: args.lat,
      lng: args.lng,
    })
);

const projectsSlice = createSlice({
  name: "projects",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchProjects.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(
        fetchProjects.fulfilled,
        (state, action: PayloadAction<Project[]>) => {
          state.status = "succeeded";
          state.items = action.payload;
        }
      )
      .addCase(fetchProjects.rejected, (state, action) => {
        state.status = "failed";
        state.error = action.error.message ?? "Failed to load projects";
      })
      .addCase(createBlankProject.fulfilled, (state, action) => {
        state.items.push(action.payload);
      })
      .addCase(openProject.fulfilled, (state, action) => {
        // A fork produces a brand-new project; make sure it's in the list too.
        if (!state.items.some((p) => p.id === action.payload.id)) {
          state.items.push(action.payload);
        }
      })
      .addCase(updateProjectAddress.fulfilled, (state, action) => {
        const idx = state.items.findIndex((p) => p.id === action.payload.id);
        if (idx !== -1) state.items[idx] = action.payload;
      });
  },
});

export default projectsSlice.reducer;
