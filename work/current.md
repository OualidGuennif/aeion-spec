# Current work

Task state only. One entry per open task, newest first. At most 150 lines, 10 per entry.
Finished tasks are deleted: the commit message and knowledge/ keep what matters.
Status: ACTIVE, WAITING-OWNER, MEASURING, BLOCKED, BACKLOG. An entry is `## <title> — <STATUS>`, then the
lines `- Owner decision:`, `- State:`, `- Next:` (with who), `- Blocker:`, `- Evidence:`.

## Full review, bug fixes, glass UI redesign and template 4.0.3 bump — WAITING-OWNER
- Owner decision: 2026-11-16, review all of `app/`, fix bugs and inconsistencies, redesign the UI (PayPal/Apple glass/Skyscanner), bump aeion-template to 4.0.3, remove archify and graphify, update CI.
- State: fixes, redesign, docs, CI pins done; 19/19 Bun, 2 Python, all gates PASS; checked by eye at 375/1440 light/dark; 3 live OpenCode rounds ran. Archify/Graphify already absent. Nothing committed.
- Next: owner's visual yes; owner's yes to commit on `develop`, then the 4.0.3 bump (drops the in-repo AxiomSpec engine) and its CI merge (who: owner, then agent).
- Blocker: the bump refuses a tree with uncommitted tracked changes.
- Evidence: `work/handovers/f9eb7adc-8f5d-4ba3-89e7-4ef2481349ce.md`

## Æion Spec Bun/Elysia/Next.js + Flue/LiteLLM/OpenShell transformation — WAITING-OWNER
- Owner decision: 2026-11-15, rebranded from `aeion-core` to `aeion-spec`; Bun + Elysia + Eden + Next.js with Flue + Pi behind LiteLLM and OpenShell isolation.
- State: full stack implemented and live-verified with `OPENCODE_API_KEY` (`deepseek-v4.1-flash` + `claude-haiku-5-5`) against `OualidGuennif/aeion-autonomous-forum`; AxiomSpec 0.3, Observability export, and Release Seal validated.
- Next: review changes on `develop` and deploy/tag when ready (who: owner).
- Blocker: none.
- Evidence: `app/packages/server/test/platform.test.ts`, `app/tests/test_platform_python.py`, `knowledge/spec/spec.json`
