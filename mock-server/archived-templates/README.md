# Archived example templates

Full JSON exports of example templates that were removed from the live site
but are still worth keeping around — pulled directly from production via
`GET /projects`, matching the exact `Project` shape (see
`packages/shared/src/project.ts`). Not loaded by anything automatically;
this is just cold storage.

To bring one back into local dev, add its object to the `projects` array in
`mock-server/db.seed.json` (and delete `mock-server/db.json` so it
regenerates from the seed). To bring one back onto production, `POST` it to
`/templates` with an `X-Admin: true` header, same as any new template.

- `home-alone-house.json` — "The Home Alone House," 671 Lincoln Ave,
  Winnetka, IL. Removed 2026-09-08 to make room for a single, simpler
  example set while the site only has one real seeded design.
