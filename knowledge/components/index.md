---
type: Reference
title: "Components index"
description: "One spec per unit."
status: stable
generated:
  by: aeion-factory/1.0
  at: 2026-10-20T00:00:00Z
---

# Components

One doc per unit, in the spec format of [../policies/specs-first.md](../policies/specs-first.md).
Start from [the template](_template.md).

| Component | Status | Notes |
| --- | --- | --- |
| [Integration choices](context-and-architecture.md) | stable | scoped upstream adoption and runtime qualification boundaries |
| [Æion Factory architecture](factory-architecture.md) | stable | complete spec; its diagrams are in the [cockpit](../../docs/README.md) |
| [Axiom toolkit](axiom-toolkit.md) | stable | `tools/axiom/axiom`: AxiomSpec gates, knowledge graph, queries, packets, views, cockpit, export, evidence |
| [aeion-spec engine](aeion-engine.md) | stable | `app/packages/server`: Elysia API, SQLite store, Vault, ContextRelay, Axiom03 bridge |
| [Flue agents](aeion-agents.md) | stable | `app/packages/flue` & `app/packages/shared`: Pi + Flue agents, LiteLLM routing, tools, skills |
| [Brainstorm and design](goldfish.md) | stable | Elephant-Goldfish Model tableau orchestration, isolated fresh reviews, dual satisfaction |
| [Spec studio](spec-studio.md) | stable | Next.js Atelier UI, AxiomSpec 0.3 G01-G14 checks, Observability export, release sealing |
| [Documentation hub](docs-hub.md) | stable | AxiomSpec knowledge graph, generated cockpit diagrams, and Studio reference views |
