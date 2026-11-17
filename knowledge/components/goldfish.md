---
type: Component
title: "Brainstorm and design (Elephant-Goldfish Model)"
description: "Jira-like Tableau orchestration: Elephant interrogates feature cards while 8 fresh isolated Goldfish personas challenge independently until dual satisfaction permits Automated Review."
status: stable
sources:
  - resource: ../../app/packages/server/src/tableau/orchestrator.ts
    title: "Tableau state transitions, Elephant-Goldfish rounds, satisfaction evaluation, and Stage 5-9 reassessment"
  - resource: ../../app/packages/flue/upstream/NOTICE.md
    title: "Vendored Elephant-Goldfish Model (Apache-2.0)"
  - resource: ../../app/packages/flue/src/agents/elephant.ts
    title: "Elephant interview agent"
  - resource: ../../app/packages/flue/src/agents/goldfish.ts
    title: "Fresh zero-history Goldfish reviewer agent"
  - resource: ../../app/packages/flue/src/agents/reviewer.ts
    title: "Cross-family Automated Reviewer agent"
  - resource: ../../app/packages/server/test/platform.test.ts
    title: "Dual-satisfaction and workflow transition tests"
---

# Brainstorm and design

## Intent

Embed the [Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model) directly into
a Jira-style Release Tableau (`Idea` → `Goldfish Interview` → `Automated Review` → `Validated`): the
Elephant holds conversation context and probes ambiguities against the project source in OpenShell, while
eight fresh zero-history Goldfish personas (`pm`, `security`, `sre`, `ux`, `architecture`, `finops`,
`legal`, `devil`) evaluate only the generated feature specification without anchor bias.

## Data sources

The vendored upstream personas and skills in `app/packages/flue/upstream` and `app/packages/flue/src/skills/`,
owner interview messages, `DEC-*` answers, and read-only OpenShell slices.

## Inputs

- Moving a card from `idea` to `goldfish_interview`, or posting an interview turn / SSE stream turn with
  clarifications, settled `DEC-*` answers, and optional manual finding resolutions (`PATCH /cards/:cardId`,
  including direct `decisionAnswers` edits via `applyDecisionAnswers()`).
- Moving to `automated_review` (requires both `goldfishSatisfied` and `userSatisfied`) or invoking
  `POST /api/projects/:projectId/cards/:cardId/review/stream` for SSE-progress review (`transitionTableauCard` /
  `runAutomatedReviewPipeline`), followed by move to `validated`.

## Outputs

Deduplicated Goldfish findings (`BLOCKER`/`MAJOR`/`NIT`), extracted `DEC-*` owner questions, updated
`draftMarkdown` specs, and cross-family Automated Review + Stage 5-9 reassessment reports.

## Invariants

- Each Goldfish call receives only the current specification and its persona lens, never conversation history.
- Every finding carries stable `GF-*` identity; owner clarifications and explicit resolutions mark prior
  matching findings resolved while re-evaluating remaining `BLOCKER` status before transition to review.
  A resolved finding that a later round raises again reopens.
- Answering a `DEC-*` decision via `applyDecisionAnswers()` (either inside an interview turn or directly via
  `PATCH /cards/:cardId`) also confirms the card's unverified assumptions; the drawer lets owners both answer
  open decisions and edit already settled `DEC-*` answers.
- A reassessment lens that fails blocks the review instead of passing it; a failed review puts the card
  back in the column it came from.
- An archived card can only be restored to `idea`.
- Transition to `validated` requires `reviewPassed === true` (zero unresolved blockers across Stage 5-9,
  cross-family reviewer approval, AxiomSpec 0.3 G01-G14 pass, and Observability export validity).
- `computeMixerConfig` resolves disabled OpenCode Go models against the customer's enabled `/v1/models` list
  before evaluating cross-family separation.
- `buildFeatureMarkdown` includes settled `DEC-*` resolution text inline under `Decision Status` (`RESOLVED: <answer>`),
  and follow-up/reassessment Goldfish rounds (`goldfishRound >= 1` or Stage 5-9 reassessment) instruct each lens to
  verify resolved objections against declared scope and emit `[BLOCKER]`/`[MAJOR]` only for remaining critical gaps.

## Determinism

Column state transitions, `evaluateSatisfaction()`, and Axiom/Observability gate checks are deterministic;
only agent critique text varies in live mode.

## Acceptance checks

- [ ] A card cannot advance to `automated_review` until both Goldfish (0 open blockers) and Owner confirm satisfaction.
- [ ] A live Goldfish + cross-family Claude Haiku review run completes cleanly via Flue + LiteLLM.

## Out of scope

Editing upstream Google personas in place or letting Goldfish read conversational history.
