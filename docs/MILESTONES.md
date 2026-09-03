# SunDraft — Milestones

The high-level work outline for the MVP, broken into concrete milestones. See [PROJECT-OVERVIEW.md](./PROJECT-OVERVIEW.md) for the project's vision, scope, and current status.

1. **Foundation** — AWS account setup, Amplify project scaffolding, CDK stack for Lambda/DynamoDB/API Gateway, DynamoDB table design, local Express+JSON mock for early frontend dev.
   *Milestone: app runs fully locally against the mock backend; a placeholder deploy is reachable on Amplify.*

2. **Map + address search** — MapLibre GL JS + Esri World Imagery + Nominatim, geocode a typed address, center/zoom the map.
   *Milestone: type an address, see a real map centered on it.*

3. **Roof outline tool** — drawing UI layered on the map, stored as GeoJSON.
   *Milestone: trace a rough outline around any visible roof and see it rendered as a clean polygon.*

4. **Module placement tool** — add/move/rotate panel rectangles constrained to the outline, basic overlap handling.
   *Milestone: a traced roof can be filled with a layout that looks like a real design.*

5. **Persistence layer** — anonymous session handling; project CRUD through API Gateway → Lambda → DynamoDB.
   *Milestone: close the tab, come back, the design is still there.*

6. **Templates + admin mode** — 2-3 seeded example designs, fork-on-open logic for regular users, admin CRUD for the templates.
   *Milestone: any visitor can freely edit an example without affecting what the next visitor sees.*

7. **Deploy + polish** — production Amplify deployment, custom domain, AWS budget alert, UI cleanup.
   *Milestone: portfolio-ready link.*

*(Follow-on, post-MVP: Google Solar API shading/production estimate, share-a-design links, email-based project claiming, commercial/utility-scale mode.)*

Scope is expected to shift somewhat as work progresses — this is a working outline, not a fixed contract.
