---
type: Component
title: "aeion-spec engine"
description: "The Bun + Elysia backend: Argon2id + Invite authentication, AES-256-GCM credential vault, SQLite & in-memory repositories, AxiomSpec 0.3 compiler bridge, release sealing, and Builder API."
status: stable
sources:
  - resource: ../../app/serve
    title: "Combined startup script (Elysia :4171 + Next.js :4170)"
  - resource: ../../app/package.json
    title: "Bun monorepo workspaces"
  - resource: ../../app/packages/server/src/index.ts
    title: "Server bootstrap with 255s SSE idleTimeout"
  - resource: ../../app/packages/server/src/app.ts
    title: "Elysia REST, SSE, Vault, Tableau, Release Seal, and Builder API routes"
  - resource: ../../app/packages/server/src/auth/service.ts
    title: "Argon2id auth, CSRF double-submit protection, and volatile Invite Mode"
  - resource: ../../app/packages/server/src/db/repository.ts
    title: "SQLite persistent and volatile in-memory repositories"
  - resource: ../../app/packages/server/src/vault/crypto.ts
    title: "HKDF-SHA256 + AES-256-GCM per-user DEK vault envelope encryption"
  - resource: ../../app/packages/server/src/axiom/compiler.ts
    title: "AxiomSpec 0.3 compiler & release-diff bridge"
  - resource: ../../app/packages/server/src/observability/exporter.ts
    title: "8-section Observability markdown compiler and manifest builder"
  - resource: ../../app/axiom03/engine.py
    title: "Python vendored AxiomSpec 0.3 G01-G14 validator & Ed25519 approval engine"
  - resource: ../../app/packages/server/src/relay/context-relay.ts
    title: "Context relay and LiteLLM bridge lifecycle"
  - resource: ../../app/packages/server/src/relay/litellm_bridge.py
    title: "LiteLLM bridge process"
  - resource: ../../app/packages/server/test/platform.test.ts
    title: "Bun vault, auth, invite, OpenShell, E2E release seal, and relay tests"
  - resource: ../../app/packages/server/test/review-fixes.test.ts
    title: "Review fixes: fail-closed review, card gates, seal, slug and vault purpose tests"
  - resource: ../../app/tests/test_platform_python.py
    title: "Python quarantine & AxiomSpec 0.3 contract tests"
---

# aeion-spec engine

## Intent

Deliver a multi-tenant capable, local-first zero-trust API powering the Æion Spec platform: registered users
get encrypted key vaults, multi-project management, and cumulative release histories, while Invite Mode
users work purely in volatile `:memory:` SQLite with zero disk artifacts. Exports immutable sealed
specifications via `/api/v1/builder/*` for builder agents (`aeion-observability`).

## Data sources

Runtime configuration from environment (`AEION_DATA`, `AEION_HOST`, `AEION_PORT`, `AEION_LLM`,
`AEION_PERSISTENT_DB`, `AEION_RELAY_PORT`, `AEION_BRIDGE_PORT`) and quarantined project snapshots from
`app/openshell/quarantine.py`.

## Inputs

Typed JSON and multipart upload payloads via Elysia (`X-Aeion: 1`, HTTP-only session cookie, CSRF token,
or scoped `Authorization: Bearer` tokens for `/api/v1/builder/*`). Archive uploads reject payloads over
`100 MiB`.

## Outputs

SQLite state in `app/.aeion/` (or pure `:memory:` in Invite Mode), validated `axiomspec/0.3` snapshots,
HMAC-SHA256 release digests, and 8-section Observability feature manifests (`<= 12,000 B`).

## Invariants

- Auth uses Argon2id hashes (`Bun.password`) and CSRF-guarded HttpOnly cookies; Invite Mode wipes all
  in-memory projects, vault secrets, and interviews cleanly on logout or TTL expiry.
- Vault secrets are wrapped with per-user DEKs via AES-256-GCM + HKDF-SHA256 + AAD binding (`userId`,
  `keyId`, `purpose`, `provider`) and buffer zeroization.
- Every sealed release compiles cumulatively across prior sealed releases while allowing active Kanban
  sheets to clean validated cards after release sign-off.
- No plaintext API key or GitHub token is returned in any HTTP response or error message.
- The API listens with `reusePort: false` (Elysia shares the port by default): a second instance on a
  taken port fails instead of silently splitting requests with a stale one.
- Elysia's own errors keep their codes (404, 422, 400); only programming errors become 500. A card that
  is archived or belongs to a sealed release is refused with 409, and so is a review request before both
  the swarm and the owner are satisfied; editing a card or withdrawing the owner's satisfaction demotes a
  passed review back to the interview.
- A seal needs a version greater than the last sealed one and runs in one transaction with its
  optional release notes; a failed GitHub ingest deletes the half-created project.
- A slug is unique per owner; the default Model Mixer picks providers the owner holds a key for; a vault
  key of another purpose or provider is refused for a role.

## Determinism

Deterministic `featureCode` node ID assignment inside `axiom/compiler.ts` ensures repeatable AxiomSpec 0.3
compilation and accurate G14 incremental release diffs across sealed versions.

## Acceptance checks

- [ ] `(cd app && bun test packages/server/test)` passes (19 tests, including `review-fixes.test.ts`).
- [ ] `.venv/bin/python -m unittest discover -s app/tests -v` passes Python quarantine & Axiom03 checks.

## Out of scope

Executing arbitrary builder code directly or mutating target product repositories from `aeion-spec`.
