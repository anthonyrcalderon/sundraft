// Mock backend for local dev. Mirrors the shape of the real API Gateway + Lambda
// + DynamoDB backend defined in ../infra — same routes, same request/response
// shapes, so swapping this out later shouldn't require frontend changes.
//
// Storage is just db.json on disk, rewritten on every change. Good enough for
// local dev; not meant to survive a real deploy.

import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "db.json");const SEED_PATH = path.join(__dirname, "db.seed.json");
// ...
if (!fs.existsSync(DB_PATH)) {
  fs.copyFileSync(SEED_PATH, DB_PATH);
  console.log("db.json not found — created from db.seed.json");
}
const PORT = 4000;

const app = express();
app.use(cors());
app.use(express.json());

function readDb() {
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function isAdmin(req) {
  // Placeholder admin check for the mock server only. The real backend will
  // need a real auth story for admin mode — this just unblocks local dev.
  return req.header("x-admin") === "true";
}

function requireSessionId(req, res) {
  const sessionId = req.header("x-session-id");
  if (!sessionId) {
    res.status(400).json({ error: "Missing X-Session-Id header" });
    return null;
  }
  return sessionId;
}

// List projects visible to this session: all templates + this session's own projects
app.get("/api/projects", (req, res) => {
  const sessionId = requireSessionId(req, res);
  if (!sessionId) return;

  const db = readDb();
  const visible = db.projects.filter(
    (p) => p.isTemplate || p.sessionId === sessionId
  );
  res.json(visible);
});

app.get("/api/projects/:id", (req, res) => {
  const db = readDb();
  const project = db.projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  res.json(project);
});

// Create a new blank project owned by this session
app.post("/api/projects", (req, res) => {
  const sessionId = requireSessionId(req, res);
  if (!sessionId) return;

  const db = readDb();
  const now = new Date().toISOString();
  const project = {
    id: nanoid(10),
    sessionId,
    isTemplate: false,
    name: req.body.name || "Untitled design",
    address: req.body.address || null,
    lat: req.body.lat ?? null,
    lng: req.body.lng ?? null,
    roofOutline: null,
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
app.post("/api/projects/:id/fork", (req, res) => {
  const sessionId = requireSessionId(req, res);
  if (!sessionId) return;

  const db = readDb();
  const source = db.projects.find((p) => p.id === req.params.id);
  if (!source) return res.status(404).json({ error: "Not found" });

  const now = new Date().toISOString();
  const forked = {
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
app.put("/api/projects/:id", (req, res) => {
  const sessionId = requireSessionId(req, res);
  if (!sessionId) return;

  const db = readDb();
  const idx = db.projects.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });

  const project = db.projects[idx];
  const admin = isAdmin(req);

  if (project.isTemplate && !admin) {
    return res
      .status(403)
      .json({ error: "Templates are read-only. Fork this project to edit it." });
  }
  if (!project.isTemplate && project.sessionId !== sessionId && !admin) {
    return res.status(403).json({ error: "Not your project" });
  }

  const updated = {
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

app.delete("/api/projects/:id", (req, res) => {
  const sessionId = requireSessionId(req, res);
  if (!sessionId) return;

  const db = readDb();
  const project = db.projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });

  const admin = isAdmin(req);
  if (project.isTemplate && !admin) {
    return res.status(403).json({ error: "Templates cannot be deleted here" });
  }
  if (!project.isTemplate && project.sessionId !== sessionId && !admin) {
    return res.status(403).json({ error: "Not your project" });
  }

  db.projects = db.projects.filter((p) => p.id !== req.params.id);
  writeDb(db);
  res.status(204).end();
});

// Admin-only: create a new template directly (bypasses forking).
app.post("/api/templates", (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Admin only" });

  const db = readDb();
  const now = new Date().toISOString();
  const template = {
    id: nanoid(10),
    sessionId: null,
    isTemplate: true,
    name: req.body.name || "New example",
    address: req.body.address || null,
    lat: req.body.lat ?? null,
    lng: req.body.lng ?? null,
    roofOutline: req.body.roofOutline ?? null,
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
