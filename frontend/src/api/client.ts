// Talks to the mock-server today; will point at API Gateway once infra/ is
// deployed. Only this file needs to change when that happens.

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000/api";

const SESSION_STORAGE_KEY = "sundraft_session_id";

// Anonymous session id, created once per browser and reused forever after.
// This is the entire "auth" model for the MVP — no login, no email.
export function getSessionId(): string {
  let sessionId = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  }
  return sessionId;
}

export interface Project {
  id: string;
  sessionId: string | null;
  isTemplate: boolean;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  roofOutline: GeoJSON.Polygon | null;
  modules: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
  }>;
  createdAt: string;
  updatedAt: string;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": getSessionId(),
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  listProjects: () => request<Project[]>("/projects"),
  getProject: (id: string) => request<Project>(`/projects/${id}`),
  createProject: (data: Partial<Project>) =>
    request<Project>("/projects", { method: "POST", body: JSON.stringify(data) }),
  forkProject: (id: string) =>
    request<Project>(`/projects/${id}/fork`, { method: "POST" }),
  updateProject: (id: string, data: Partial<Project>) =>
    request<Project>(`/projects/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteProject: (id: string) =>
    request<void>(`/projects/${id}`, { method: "DELETE" }),
};
