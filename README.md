# SunDraft

Residential solar design tool — pull up a map, trace a roof outline, place solar modules.
Portfolio project. See [`docs/PROJECT-OVERVIEW.md`](docs/PROJECT-OVERVIEW.md) for
full vision, scope, and milestone plan.

## Repo layout

```
sundraft/
├── frontend/     React + Redux Toolkit + TypeScript (Vite). The actual app.
├── mock-server/  Express + JSON "fake backend" for local dev — no AWS needed yet.
└── infra/        AWS CDK app: DynamoDB table, Lambda handlers, HTTP API Gateway.
                  Not deployed yet — this is Milestone 1 scaffolding only.
```

## Foundation milestone — what's here right now

This is Milestone 1 from the project outline: a runnable local dev loop against a
mock backend, plus a CDK stack ready to deploy later. It does **not** yet include the
map, the roof-outline tool, or the module-placement tool — those are Milestones 2–4.

## Getting this running locally

You'll need Node.js installed (18+ recommended). This scaffold was written without
network access, so nothing has been `npm install`-ed yet — that's the first thing to run.

```bash
# 1. Start the mock backend (fake API + seeded example projects)
cd mock-server
npm install
npm start
# → running at http://localhost:4000

# 2. In a second terminal, start the frontend
cd frontend
npm install
npm run dev
# → running at http://localhost:5173
```

Open http://localhost:5173 — you should see a project list pulled from the mock
server, including the 2 seeded example ("template") projects.

## The AWS side (not needed yet)

`infra/` is a CDK app defining the real backend (DynamoDB + Lambda + HTTP API) that
will eventually replace `mock-server/`. It's written and ready, but deploying it
requires an AWS account and the CDK CLI configured with your credentials — that's a
manual step for you to do when we get there, not something this sandbox can do on
its own. Until then, keep developing against `mock-server`.

When you're ready to deploy it:

```bash
cd infra
npm install
npx cdk bootstrap   # one-time per AWS account/region
npx cdk deploy
```

## Data model

A `Project` looks like this everywhere (mock server, DynamoDB, frontend types):

```ts
{
  id: string;
  sessionId: string;      // anonymous session that owns this project
  isTemplate: boolean;    // true = one of the 2-3 read-only examples
  name: string;
  address?: string;
  roofOutline: GeoJSON.Polygon | null;
  modules: Array<{ id: string; x: number; y: number; width: number; height: number; rotation: number }>;
  createdAt: string;
  updatedAt: string;
}
```

Opening a template forks it into a brand-new project owned by your session — the
original template is never modified. That fork happens in the API layer (mock
server today, Lambda later), not in the frontend, so the rule holds no matter what
client calls it.
