---
type: Reference
title: "Components index"
description: "One spec per unit."
status: stable
generated:
  by: aeion-template/1.0
  at: 2026-10-20T00:00:00Z
---

# Components

One doc per unit, in the spec format of [../policies/specs-first.md](../policies/specs-first.md).
Start from [the template](_template.md).

| Component | Status | Notes |
| --- | --- | --- |
| [Integration choices](context-and-architecture.md) | stable | scoped upstream adoption and runtime qualification boundaries |
| [Æion Template architecture](template-architecture.md) | stable | complete spec, with its diagrams |
| [Framework mode and the owner's settings](framework-mode.md) | draft | the doc gate's mode and the aeion-framework address; off by default |
| [Doc gate](doc-gate.md) | draft | the docs covering a file are read before it is edited; enforce, warn or off |
| [aeion-spec engine](aeion-engine.md) | stable | `app/packages/server`: Elysia API, SQLite store, Vault, ContextRelay, Axiom03 bridge |
| [Flue agents](aeion-agents.md) | stable | `app/packages/flue` & `app/packages/shared`: Pi + Flue agents, LiteLLM routing, tools, skills |
| [Brainstorm and design](goldfish.md) | stable | Elephant-Goldfish Model tableau orchestration, isolated fresh reviews, dual satisfaction |
| [Spec studio](spec-studio.md) | stable | Next.js glass UI, AxiomSpec 0.3 G01-G14 checks, Observability export, release sealing |
| [OpenShell quarantine](openshell.md) | stable | `app/openshell/`: archive and GitHub quarantine, secret scrubbing, read-only snapshots |
| [Documentation hub](docs-hub.md) | deprecated | the generated `docs/` cockpit, frozen since its engine left in 4.0.3 |
