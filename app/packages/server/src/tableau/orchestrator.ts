// Spec: knowledge/components/goldfish.md

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  GOLDFISH_PERSONAS,
  inferVendorFamily,
  resolveEnabledOpenCodeModel,
  resolveWireApi,
  type AgentRoleId,
  type AutomatedReviewReport,
  type GoldfishFinding,
  type GoldfishPersonaId,
  type ModelAssignment,
  type ModelMixerConfig,
  type ProjectRecord,
  type ReleaseRecord,
  type TableauCard,
  type TableauColumn,
} from "@aeion-spec/shared";
import {
  buildAxiom03Document,
  validateAxiom03Spec,
} from "../axiom/compiler.ts";
import { StoreRepository, type StoredUserRecord } from "../db/repository.ts";
import {
  buildFeatureMarkdown,
  buildObservabilityBundle,
} from "../observability/exporter.ts";
import {
  runCrossFamilyReviewerAgent,
  runElephantInterviewTurn,
  runGoldfishSwarm,
  resolveAssignment,
} from "../relay/flue-runner.ts";

export function evaluateSatisfaction(card: TableauCard): boolean {
  const unresolvedBlockers = card.findings.some(
    (f) => f.severity === "BLOCKER" && !f.resolved,
  );
  const openBlockingDecisions = card.decisions.some(
    (d) => d.blocking && !d.resolved,
  );
  const unresolvedMajors = card.findings.filter(
    (f) => f.severity === "MAJOR" && !f.resolved,
  );
  return (
    card.goldfishRound >= 1 &&
    !unresolvedBlockers &&
    !openBlockingDecisions &&
    unresolvedMajors.length === 0
  );
}

export function computeMixerConfig(
  db: Database,
  userId: string,
  projectId: string,
  enabledOpenCodeModels?: readonly string[] | null,
): ModelMixerConfig {
  const raw = StoreRepository.getMixer(db, projectId);
  if (enabledOpenCodeModels && enabledOpenCodeModels.length > 0) {
    let healed = false;
    for (const role of ALL_AGENT_ROLES) {
      const assigned = raw[role];
      if (!assigned || assigned.provider !== "opencode-go") continue;
      const resolvedModel = resolveEnabledOpenCodeModel(role, assigned.modelId, enabledOpenCodeModels);
      if (resolvedModel !== assigned.modelId) {
        raw[role] = {
          ...assigned,
          modelId: resolvedModel,
          api: resolveWireApi("opencode-go", resolvedModel),
        };
        healed = true;
      }
    }
    if (healed) {
      StoreRepository.saveMixer(db, projectId, raw);
    }
  }
  const drafter = resolveAssignment(raw, "drafter");
  const reviewer = resolveAssignment(raw, "reviewer");
  const drafterFamily = inferVendorFamily(drafter.provider, drafter.modelId);
  const reviewerFamily = inferVendorFamily(reviewer.provider, reviewer.modelId);
  const crossFamilyEnforced = drafterFamily !== reviewerFamily;
  const keys = StoreRepository.listVaultKeys(db, userId);
  const configuredProviders = new Set(
    keys.filter((k) => k.purpose === "llm_provider").map((k) => k.provider),
  );

  const warnings: string[] = [];
  if (!crossFamilyEnforced) {
    warnings.push(
      `Cross-family warning: Drafter (${drafter.provider}/${drafter.modelId}) and Automated Reviewer (${reviewer.provider}/${reviewer.modelId}) share vendor family '${drafterFamily}'. Mix different families to eliminate correlated blind spots.`,
    );
  }
  const usedProviders = new Set<string>();
  usedProviders.add(resolveAssignment(raw, "elephant").provider);
  usedProviders.add(drafter.provider);
  usedProviders.add(reviewer.provider);
  for (const p of GOLDFISH_PERSONAS) {
    usedProviders.add(resolveAssignment(raw, p.roleId).provider);
  }
  if (process.env.AEION_LLM !== "mock") {
    for (const prov of usedProviders) {
      if (!configuredProviders.has(prov as never)) {
        warnings.push(
          `Assigned provider '${prov}' has no API key in Key Vault yet.`,
        );
      }
    }
  }

  const effectiveAssignments = Object.fromEntries(
    ALL_AGENT_ROLES.map((role) => {
      const resolved = resolveAssignment(raw, role);
      if (
        enabledOpenCodeModels &&
        enabledOpenCodeModels.length > 0 &&
        resolved.provider === "opencode-go"
      ) {
        const enabledId = resolveEnabledOpenCodeModel(role, resolved.modelId, enabledOpenCodeModels);
        return [
          role,
          {
            ...resolved,
            modelId: enabledId,
            api: resolveWireApi("opencode-go", enabledId),
          },
        ];
      }
      return [role, resolved];
    }),
  ) as Record<AgentRoleId, ModelAssignment>;

  return {
    projectId,
    assignments: raw,
    effectiveAssignments,
    crossFamilyEnforced,
    warnings,
    ...(enabledOpenCodeModels && enabledOpenCodeModels.length > 0
      ? { enabledOpenCodeModels: [...enabledOpenCodeModels] }
      : {}),
  };
}

const ALL_AGENT_ROLES: readonly AgentRoleId[] = [
  "elephant",
  "drafter",
  "reviewer",
  ...GOLDFISH_PERSONAS.map((p) => p.roleId),
];

function appendSystemSeedDecisionsIfEmpty(card: TableauCard): void {
  if (card.decisions.length === 0) {
    card.decisions.push({
      id: `DEC-${String(Math.floor(100 + Math.random() * 800))}`,
      question: `What explicit failure response & boundary invariant enforces '${card.title}' when untrusted input violates preconditions?`,
      rationale:
        "Rule 1 (aeion-observability): Every feature requires a fail-closed negative-control contract.",
      options: [
        "Fail closed with HTTP 400/403 and zero state mutation",
        "Quarantine payload and require explicit operator confirmation",
      ],
      chosenOption: null,
      answerText: null,
      blocking: true,
      resolved: false,
      raisedByPersona: "security",
    });
  }
  if (card.assumptions.length === 0) {
    card.assumptions.push({
      id: `ASM-${String(Math.floor(100 + Math.random() * 800))}`,
      statement: `Caller inputs to ${card.featureCode} arrive untrusted and require schema validation before execution.`,
      riskIfFalse: "high",
      status: "unverified",
      evidenceNote: "Validate during automated review negative-control suite.",
    });
  }
}

/** Apply owner decision answers and confirm unverified assumptions when at least one decision matches. */
export function applyDecisionAnswers(
  card: TableauCard,
  decisionAnswers?: Array<{
    decisionId: string;
    chosenOption?: string;
    answerText: string;
  }>,
): boolean {
  if (!decisionAnswers || decisionAnswers.length === 0) return false;
  let updatedAny = false;
  for (const ans of decisionAnswers) {
    const trimmed = ans.answerText.trim();
    if (!trimmed) continue;
    const dec = card.decisions.find((d) => d.id === ans.decisionId);
    if (dec) {
      dec.chosenOption = ans.chosenOption ?? dec.chosenOption;
      dec.answerText = trimmed;
      dec.resolved = true;
      updatedAny = true;
    }
  }
  if (!updatedAny) return false;
  for (const asm of card.assumptions) {
    if (asm.status === "unverified") {
      asm.status = "confirmed";
    }
  }
  return true;
}

export async function startOrContinueInterview(params: {
  ctx: { db: Database; rootKey: Buffer; user: StoredUserRecord };
  project: ProjectRecord;
  release: ReleaseRecord;
  card: TableauCard;
  userMessage: string;
  decisionAnswers?: Array<{
    decisionId: string;
    chosenOption?: string;
    answerText: string;
  }>;
  personas?: GoldfishPersonaId[];
  onEvent?: (evt: Record<string, unknown>) => void;
}): Promise<TableauCard> {
  const {
    ctx,
    project,
    release,
    card,
    userMessage,
    decisionAnswers,
    personas,
    onEvent,
  } = params;
  const now = new Date().toISOString();

  if (personas && personas.length > 0) {
    card.activePersonas = Array.from(new Set(personas));
  }
  appendSystemSeedDecisionsIfEmpty(card);

  // Apply explicit user decision answers and interview clarifications BEFORE running fresh Goldfish sweep
  const hasClarification = Boolean(
    (decisionAnswers && decisionAnswers.length > 0) ||
      (userMessage.trim().length >= 25 && card.goldfishRound >= 1),
  );
  applyDecisionAnswers(card, decisionAnswers);
  if (hasClarification) {
    const resolutionText =
      decisionAnswers && decisionAnswers.length > 0
        ? `Resolved via ${decisionAnswers.map((a) => a.decisionId).join(", ")} and owner clarifications.`
        : `Clarified by owner: ${userMessage.replace(/\s+/g, " ").trim().slice(0, 120)}`;
    for (const finding of card.findings) {
      if (!finding.resolved) {
        finding.resolved = true;
        finding.resolutionNote = resolutionText;
      }
    }
  }

  // Only mark user message if non-empty
  if (userMessage.trim()) {
    card.messages.push({
      id: `msg_${randomUUID()}`,
      role: "user",
      persona: null,
      round: card.goldfishRound,
      content: userMessage.trim(),
      modelUsed: null,
      contextIsolated: false,
      createdAt: now,
    });
  }

  const allCards = StoreRepository.listCards(ctx.db, project.id, release.id);
  const seq = Math.max(
    1,
    allCards.findIndex((c) => c.id === card.id) + 1,
  );
  card.draftMarkdown = buildFeatureMarkdown({
    project,
    release,
    card,
    sequence: seq,
  });

  const mixer = StoreRepository.getMixer(ctx.db, project.id);

  onEvent?.({ type: "phase", step: "elephant", message: "Elephant anchoring hypothesis..." });
  const elephantTurn = await runElephantInterviewTurn({
    project,
    card,
    userMessage:
      userMessage.trim() ||
      `Begin structured Goldfish interview for ${card.featureCode}: ${card.title}.`,
    mixer,
    ctx,
    onEvent,
  });

  card.messages.push({
    id: `msg_${randomUUID()}`,
    role: "elephant",
    persona: null,
    round: card.goldfishRound + 1,
    content: elephantTurn.reply,
    modelUsed: elephantTurn.modelUsed,
    contextIsolated: false,
    createdAt: new Date().toISOString(),
  });

  onEvent?.({
    type: "phase",
    step: "goldfish_swarm",
    personas: card.activePersonas,
    message: `Launching ${card.activePersonas.length} fresh zero-history Goldfish personas...`,
  });

  const swarm = await runGoldfishSwarm({
    project,
    card,
    personas: card.activePersonas,
    mixer,
    ctx,
    onEvent,
  });

  card.goldfishRound += 1;

  // Append genuinely new challenges deduplicated by persona + challenge prefix
  const existingKeys = new Set(
    card.findings.map((f) => `${f.persona}:${f.challenge.slice(0, 64).toLowerCase()}`),
  );
  for (const nf of swarm.findings) {
    const dedupeKey = `${nf.persona}:${nf.challenge.slice(0, 64).toLowerCase()}`;
    if (!existingKeys.has(dedupeKey)) {
      existingKeys.add(dedupeKey);
      card.findings.push(nf);
    } else if (!nf.resolved) {
      const match = card.findings.find(
        (f) => `${f.persona}:${f.challenge.slice(0, 64).toLowerCase()}` === dedupeKey,
      );
      // A fresh Goldfish that still raises the point after a clarification means it is not resolved.
      if (match) {
        match.challenge = nf.challenge;
        match.severity = nf.severity;
        match.resolved = false;
        match.resolutionNote = null;
      }
    }
    card.messages.push({
      id: `msg_${randomUUID()}`,
      role: "goldfish",
      persona: nf.persona,
      round: card.goldfishRound,
      content: `[${nf.severity}] ${nf.title}: ${nf.challenge}`,
      modelUsed: swarm.modelByPersona[nf.persona] ?? null,
      contextIsolated: true,
      createdAt: new Date().toISOString(),
    });
  }

  if (swarm.findings.length === 0) {
    card.messages.push({
      id: `msg_${randomUUID()}`,
      role: "goldfish",
      persona: null,
      round: card.goldfishRound,
      content:
        "All active Goldfish personas inspected the latest specification draft cleanly with fresh context: 0 unresolved blockers remaining.",
      modelUsed: null,
      contextIsolated: true,
      createdAt: new Date().toISOString(),
    });
  }

  // Refresh compiled draftMarkdown after interview findings/decisions
  card.draftMarkdown = buildFeatureMarkdown({
    project,
    release,
    card,
    sequence: seq,
  });
  card.goldfishSatisfied = evaluateSatisfaction(card);
  invalidateReview(card);
  StoreRepository.saveCard(ctx.db, card);
  return card;
}

// Changed content voids an earlier approval: the card leaves review or validation until it passes again.
export function invalidateReview(card: TableauCard): void {
  card.reviewPassed = false;
  if (card.column === "automated_review" || card.column === "validated") {
    card.column = "goldfish_interview";
  }
}

export async function runAutomatedReviewPipeline(params: {
  ctx: { db: Database; rootKey: Buffer; user: StoredUserRecord };
  project: ProjectRecord;
  release: ReleaseRecord;
  card: TableauCard;
  onEvent?: (evt: Record<string, unknown>) => void;
}): Promise<TableauCard> {
  const { ctx, project, release, card, onEvent } = params;
  const allCards = StoreRepository.listCards(ctx.db, project.id, release.id);
  const seq = Math.max(
    1,
    allCards.findIndex((c) => c.id === card.id) + 1,
  );
  card.draftMarkdown = buildFeatureMarkdown({
    project,
    release,
    card,
    sequence: seq,
  });

  const mixer = StoreRepository.getMixer(ctx.db, project.id);

  // 1. Build & validate Observability export bundle + Manifesto
  onEvent?.({
    type: "progress",
    step: "gates",
    message: "Checking Observability export budget and AxiomSpec G01-G14 gates...",
  });
  const obsBundle = buildObservabilityBundle({
    project,
    release,
    cards: allCards.map((c) => (c.id === card.id ? card : c)),
    focusCard: card,
  });

  // 2. Build & validate AxiomSpec 0.3 G01-G14 against python engine
  const axiomDoc = buildAxiom03Document({
    project,
    release,
    cards: [card],
  });
  const axiomReport = await validateAxiom03Spec(axiomDoc);

  // 3. Cross-family Automated Reviewer Agent
  onEvent?.({
    type: "progress",
    step: "reviewer",
    message: "Running independent cross-family automated reviewer...",
  });
  const reviewerOutcome = await runCrossFamilyReviewerAgent({
    project,
    card,
    markdown: obsBundle.feature.markdown,
    mixer,
    ctx,
  });

  // 4. Final fresh-context Goldfish Reassessment (Stage 5-9 verification)
  onEvent?.({
    type: "progress",
    step: "reassessment",
    message: "Running Stage 5-9 fresh-context Goldfish reassessment...",
  });
  const reassessment = await runGoldfishSwarm({
    project,
    card: { ...card, draftMarkdown: obsBundle.feature.markdown },
    personas: ["security", "architecture", "sre"],
    mixer,
    ctx,
    isReassessment: true,
  });

  const mechanicalErrors = [
    ...obsBundle.feature.errors,
    ...obsBundle.manifestErrors,
    ...axiomReport.errors,
  ];
  const unresolvedBlockers = reassessment.findings.filter(
    (f) => f.severity === "BLOCKER" && !f.resolved,
  );
  // A reassessment lens that never answered is unknown, and unknown never passes.
  const failedLenses = reassessment.findings.filter((f) => f.id.endsWith("-FAILED"));
  const passed =
    mechanicalErrors.length === 0 &&
    reviewerOutcome.verdict === "approve" &&
    unresolvedBlockers.length === 0 &&
    failedLenses.length === 0;

  const report: AutomatedReviewReport = {
    id: `rev_${randomUUID()}`,
    passed,
    ...reviewerOutcome,
    repairedAutomatically: false,
    axiomReport,
    observabilityBundle: obsBundle,
    goldfishReassessmentFindings: reassessment.findings,
    mechanicalErrors,
    reviewedAt: new Date().toISOString(),
  };

  card.latestReview = report;
  card.reviewPassed = passed;
  card.messages.push({
    id: `msg_${randomUUID()}`,
    role: "reviewer",
    persona: null,
    round: card.goldfishRound,
    content: `${passed ? "APPROVED" : "NEEDS ATTENTION"} (${reviewerOutcome.reviewerProvider}/${reviewerOutcome.reviewerModel}): ${reviewerOutcome.summary}`,
    modelUsed: `${reviewerOutcome.reviewerProvider}/${reviewerOutcome.reviewerModel}`,
    contextIsolated: true,
    createdAt: new Date().toISOString(),
  });
  StoreRepository.saveCard(ctx.db, card);
  onEvent?.({
    type: "progress",
    step: "saved",
    message: passed
      ? "Automated review passed."
      : "Automated review completed with items to address.",
  });
  return card;
}

export async function transitionTableauCard(params: {
  ctx: { db: Database; rootKey: Buffer; user: StoredUserRecord };
  project: ProjectRecord;
  release: ReleaseRecord;
  card: TableauCard;
  targetColumn: TableauColumn;
  position?: number;
  onEvent?: (evt: Record<string, unknown>) => void;
}): Promise<TableauCard> {
  const { ctx, project, release, card, targetColumn, position, onEvent } = params;

  if (targetColumn === card.column) {
    if (typeof position === "number") {
      card.position = position;
      StoreRepository.saveCard(ctx.db, card);
    }
    return card;
  }

  if (targetColumn === "archived") {
    card.column = "archived";
    card.reviewPassed = false;
    StoreRepository.saveCard(ctx.db, card);
    return card;
  }

  // An archived card can only come back as an idea.
  if (card.column === "archived" && targetColumn !== "idea") {
    throw new WorkflowGateError(`Restore ${card.featureCode} to Idea before moving it further.`);
  }

  if (targetColumn === "idea") {
    card.column = "idea";
    card.position = position ?? 0;
    StoreRepository.saveCard(ctx.db, card);
    return card;
  }

  if (targetColumn === "goldfish_interview") {
    card.column = "goldfish_interview";
    card.position = position ?? 0;
    StoreRepository.saveCard(ctx.db, card);
    if (card.goldfishRound === 0) {
      return await startOrContinueInterview({
        ctx,
        project,
        release,
        card,
        userMessage: `Start Goldfish adversarial interview on ${card.featureCode}: ${card.title}.`,
        onEvent,
      });
    }
    return card;
  }

  if (targetColumn === "automated_review") {
    if (!card.goldfishSatisfied || !card.userSatisfied) {
      throw new WorkflowGateError(
        `Cannot move ${card.featureCode} to Automated Review yet: requires BOTH Goldfish satisfaction (${card.goldfishSatisfied ? "met" : "pending open blockers/decisions"}) AND explicit User satisfaction (${card.userSatisfied ? "confirmed" : "not confirmed"}).`,
      );
    }
    const previousColumn = card.column;
    const previousPosition = card.position;
    card.column = "automated_review";
    card.position = position ?? 0;
    StoreRepository.saveCard(ctx.db, card);
    try {
      return await runAutomatedReviewPipeline({
        ctx,
        project,
        release,
        card,
        onEvent,
      });
    } catch (err) {
      // A review that never ran must not leave the card parked in the review column.
      card.column = previousColumn;
      card.position = previousPosition;
      StoreRepository.saveCard(ctx.db, card);
      throw err;
    }
  }

  if (targetColumn === "validated") {
    if (!card.goldfishSatisfied || !card.userSatisfied || !card.reviewPassed) {
      throw new WorkflowGateError(
        `Cannot validate ${card.featureCode}: Automated Review & G01-G14 checks must pass after Dual Satisfaction.`,
      );
    }
    card.column = "validated";
    card.position = position ?? 0;
    const allCards = StoreRepository.listCards(ctx.db, project.id, release.id);
    const seq = Math.max(
      1,
      allCards.findIndex((c) => c.id === card.id) + 1,
    );
    card.draftMarkdown = buildFeatureMarkdown({
      project,
      release,
      card,
      sequence: seq,
    });
    StoreRepository.saveCard(ctx.db, card);
    return card;
  }

  throw new WorkflowGateError(`Unsupported target column: ${targetColumn}`);
}

export class WorkflowGateError extends Error {
  readonly status = 409;
}
