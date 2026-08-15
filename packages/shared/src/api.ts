import type { Project } from "./project";

// What the client sends to create a blank project — a subset of Project,
// since fields like id/sessionId/isTemplate/timestamps are server-assigned.
export type CreateProjectInput = Pick<Project, "name"> &
  Partial<Pick<Project, "address" | "lat" | "lng">>;

// What the client can send to update an existing project. Derived with
// Omit/Partial from Project rather than hand-written, so adding a field to
// Project automatically becomes editable here too, with no separate type
// to remember to update.
export type UpdateProjectInput = Partial<
  Omit<Project, "id" | "sessionId" | "isTemplate" | "createdAt" | "updatedAt">
>;
