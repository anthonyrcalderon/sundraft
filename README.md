# SunDraft

Residential solar design tool — pull up a map, trace a roof outline, place solar modules.
Portfolio project. See [`docs/PROJECT-OVERVIEW.md`](docs/PROJECT-OVERVIEW.md) for
full vision, scope, and milestone plan.

## Repo layout

```
sundraft/
├── packages/
│   └── shared/   Shared domain types (Project, etc.) — the one place these
│                 are defined. frontend/mock-server/infra all import from here.
├── frontend/     React + Redux Toolkit + TypeScript (Vite). The actual app.
├── mock-server/  Express + JSON "fake backend" for local dev — no AWS needed yet.
└── infra/        AWS CDK app: DynamoDB table, Lambda handlers, HTTP API Gateway.
                  Not deployed yet — this is Milestone 1 scaffolding only.
```

This is an npm workspace — `frontend`, `mock-server`, `infra`, and `packages/shared`
are all workspace members declared in the root `package.json`. That means a single
`npm install` at the repo root installs everything for every sub-project at once;
you don't need to `cd` into each one separately anymore.

## Foundation + Milestone 2 — what's here right now

This includes Milestone 1 (project list, persistence, template fork-on-open)
and Milestone 2 (map + address search) from the project outline. It does
**not** yet include the roof-outline tool or module-placement tool — those
are Milestones 3–4.

## Getting this running locally

You'll need Node.js installed (18+ recommended), and a free Mapbox token
(sign up at https://account.mapbox.com/ — no card required for the free
tier: 50,000 map loads + 100,000 geocoding requests/month).

```bash
# 1. Install everything, once, from the repo root
npm install

# 2. Set up the frontend's env file
cd frontend
cp .env.example .env.local
# edit .env.local and paste your Mapbox token into VITE_MAPBOX_TOKEN
cd ..

# 3. Start the mock backend (fake API + seeded example projects)
cd mock-server && npm start
# → running at http://localhost:4000

# 4. In a second terminal, start the frontend
cd frontend && npm run dev
# → running at http://localhost:5173
```

Open http://localhost:5173 — you should see a project list pulled from the
mock server, including the 2 seeded example ("template") projects. Open any
project and search an address to see the map center on it.

**Resetting your local data:** `mock-server/db.json` is where your local
projects actually live, and it's gitignored since it changes constantly.
`mock-server/db.seed.json` is the committed starting point (just the 2
templates). If you ever want a clean slate, delete `db.json` and restart the
mock server — it recreates `db.json` from the seed automatically.

## The AWS side (not needed yet)

`infra/` is a CDK app defining the real backend (DynamoDB + Lambda + HTTP API) that
will eventually replace `mock-server/`. It's written and ready, but deploying it
requires an AWS account and the CDK CLI configured with your credentials — that's a
manual step for you to do when we get there, not something this sandbox can do on
its own. Until then, keep developing against `mock-server`.

When you're ready to deploy it:

```bash
cd infra
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
