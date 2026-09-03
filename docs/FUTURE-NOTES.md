# SunDraft — Future Notes

Scratch notes for ideas and concerns that are deliberately post-MVP. Captured here so they aren't lost or reinvented later, not because they're scheduled — see [MILESTONES.md](./MILESTONES.md) for what's actually being worked on, and [PROJECT-OVERVIEW.md](./PROJECT-OVERVIEW.md) for current scope.

## Module Violations & Design Violations

Right now a module can only be *rejected* at the moment it's placed or moved (overlap/containment checks block the action outright). Eventually issues need to be able to *exist* and stay flagged instead of only being caught at the moment of action — e.g. a roof's outline got edited out from under a module that used to fit fine, or some future check (module-to-roof footprint containment, multiple module types with different sizes, an efficiency estimate, etc.) surfaces something that isn't tied to a single placement action. The UI needs a clear way to show what's wrong and why, not just prevent new bad actions.

**Violation** is the generic term for one of these issues. Every violation has one of three severities, and applies at one of two scopes:

**Scope**

- **Module Violation** — tied to one specific module. Example: this module overlaps another; this module falls outside its roof.
- **Design Violation** — tied to the design/project as a whole, with no single module responsible. Example: the design has zero modules placed (Blocking — nothing to send off for a production estimate); the design's overall system efficiency is too low (Advisory — subjective, no hard line). Design Violations are shown at the design level in the UI (not attached to any particular module), so there's one clear place a user can look to see "is this design OK."

The existence of *any* Module Violation also counts toward a Design Violation of the same severity — a design with a Blocking module issue is itself a design with a Blocking issue, without needing a separate rule to say so. Design Violations are therefore the union of direct whole-design checks plus every currently-present Module Violation, rolled up by severity.

**Severity** (applies the same way at both scopes)

1. **Fatal** — the action that would produce this is nullified outright (ideally with a small explanatory message, e.g. a snackbar) rather than allowed to happen. Example: moving a module completely off its roof. A Fatal violation should *never* actually reach persisted data — if one ever did, that's a bug upstream, not a legitimate state. This tier isn't really a state something can be *in*; it's a gate on the action itself.
2. **Blocking** — the action is allowed and the resulting state persists normally, but the presence of *any* Blocking violation gates specific downstream actions — e.g. overlapping modules, a module overlapping its roof's edge, or a design with zero modules can't be sent off for a production-estimate call to a third party until resolved.
3. **Advisory** — surfaced to the user, but doesn't block anything; left to their discretion. Example: a module placed under a tree with poor sun exposure, or a design's low overall efficiency. These are often subjective with no hard pass/fail line, unlike Fatal/Blocking which are objective geometric facts.

The hard part isn't detecting a violation, it's *when* to recompute it. Naively re-validating every module against every other module (and every roof) on every edit is an O(n²)-ish sweep that gets expensive fast, especially once a single Fill can produce hundreds of modules — and Design Violations would then need to re-aggregate on top of that. This needs a real design pass before it's built — likely incremental/targeted validation (a change only re-checks what it could plausibly have affected, e.g. modules on the same roof) plus somewhere to cache each module's violations and the design-level rollup, instead of recomputing everything from scratch on every render.

Deliberately post-MVP, but noting it now — and naming it — since it's core to a trustworthy design tool, not just a nice-to-have polish item.

## Subarrays

A **subarray** is a group of modules on the same roof that are mutually "touching" — e.g. Fill produces one subarray covering the whole roof; deleting the entire middle row of that grid would split it into two separate subarrays. Roof is already a hard grouping boundary (see the same-roof restriction on multi-select); a subarray would be a finer-grained grouping *within* a roof, based on physical adjacency rather than just co-location.

Not defined yet, and needs to be before it's buildable:

- What counts as "touching" — some fixed distance tolerance? Exact edge contact only? Do two modules have to share the same row/column alignment, or can they be offset (e.g. staggered) and still count as touching?
- Whether a subarray is a real stored concept (computed and cached, like the deferred Violations rollup above) or purely derived on demand from the current module layout.

Likely useful once it exists: bulk operations scoped to "this subarray" rather than the whole roof or a hand-drawn selection, and probably ties into the Violations system above (e.g. a subarray-level check, not just module- or design-level).

A concrete motivating example — the reason this is being noted now rather than left implicit: double-click currently selects every module on the double-clicked module's *roof*. Once subarrays exist, double-click should narrow to selecting the double-clicked module's *subarray* instead (the finer-grained, more useful default), with the current whole-roof behavior demoted to a modifier — e.g. shift+double-click — rather than dropped. Whatever else changes about subarrays, this specific interaction mapping (double-click / modifier+double-click) should carry forward.

Post-MVP, noting it now so the selection/grouping model (currently: roof-scoped only) has a known next step instead of needing to be reinvented later.
