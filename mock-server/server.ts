// Mock backend for local dev. Mirrors the shape of the real API Gateway + Lambda
// + DynamoDB backend defined in ../infra — same routes, same request/response
// shapes, so swapping this out later shouldn't require frontend changes.
//
// Storage is just db.json on disk, rewritten on every change. Good enough for
// local dev; not meant to survive a real deploy.

import express, { type Request, type Response } from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Project } from "sundraft-shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "db.json");
const SEED_PATH = path.join(__dirname, "db.seed.json");
const PORT = 4000;

// db.json is generated, not committed — it's your local mutable state and
// changes every time you add/edit a project. db.seed.json is the committed
// source of truth for the starting templates. If db.json doesn't exist yet
// (fresh clone, or you deleted it to reset your local data), recreate it
// from the seed automatically.
if (!fs.existsSync(DB_PATH)) {
  fs.copyFileSync(SEED_PATH, DB_PATH);
  console.log("db.json not found — created from db.seed.json");
}

interface Db {
  projects: Project[];
}

const app = express();
app.use(cors());
app.use(express.json());

function readDb(): Db {
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function writeDb(db: Db): void {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function isAdmin(req: Request): boolean {
  // Placeholder admin check for the mock server only. The real backend will
  // need a real auth story for admin mode — this just unblocks local dev.
  return req.header("x-admin") === "true";
}

function requireSessionId(req: Request, res: Response): string | null {
  const sessionId = req.header("x-session-id");
  if (!sessionId) {
    res.status(400).json({ error: "Missing X-Session-Id header" });
    return null;
  }
  return sessionId;
}

// List projects visible to this session: all templates + this session's own projects
app.get("/api/projects", (req: Request, res: Response) => {
  const sessionId = requireSessionId(req, res);
  if (!sessionId) return;

  const db = readDb();
  const visible = db.projects.filter(
    (p) => p.isTemplate || p.sessionId === sessionId
  );
  res.json(visible);
});

app.get("/api/projects/:id", (req: Request, res: Response) => {
  const db = readDb();
  const project = db.projects.find((p) => p.id === req.params.id);
  if (!project) return void res.status(404).json({ error: "Not found" });
  res.json(project);
});

// Create a new blank project owned by this session
app.post("/api/projects", (req: Request, res: Response) => {
  const sessionId = requireSessionId(req, res);
  if (!sessionId) return;

  const db = readDb();
  const now = new Date().toISOString();
  const project: Project = {
    id: nanoid(10),
    sessionId,
    isTemplate: false,
    name: req.body.name || "Untitled design",
    address: req.body.address || null,
    lat: req.body.lat ?? null,
    lng: req.body.lng ?? null,
    roofs: [],
    modules: [],
    createdAt: now,
    updatedAt: now,
  };
  db.projects.push(project);
  writeDb(db);
  res.status(201).json(project);
});

// Fork a template into a new project owned by this session.
// This is the one rule that matters for the demo: opening a template never
// edits the shared original, it always creates a private copy.
app.post("/api/projects/:id/fork", (req: Request, res: Response) => {
  const sessionId = requireSessionId(req, res);
  if (!sessionId) return;

  const db = readDb();
  const source = db.projects.find((p) => p.id === req.params.id);
  if (!source) return void res.status(404).json({ error: "Not found" });

  const now = new Date().toISOString();
  const forked: Project = {
    ...structuredClone(source),
    id: nanoid(10),
    sessionId,
    isTemplate: false,
    name: source.name.replace(/^Example:\s*/, ""),
    createdAt: now,
    updatedAt: now,
  };
  db.projects.push(forked);
  writeDb(db);
  res.status(201).json(forked);
});

// Update a project. Regular users can only update their own, non-template
// projects. Admins can update anything, including templates directly.
app.put("/api/projects/:id", (req: Request, res: Response) => {
  const sessionId = requireSessionId(req, res);
  if (!sessionId) return;

  const db = readDb();
  const idx = db.projects.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return void res.status(404).json({ error: "Not found" });

  const project = db.projects[idx];
  const admin = isAdmin(req);

  if (project.isTemplate && !admin) {
    return void res
      .status(403)
      .json({ error: "Templates are read-only. Fork this project to edit it." });
  }
  if (!project.isTemplate && project.sessionId !== sessionId && !admin) {
    return void res.status(403).json({ error: "Not your project" });
  }

  const updated: Project = {
    ...project,
    ...req.body,
    id: project.id, // never allow overwriting these via body
    sessionId: project.sessionId,
    isTemplate: project.isTemplate,
    updatedAt: new Date().toISOString(),
  };
  db.projects[idx] = updated;
  writeDb(db);
  res.json(updated);
});

app.delete("/api/projects/:id", (req: Request, res: Response) => {
  const sessionId = requireSessionId(req, res);
  if (!sessionId) return;

  const db = readDb();
  const project = db.projects.find((p) => p.id === req.params.id);
  if (!project) return void res.status(404).json({ error: "Not found" });

  const admin = isAdmin(req);
  if (project.isTemplate && !admin) {
    return void res.status(403).json({ error: "Templates cannot be deleted here" });
  }
  if (!project.isTemplate && project.sessionId !== sessionId && !admin) {
    return void res.status(403).json({ error: "Not your project" });
  }

  db.projects = db.projects.filter((p) => p.id !== req.params.id);
  writeDb(db);
  res.status(204).end();
});

// Admin-only: create a new template directly (bypasses forking).
app.post("/api/templates", (req: Request, res: Response) => {
  if (!isAdmin(req)) return void res.status(403).json({ error: "Admin only" });

  const db = readDb();
  const now = new Date().toISOString();
  const template: Project = {
    id: nanoid(10),
    sessionId: null,
    isTemplate: true,
    name: req.body.name || "New example",
    address: req.body.address || null,
    lat: req.body.lat ?? null,
    lng: req.body.lng ?? null,
    roofs: req.body.roofs ?? [],
    modules: req.body.modules ?? [],
    createdAt: now,
    updatedAt: now,
  };
  db.projects.push(template);
  writeDb(db);
  res.status(201).json(template);
});

app.listen(PORT, () => {
  console.log(`SunDraft mock server running at http://localhost:${PORT}`);
});
