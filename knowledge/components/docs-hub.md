---
type: Component
title: "Documentation hub"
description: "Knowledge graph indexing, deterministic cockpit generation (`docs/`), and integrated release/spec inspection inside the Next.js workbench."
status: stable
sources:
  - resource: ../../tools/axiom/graph.py
    title: "Knowledge graph snapshot"
  - resource: ../../tools/axiom/query.py
    title: "Bounded graph queries"
  - resource: ../../tools/axiom/docs.py
    title: "Generated documentation cockpit and diagrams"
  - resource: ../../app/packages/web/src/app/page.tsx
    title: "Studio release history, dual-spec preview, and card drawer views"
---

# Documentation hub

## Intent

Keep architectural knowledge, AxiomSpec nodes, and exported release specifications traceable across the
repository (`docs/README.md` via `./tools/axiom/axiom docs`) and inspectable directly inside the Spec
Studio drawer and Release Archive.

## Data sources

`aeion-spec`'s own `knowledge/` markdown files, `knowledge/spec/spec.json`, generated SVG diagrams in
`docs/generated/diagrams/`, and sealed project release artifacts.

## Inputs

Repository files indexed by `tools/axiom/graph.py`, CLI queries via `tools/axiom/axiom`, and UI drawer/archive
inspections in the Next.js workbench.

## Outputs

Static generated cockpit pages (`docs/README.md`, `docs/generated/`), graph query packets, and rendered
spec/Axiom views inside the Spec Studio UI.

## Invariants

- All diagram assets and generated docs derive deterministically from `knowledge/` and `spec.json`.
- Nothing is hand-edited under `docs/generated/`; `tools/axiom/axiom check` verifies freshness.

## Determinism

Graph snapshots, generated Markdown pages, and SVG views are deterministic for unchanged inputs.

## Acceptance checks

- [ ] `./tools/axiom/axiom graph && ./tools/axiom/axiom docs && ./tools/axiom/axiom check` passes.

## Out of scope

Live third-party web scraping; the legacy standalone Python `docshub.py` server was replaced by the unified Next.js workbench and Axiom cockpit.
