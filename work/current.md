# Current work

Task state only. One entry per open task, newest first. At most 150 lines, 10 per entry.
Finished tasks are deleted: the commit message and knowledge/ keep what matters.
Status: ACTIVE, WAITING-OWNER, MEASURING, BLOCKED, BACKLOG. An entry is `## <title> — <STATUS>`, then the
lines `- Owner decision:`, `- State:`, `- Next:` (with who), `- Blocker:`, `- Evidence:`.

## Full review, bug fixes, glass UI redesign and template 4.0.3 bump — WAITING-OWNER
- Owner decision: 2026-11-16, review all of `app/`, fix bugs and inconsistencies, redesign the UI (PayPal/Apple glass/Skyscanner), bump aeion-template to 4.0.3, remove archify and graphify, update CI.
- State: review fixes, glass UI, Template 4.0.3, CI name fix and the independent review's three fixes (busy card 409, single seal per sheet, late invite import refused) committed on `develop`; 22/22 Bun, 3 Python, template-tests and doc gates PASS. Owner asked on 2026-11-16 to push `develop`, then release to `main`.
- Next: independent re-review of the head, push `develop`, release PR `develop → main`, merge on green CI, tag v0.2.0 (who: agent). Then owner: visual yes on the UI, `tools/agents/dsh-install --tag v4.0.3 --trust .`, desktop restart, aeion-framework migration decision.
- Blocker: none.
- Evidence: `work/handovers/f9eb7adc-8f5d-4ba3-89e7-4ef2481349ce.md`

## Æion Spec Bun/Elysia/Next.js + Flue/LiteLLM/OpenShell transformation — WAITING-OWNER
- Owner decision: 2026-11-15, rebranded from `aeion-core` to `aeion-spec`; Bun + Elysia + Eden + Next.js with Flue + Pi behind LiteLLM and OpenShell isolation.
- State: full stack implemented and live-verified with `OPENCODE_API_KEY` (`deepseek-v4.1-flash` + `claude-haiku-5-5`) against `OualidGuennif/aeion-autonomous-forum`; AxiomSpec 0.3, Observability export, and Release Seal validated; committed on `develop` (26f5444), ships with the v0.2.0 release above.
- Next: delete this entry once v0.2.0 is tagged (who: agent).
- Blocker: none.
- Evidence: `app/packages/server/test/platform.test.ts`, `app/tests/test_platform_python.py`, `knowledge/spec/spec.json`
