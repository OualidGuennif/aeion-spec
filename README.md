# Æion Spec

Zero-trust specification & adversarial Goldfish review workbench taking product releases from raw ideas
to validated **AxiomSpec 0.3** (`axiomspec/0.3`) contracts and **aeion-observability** feature specifications
with Builder API delivery.

1. **Auth, Ephemeral Invite Mode & AES-256-GCM Vault.** Registered accounts persist release sheets and
   encrypted provider secrets (Argon2id + per-user DEK wrapped by AES-256-GCM + HKDF-SHA256); Invite Mode
   runs strictly in memory (`:memory:`) with zero disk persistence and instant wipe on exit or TTL expiry.
2. **Release Tableau & Dual-Satisfaction Goldfish Loop.** Manage scoped releases across `Idea` →
   `Goldfish Interview` → `Automated Review` → `Validated`. Elephant interrogates requirements while
   fresh zero-history Goldfish personas attack independently via Flue (`@flue/runtime` 2.3.0) + Pi
   (`@earendil-works/pi-ai` 1.4.0) behind a loopback ContextRelay + LiteLLM bridge supporting 7 providers
   (`anthropic`, `openai`, `deepinfra`, `openrouter`, `mistral`, `deepseek`, `opencode-go`) and per-role
   model mixing.
3. **Zero-Trust OpenShell Source Quarantine.** Projects support greenfield `empty` sources, `github_public`,
   `github_private` (read-only PAT inside vault), and `archive_upload` (strictly `<= 100 MB` ZIP/TAR with
   traversal, symlink/O_NOFOLLOW, zip-bomb, and secret-redaction checks). Every clone/extraction and probe
   runs isolated via NVIDIA OpenShell (`openshell`) / Docker / strict Landlock confinement.
4. **AxiomSpec 0.3 + Observability Export + Builder API.** Automated Review enforces cross-family model
   separation, Axiom03 gates `G01–G14`, and 8-section Observability exports (`<= 12,000 B`). Validating
   a release seals cumulative specifications (HMAC-SHA256 signature + G14 delta audit), archives release
   history, clears the active sheet, and exposes sealed artifacts via scoped Builder Bearer tokens
   (`/api/v1/builder/projects/:slug/spec`).

## Run it

Requirements: **Bun 1.2+**, **Python 3.11+**, `.venv` (with `litellm`, `fastapi`, `uvicorn`, `jsonschema`),
and optional NVIDIA `openshell` + Docker for microVM isolation.

```bash
cd app && bun install --frozen-lockfile && bun --cwd packages/web build && cd ..
python3 -m venv .venv && .venv/bin/pip install fastapi uvicorn litellm jsonschema
echo 'OPENCODE_API_KEY=...' > .env         # optional server/test env; never committed
./app/serve                                # Next.js http://127.0.0.1:4170 + Elysia :4171
```

`AEION_LLM=mock ./app/serve` runs fully offline with deterministic scripted Flue agents.

## How it is built

| Part | Where | Spec |
| --- | --- | --- |
| Elysia API, Vault, SQLite & Release Engine | `app/packages/server/src/` | [aeion-engine](knowledge/components/aeion-engine.md) |
| Flue + Pi agents, skills, sandbox tools, ContextRelay | `app/packages/flue/`, `app/packages/server/src/relay/` | [aeion-agents](knowledge/components/aeion-agents.md) |
| Tableau orchestrator & Goldfish rounds | `app/packages/server/src/tableau/orchestrator.ts` | [goldfish](knowledge/components/goldfish.md) |
| Next.js glass UI (light and dark) & Observability export | `app/packages/web/`, `app/packages/server/src/observability/` | [spec-studio](knowledge/components/spec-studio.md) |
| OpenShell quarantine & read-only snapshots | `app/openshell/`, `app/packages/server/src/openshell/` | [openshell](knowledge/components/openshell.md) |
| AxiomSpec 0.3 validator & approvals | `app/axiom03/` | [aeion-engine](knowledge/components/aeion-engine.md) |

Secrets stay inside AES-256-GCM vault envelopes and loopback `ContextRelay` per-run tokens; no agent or
provider payload ever receives plaintext credentials, and `aeion-spec` never writes into target repositories.

## Tests

```bash
(cd app && bun test packages/server/test && bun run typecheck && bun --cwd packages/web build)
.venv/bin/python -m unittest discover -s app/tests -v
./tools/template-tests && ./tools/knowledge/knowledge-check && ./tools/knowledge/doc-links && ./tools/repo-health/repo-health
```

Built from [Æion Template](https://github.com/OualidGuennif/aeion-template) 4.0.3.
