---
type: Component
title: "Spec studio"
description: "Next.js + Eden Treaty workbench with a glass light/dark UI, AxiomSpec 0.3 G01-G14 compilation, 8-section aeion-observability feature export, cumulative release sealing, and historical archives."
status: stable
sources:
  - resource: ../../app/packages/web/src/app/layout.tsx
    title: "Next.js root layout, viewport colours and the theme set before first paint"
  - resource: ../../app/packages/web/src/app/page.tsx
    title: "Main Release Tableau, Mixer, Archive, and Card Drawer workspace"
  - resource: ../../app/packages/web/src/components/
    title: "AuthGate, ReleaseBoard, CardStudioDrawer, VaultMixerPanel, CreateProjectModal, ReleasesArchive, ThemeSwitch"
  - resource: ../../app/packages/web/src/styles/
    title: "Glass design tokens (light and dark, AA-checked pairs) and the one shared stylesheet"
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

Turn an agreed release into contracts a build factory (`aeion-observability` or standalone builders via
`/api/v1/builder/*`) can implement and verify autonomously, inside a calm light/dark web UI: PayPal's ink
and confident blue, Apple's frosted glass layers, Skyscanner's friendly chips and swipeable lanes (the
owner's request of 2026-11-16). Deterministic AxiomSpec `0.3` and Observability checks decide readiness;
only the owner resolves design decisions and seals releases.

## Data sources

Validated feature cards across active and sealed releases, settled `DEC-*` answers, project Model Mixer
assignments, OpenShell root digests, and the export/target profiles in `app/packages/server/profiles/`.

## Inputs

Interactive Release Tableau moves (drag and drop or buttons), archiving a card and restoring it to Ideas,
SSE interview turns, `DEC-*` decision settlements (answering one also confirms the unverified assumptions
the drawer lists), manual finding resolutions, Model Mixer provider and model per role (temperature and
thinking level are not offered: they do not reach the agents), and sealing with optional release notes.

## Outputs

Cumulative `axiomspec/0.3` specifications (`previous` chained to the prior sealed release digest),
validated 8-section Observability Markdown exports (`<= 12,000 B`) with `MANIFEST.json` bundles, cleaned
active boards, and immutable release history entries.

## Invariants

- Nothing seals that fails AxiomSpec `0.3` gates `G01-G14` or Observability constraints (`max_bytes <= 12,000`,
  all 8 canonical sections present, valid `write_paths`, delivery step bounds).
- Sealed releases are cumulative across prior sealed versions even after active boards clear validated cards.
- Every UI mutation uses Eden Treaty with CSRF headers (`X-Aeion: 1`, `X-CSRF-Token`).
- `aeion-spec` never writes into `aeion-observability` or user source repositories.
- Colours live only in `styles/tokens.css`; every glass surface falls back to a solid one without
  `backdrop-filter` or under `prefers-reduced-transparency`, and motion stops under `prefers-reduced-motion`.
- The stored theme (`aeion-theme`: light, night, auto) is applied before first paint, so no flash.
- A failed request shows its error where the action was taken (the seal error inside its dialog, the
  workspace error in a banner); none is swallowed. An interview stream that ends without `complete` is an error.
- A guest vault reads "sealed in memory", never "sealed at rest"; archived cards open read-only.
- At 760 px and below the lanes become a swipeable row and the top bar scrolls away instead of staying pinned.

## Determinism

For identical cards, decisions, and OpenShell digests, `compiler.ts` and `exporter.ts` produce deterministic
node IDs, YAML frontmatter, markdown bytes, and SHA-256 release digests.

## Acceptance checks

- [ ] `bun --cwd packages/web build` compiles cleanly with zero TypeScript errors.
- [ ] Release sealing across multiple releases passes Axiom03 G14 diff checks and serves via Builder Bearer API.
- [ ] Sign-in, board, drawer, keys and releases checked by eye at 375 px and 1440 px, light and dark.

## Out of scope

Mutating target codebases directly; implementation belongs to downstream builder agents reading `/api/v1/builder/*`.
