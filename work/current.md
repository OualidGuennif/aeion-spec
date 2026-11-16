# Current work

Task state only. One entry per open task, newest first. At most 150 lines, 10 per entry.
Finished tasks are deleted: the commit message and knowledge/ keep what matters.
Status: ACTIVE, WAITING-OWNER, MEASURING, BLOCKED, BACKLOG. An entry is `## <title> — <STATUS>`, then the
lines `- Owner decision:`, `- State:`, `- Next:` (with who), `- Blocker:`, `- Evidence:`.

## Migrate `knowledge/spec/` and the `docs/` cockpit to aeion-framework — BACKLOG
- Owner decision: 2026-11-16, not now; the next step after the v0.2.0 release.
- State: both stay frozen since Æion Template 4.0.3 removed the embedded AxiomSpec engine; framework mode is off.
- Next: plan the migration when the owner starts it (who: owner).
- Blocker: none.
- Evidence: `knowledge/components/framework-mode.md`, `CHANGELOG.md` 0.2.0
