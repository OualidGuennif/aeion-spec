---
type: Component
title: "Spec studio"
description: "Next.js + Eden Treaty workbench with an OpenAI-sober light/dark UI, AxiomSpec 0.3 G01-G14 compilation, 8-section aeion-observability feature export, cumulative release sealing, and historical archives."
status: stable
sources:
  - resource: ../../app/packages/web/src/app/layout.tsx
    title: "Next.js root layout, viewport colours and the theme set before first paint"
  - resource: ../../app/packages/web/src/app/page.tsx
    title: "Compact Workspace, Releases, Keys shell and Card Drawer"
  - resource: ../../app/packages/web/src/components/
    title: "AuthGate, ReleaseBoard, CardStudioDrawer, VaultMixerPanel, CreateProjectModal, ReleasesArchive, ThemeSwitch"
  - resource: ../../app/packages/web/src/styles/
    title: "Monochrome + warm-stone design tokens (light and dark, AA-checked pairs) and the one shared stylesheet"
  - resource: ../../app/packages/web/src/lib/api.ts
    title: "Type-safe Eden Treaty client for Elysia API"
  - resource: ../../app/packages/server/src/observability/exporter.ts
    title: "8-section feature markdown compiler and Observability manifest builder"
  - resource: ../../app/packages/server/profiles/aeion-observability.json
    title: "Export profile (frontmatter and section texts)"
  - resource: ../../app/packages/server/profiles/aeion-observability-target.json
    title: "Build-factory rules (areas, phases, scopes, delivery steps)"
  - resource: ../../app/packages/server/test/platform.test.ts
    title: "Studio export, Axiom03 compilation, and release sealing tests"
---

# Spec studio

## Intent

Turn an agreed release into contracts that a build factory (`aeion-observability` or standalone builders via
`/api/v1/builder/*`) can implement and verify autonomously, inside a calm light/dark OpenAI-style black-and-white
web UI with a subtle Anthropic warm stone and clay touch plus midnight blue links and focus rings (the owner's
request of 2026-11-16). Deterministic AxiomSpec `0.3` and Observability checks decide readiness; only the owner
resolves design decisions and seals releases.

## Data sources

Validated feature cards across active and sealed releases, settled `DEC-*` answers, project Model Mixer
assignments, OpenShell root digests, and the export/target profiles in `app/packages/server/profiles/`.

## Inputs

Guided 4-step pipeline stage filters and card transition buttons (Ideas, Goldfish interview, Automated review,
Validated), archiving a card and restoring it to Ideas, SSE interview turns with customizable Goldfish persona
selection, `DEC-*` decision settlements (answering one also confirms the unverified assumptions the drawer lists),
manual finding resolutions, Model Mixer provider and model per role (grouped into core pipeline roles and the
8-persona Goldfish swarm, filtering OpenCode Go presets to the account's enabled models when discovered;
temperature and thinking level stay hidden because they do not reach the agents), and
sealing with optional release notes.

## Outputs

Cumulative `axiomspec/0.3` specifications (`previous` chained to the prior sealed release digest),
validated 8-section Observability Markdown exports (`<= 12,000 B`) with `MANIFEST.json` bundles, cleaned
active sheets, and immutable release history entries.

## Invariants

- Nothing seals that fails AxiomSpec `0.3` gates `G01-G14` or Observability constraints (`max_bytes <= 12,000`,
  all 8 canonical sections present, valid `write_paths`, delivery step bounds).
- Sealed releases are cumulative across prior sealed versions even after active sheets clear validated cards.
- Every UI mutation uses Eden Treaty with CSRF headers (`X-Aeion: 1`, `X-CSRF-Token`).
- `aeion-spec` never writes into `aeion-observability` or user source repositories.
- Colours live only in `styles/tokens.css`; surfaces use high-contrast solid ink and paper tokens with clean
  translucent header fallback under `prefers-reduced-transparency`. Under `prefers-reduced-motion`, spatial
  transitions stop while discrete state changes remain visible.
- The stored theme (`aeion-theme`: light, night, auto) is applied before first paint, so there is no flash.
- Before round 1 runs, the drawer shows the Goldfish swarm status as not started rather than flagging open
  questions; failed requests show their error where the action was taken (the seal error inside its dialog,
  the workspace error in a banner). An interview stream that ends without `complete` is an error. Open Goldfish
  challenges offer a single-click `Resolve all` action that batches resolutions via `PATCH /cards/:cardId`, and the
  `Spec` tab lets the owner narrow `write_paths`.
- A guest vault reads "sealed in memory", never "sealed at rest"; archived cards open read-only.
- At 760 px and below, the top bar scrolls away instead of staying pinned, stage tabs scroll smoothly, data
  tables stack cleanly, and interactive controls meet a 44 px minimum hit target.

## Determinism

For identical cards, decisions, and OpenShell digests, `compiler.ts` and `exporter.ts` produce deterministic
node IDs, YAML frontmatter, markdown bytes, and SHA-256 release digests.

## Acceptance checks

- [ ] `bun --cwd packages/web build` compiles cleanly with zero TypeScript errors.
- [ ] Release sealing across multiple releases passes Axiom03 G14 diff checks and serves via Builder Bearer API.
- [ ] Sign-in, board, drawer, keys and releases checked by eye at 375 px and 1440 px, light and dark.

## Out of scope

Mutating target codebases directly; implementation belongs to downstream builder agents reading `/api/v1/builder/*`.
