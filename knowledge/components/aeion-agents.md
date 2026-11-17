---
type: Component
title: "Flue agents"
description: "Every model call of aeion-spec runs as a Flue + Pi agent behind ContextRelay and LiteLLM across 7 user-configured providers, with per-run tokens and isolated Goldfish contexts."
status: stable
sources:
  - resource: ../../app/packages/server/src/relay/context-relay.ts
    title: "Loopback ContextRelay HTTP bridge, per-run tokens, idle timeout"
  - resource: ../../app/packages/server/src/relay/litellm_bridge.py
    title: "FastAPI + LiteLLM 7-provider gateway with x-opencode-session and SSE fallback"
  - resource: ../../app/packages/server/src/relay/flue-runner.ts
    title: "Flue subprocess launcher, Goldfish swarm parallel runner, cross-family review"
  - resource: ../../app/packages/shared/src/providers.ts
    title: "Catalog of 7 LiteLLM-backed providers and model family metadata"
  - resource: ../../app/packages/shared/src/contracts.ts
    title: "Agent role, finding, decision, and review TypeScript contracts"
  - resource: ../../app/packages/shared/src/schemas.ts
    title: "TypeBox/Elysia request and submission schemas"
  - resource: ../../app/packages/shared/src/index.ts
    title: "Shared package exports"
  - resource: ../../app/packages/flue/package.json
    title: "Pinned Flue 2.3.0 & Pi 1.4.0 harness versions"
  - resource: ../../app/packages/flue/src/common.ts
    title: "Input blocks, bridge tools, typed submissions"
  - resource: ../../app/packages/flue/src/provider.ts
    title: "Model registration through the loopback ContextRelay"
  - resource: ../../app/packages/flue/src/observe.ts
    title: "Structured JSONL event stream read by the server"
  - resource: ../../app/packages/flue/src/db.ts
    title: "In-memory conversation store per run"
  - resource: ../../app/packages/flue/src/agents/
    title: "Dedicated Flue + Pi agent entrypoints"
  - resource: ../../app/packages/flue/src/skills/
    title: "Elephant-Goldfish and AxiomSpec skills"
  - resource: ../../app/packages/flue/src/tools/
    title: "Sandbox and structured submission tools"
  - resource: ../../app/packages/server/test/platform.test.ts
    title: "7-provider routing, loopback relay, and E2E contract tests"
---

# Flue agents

## Intent

Run every piece of model work as a dedicated agent with only the tools and the skill its role needs,
on the [Flue](https://flueframework.com/) harness (`@flue/cli` and `@flue/runtime` 2.3.0, on Pi's
`@earendil-works/pi-ai` 1.4.0), routed through LiteLLM across seven user-configured providers
(`anthropic`, `openai`, `deepinfra`, `openrouter`, `mistral`, `deepseek`, `opencode-go`). Agents
propose; the Bun/Elysia server validates, decrypts vault secrets only at dispatch time in memory, and
never lets an agent hold plaintext API keys or write directly to source trees.

## Data sources

- Encrypted per-user API keys in `VaultCrypto` (decrypted just-in-time per relay call) and `OPENCODE_API_KEY`
  for test runs; routed via `litellm_bridge.py` on loopback.
- The agent definitions, skills, and tools in `app/packages/flue/src/`, installed with `bun install` in `app/`.

## Inputs

One Bun subprocess per agent turn via `flue-runner.ts` (`elephant`, `goldfish`, `reviewer`, `drafter`,
and specialist helpers). Structured evidence blocks, settled `DEC-*` decisions (shared via
`DecisionAnswerItemSchema` between `InterviewTurnSchema` and `UpdateCardSchema`), and read-only OpenShell
file slices enter via ContextRelay per-run input bundles.

| Agent | Role | Tools | Skill |
| --- | --- | --- | --- |
| `elephant` | feature interview & codebase interrogation | `anchor_hypothesis`, `read_sandbox_file`, `list_sandbox_files` | `egm-brainstorm` |
| `goldfish` | isolated fresh-context lens reviewer | `read_sandbox_file`, `list_sandbox_files` | none |
| `reviewer` | cross-family automated reviewer | `submit_review`, `read_sandbox_file`, `list_sandbox_files` | none |
| `synthesizer` | concepts brief | none | `egm-synthesis` |
| `consolidator` | stage findings | `submit_findings` | `egm-synthesis` |
| `drafter` | design document section | `ask_owner` | `egm-draft` |
| `reconciler` | brief versus draft | `submit_reconciliation` | `egm-draft` |
| `resolver` | answers to findings | `submit_resolution` | `egm-resolve` |
| `analyst` | AxiomSpec obligations | `list_catalog`, `submit_fragment`, `amend_fragment` | `axiomspec-authoring` |
| `patcher` | spec changes | `read_record`, `submit_patch` | `axiomspec-authoring` |
| `discussant` | spec discussion | `read_record`, `run_checks` | `axiomspec-authoring` |
| `illustrator` | feature diagrams | `submit_views` | `aeion-views` |
| `librarian` | documentation answers | `search_docs`, `open_page`, `graph_query` | `docs-research` |

## Outputs

Structured text, typed tool payloads (`anchor_hypothesis`, `submit_review`), token/cost usage events via
`AEION_EVENTS_FILE`, and SSE progress events streamed back to the Spec Studio drawer.

## Invariants

- Plaintext provider keys never cross into Flue child process environments: each child receives only an
  ephemeral single-run `AEION_RELAY_TOKEN` bound to loopback `ContextRelay`, which forwards `x-aeion-session-id`
  to `litellm_bridge.py` (`x-opencode-session` for OpenCode Go) with `X-Aeion-Bridge-Secret` verification.
- Loopback URL checks reject non-loopback `AEION_RELAY_URL` targets before any model call.
- Every Goldfish turn runs with zero conversation history (fresh isolated context); follow-up and
  reassessment prompts (`buildGoldfishPrompt`) direct each lens to verify settled decisions and declared
  scope rather than re-emitting out-of-scope blockers across rounds.
- Automated review requires cross-family separation between interview models and `reviewer` when
  multiple providers/families are configured.
- The review fails closed: a missing or malformed `submit_review` verdict reads as "revise", and every
  structured submission is re-checked against its declared schema before it counts.
- The LiteLLM bridge starts with an allowlisted environment (no ambient provider keys), must print its
  ready line before a deadline, and has its output drained so it cannot block.
- Each Goldfish persona's key is checked before the swarm starts; one persona that fails does not sink
  the others, it becomes a MAJOR `GF-n-PERSONA-FAILED` finding.
- The Model Mixer carries provider and model per role; its stored temperature and thinking level are
  not passed to the agents, so the UI does not offer them.
- For OpenCode Go, the curated catalog lists enabled models (`deepseek-v4.1-flash`, `claude-haiku-5-5`,
  `glm-5.3-flash`, `minimax-m3.1-flash`, `qwen3.8-flash`, `qwen4-max`), and when a key's `/v1/models` list
  excludes a role's assigned model, the runner and mixer fall back to an enabled model for that role
  (`claude-haiku-5-5` first for `reviewer`, `deepseek-v4.1-flash` first for interview and Goldfish roles).
  Failed Flue runs report the error tail rather than the CLI startup banner.

## Determinism

Schemas, gates, and export compilers determine state transitions; `AEION_LLM=mock` executes offline
without network calls while exercising the full orchestration pipeline.

## Acceptance checks

- [ ] `(cd app && bun test packages/server/test)` passes 7-provider routing and relay security checks.
- [ ] Live OpenCode Go (`deepseek-v4.1-flash` + `claude-haiku-5-5`) round-trip completes via LiteLLM.

## Out of scope

Storing multi-turn Flue state on disk across requests or exposing provider API keys to browser clients.
