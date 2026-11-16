// Spec: knowledge/components/aeion-agents.md

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import {
  formatLitellmModelId,
  GOLDFISH_PERSONAS,
  inferVendorFamily,
  PROVIDER_CATALOG,
  type AgentRoleId,
  type AutomatedReviewReport,
  type GoldfishFinding,
  type GoldfishPersonaId,
  type LlmProviderId,
  type ModelAssignment,
  type ProjectRecord,
  type TableauCard,
} from "@aeion-spec/shared";
import { StoreRepository, type StoredUserRecord } from "../db/repository.ts";
import {
  ensureLoopbackRelayServer,
  registerRelayRun,
  releaseRelayRun,
} from "./context-relay.ts";

const APP_ROOT = resolve(import.meta.dir, "../../../..");
const FLUE_DIR = resolve(APP_ROOT, "packages/flue");
const FLUE_BIN = resolve(FLUE_DIR, "node_modules/.bin/flue");
const UPSTREAM_DIR = resolve(FLUE_DIR, "upstream");

const PERSONA_UPSTREAM_FILE: Record<GoldfishPersonaId, string> = {
  pm: "zoom_out.md",
  security: "design_critic.md",
  sre: "implementation_readiness.md",
  ux: "comprehension.md",
  architecture: "structural.md",
  finops: "inventive_catalyst.md",
  legal: "codebase_details.md",
  devil: "style.md",
};

export class MissingVaultCredentialError extends Error {
  readonly status = 428;
  constructor(
    readonly provider: LlmProviderId,
    readonly role: AgentRoleId,
  ) {
    super(
      `Role '${role}' is mapped to ${PROVIDER_CATALOG[provider].label}, but no API key for '${provider}' is stored in your Key Vault.`,
    );
  }
}

export function resolveAssignment(
  mixer: Partial<Record<AgentRoleId, ModelAssignment>>,
  role: AgentRoleId,
): ModelAssignment {
  const explicit = mixer[role];
  if (explicit) return explicit;
  const fallbackRole: AgentRoleId = role.startsWith("goldfish:")
    ? "goldfish:security"
    : "elephant";
  const fromFallback = mixer[fallbackRole] ?? mixer.elephant;
  if (fromFallback) {
    return { ...fromFallback, role };
  }
  return {
    role,
    provider: "openai",
    modelId: "gpt-4.1-mini",
    api: "openai-completions",
    temperature: 0.2,
    thinkingLevel: "medium",
  };
}

export function checkVaultReadiness(
  db: Database,
  userId: string,
  assignment: ModelAssignment,
): void {
  if (process.env.AEION_LLM === "mock") return;
  const keys = StoreRepository.listVaultKeys(db, userId);
  const hasKey = keys.some(
    (k) => k.purpose === "llm_provider" && k.provider === assignment.provider,
  );
  if (!hasKey) {
    throw new MissingVaultCredentialError(assignment.provider, assignment.role);
  }
}

type SubmissionSchema = {
  type?: string;
  required?: string[];
  properties?: Record<string, { type?: string; enum?: unknown[] }>;
};

// Free-form conversation tools the agents declare without a server schema.
const CONVERSATION_TOOLS = new Set(["ask_owner", "anchor_hypothesis"]);

// The agent validates too, but its output is untrusted: re-check names, required fields, types and enums.
export function checkSubmission(
  schemas: Record<string, unknown>,
  name: string,
  payload: unknown,
): { ok: boolean; error?: string } {
  if (CONVERSATION_TOOLS.has(name)) return { ok: true };
  const schema = schemas[name] as SubmissionSchema | undefined;
  if (!schema) return { ok: false, error: `Unknown submission '${name}'.` };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: `${name} must be an object.` };
  }
  const record = payload as Record<string, unknown>;
  for (const field of schema.required ?? []) {
    if (record[field] === undefined) return { ok: false, error: `${name} is missing '${field}'.` };
  }
  for (const [field, rule] of Object.entries(schema.properties ?? {})) {
    const value = record[field];
    if (value === undefined) continue;
    if (rule.enum && !rule.enum.includes(value)) {
      return { ok: false, error: `${name}.${field} must be one of ${rule.enum.join(", ")}.` };
    }
    const actual = Array.isArray(value) ? "array" : typeof value;
    if (rule.type === "string" && actual !== "string") return { ok: false, error: `${name}.${field} must be a string.` };
    if (rule.type === "array" && actual !== "array") return { ok: false, error: `${name}.${field} must be an array.` };
  }
  return { ok: true };
}

interface FlueRunOptions {
  agentRelPath: string;
  userId: string;
  projectId: string;
  role: AgentRoleId;
  assignment: ModelAssignment;
  message: string;
  blocks: Array<{ tag: string; body: string; trust?: "owner" | "untrusted-data" }>;
  schemas?: Record<string, unknown>;
  persona?: string;
  hasSandbox?: boolean;
  ctx: { db: Database; rootKey: Buffer; user: StoredUserRecord };
  onEvent?: (evt: Record<string, unknown>) => void;
}

export async function invokeFlueAgent(
  opts: FlueRunOptions,
): Promise<{ text: string; submissions: Record<string, unknown>; modelLabel: string }> {
  const relayPort = ensureLoopbackRelayServer();
  const run = registerRelayRun({
    userId: opts.userId,
    projectId: opts.projectId,
    role: opts.role,
    provider: opts.assignment.provider,
    modelId: opts.assignment.modelId,
    ctx: opts.ctx,
    submissionsValidator: (name, payload) => checkSubmission(opts.schemas ?? {}, name, payload),
  });

  const tmpDir = mkdtempSync(join(tmpdir(), "aeion-flue-"));
  const inputPath = join(tmpDir, "input.json");
  const eventsPath = join(tmpDir, "events.jsonl");

  writeFileSync(
    inputPath,
    JSON.stringify({
      blocks: opts.blocks,
      schemas: opts.schemas ?? {},
      persona: opts.persona,
      hasSandbox: Boolean(opts.hasSandbox),
    }),
    { mode: 0o600 },
  );

  // Use OpenAI completions wire format across LiteLLM so all 7 providers share streaming + tool schemas uniformly
  const modelJson = JSON.stringify({
    provider: opts.assignment.provider,
    id: opts.assignment.modelId,
    name: `${opts.assignment.provider}/${opts.assignment.modelId}`,
    api: "openai-completions",
    context: 200000,
    input: 0,
    output: 0,
    cacheRead: 0,
    maxOutputTokens: 8192,
  });

  const childEnv: Record<string, string> = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME || tmpDir,
    AEION_RELAY_URL: `http://127.0.0.1:${relayPort}/relay/${run.runId}/v1`,
    AEION_BRIDGE_URL: `http://127.0.0.1:${relayPort}/relay/${run.runId}/bridge`,
    AEION_RELAY_TOKEN: run.token,
    AEION_INPUT: inputPath,
    AEION_EVENTS_FILE: eventsPath,
    AEION_MODEL_JSON: modelJson,
    AEION_UPSTREAM: UPSTREAM_DIR,
  };

  let eventCursor = 0;
  let watcherTimer: ReturnType<typeof setInterval> | null = null;
  // Only complete lines are consumed: a trailing line without its newline is still being written.
  const drainEvents = (final: boolean) => {
    if (!opts.onEvent || !existsSync(eventsPath)) return;
    const content = readFileSync(eventsPath, "utf8");
    const parts = content.split("\n");
    const complete = final ? parts : parts.slice(0, -1);
    while (eventCursor < complete.length) {
      const line = complete[eventCursor]!.trim();
      eventCursor++;
      if (!line) continue;
      try {
        opts.onEvent(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // A malformed complete line is skipped; it can never become valid later.
      }
    }
  };
  if (opts.onEvent) {
    watcherTimer = setInterval(() => drainEvents(false), 150);
  }

  try {
    const proc = Bun.spawn(
      [FLUE_BIN, "run", opts.agentRelPath, "--message", opts.message, "--json"],
      {
        cwd: FLUE_DIR,
        env: childEnv,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0 && run.submissions.size === 0) {
      throw new Error(
        `Flue agent (${opts.role}) failed (${exitCode}): ${stderr.slice(0, 400) || stdout.slice(0, 400)}`,
      );
    }
    let text = stdout.trim();
    try {
      const parsed = JSON.parse(stdout) as { reply?: string; text?: string; message?: string };
      text = parsed.reply || parsed.text || parsed.message || text;
    } catch {
      // Plain text fallback
    }
    return {
      text,
      submissions: Object.fromEntries(run.submissions.entries()),
      modelLabel: formatLitellmModelId(opts.assignment.provider, opts.assignment.modelId),
    };
  } finally {
    if (watcherTimer) clearInterval(watcherTimer);
    drainEvents(true);
    releaseRelayRun(run.runId);
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function runElephantInterviewTurn(params: {
  project: ProjectRecord;
  card: TableauCard;
  userMessage: string;
  mixer: Partial<Record<AgentRoleId, ModelAssignment>>;
  ctx: { db: Database; rootKey: Buffer; user: StoredUserRecord };
  onEvent?: (evt: Record<string, unknown>) => void;
}): Promise<{ reply: string; modelUsed: string }> {
  const assignment = resolveAssignment(params.mixer, "elephant");
  checkVaultReadiness(params.ctx.db, params.ctx.user.id, assignment);

  if (process.env.AEION_LLM === "mock") {
    const openBlocking = params.card.decisions.filter((d) => d.blocking && !d.resolved);
    const question =
      openBlocking.length > 0
        ? `Please settle **${openBlocking[0]!.id}** (${openBlocking[0]!.question}) — specifically, what fail-closed error status and audit invariant should enforce this boundary?`
        : `What explicit negative-control input must **${params.card.featureCode}: ${params.card.title}** reject without mutating state, and is its write scope restricted strictly to \`${params.card.writePaths.join(", ") || "src/"}\`?`;
    return {
      modelUsed: formatLitellmModelId(assignment.provider, assignment.modelId),
      reply: `Elephant stress-test on **${params.card.featureCode}** (${
        params.project.sourceKind === "empty"
          ? "greenfield spec mode"
          : `OpenShell ${params.project.openshellSummary?.mode ?? "quarantined"} workspace`
      }):\n\nI anchored your latest input against the feature scope and threat boundary. Before finalizing with the Goldfish swarm:\n\n${question}`,
    };
  }

  const historySummary = params.card.messages
    .slice(-12)
    .map((m) => `[${m.role}${m.persona ? `/${m.persona}` : ""}]: ${m.content}`)
    .join("\n\n");

  const res = await invokeFlueAgent({
    agentRelPath: "src/agents/elephant.ts",
    userId: params.ctx.user.id,
    projectId: params.project.id,
    role: "elephant",
    assignment,
    message: params.userMessage,
    hasSandbox: params.project.sourceKind !== "empty",
    blocks: [
      {
        tag: "feature_brief",
        trust: "untrusted-data",
        body: `Code: ${params.card.featureCode}\nTitle: ${params.card.title}\nArea: ${params.card.area}\nWrite paths: ${params.card.writePaths.join(", ")}\nSummary:\n${params.card.summary}`,
      },
      ...(historySummary
        ? [{ tag: "conversation", trust: "untrusted-data" as const, body: historySummary }]
        : []),
    ],
    ctx: params.ctx,
    onEvent: params.onEvent,
  });

  return {
    reply: res.text,
    modelUsed: res.modelLabel,
  };
}

export async function runGoldfishSwarm(params: {
  project: ProjectRecord;
  card: TableauCard;
  personas: GoldfishPersonaId[];
  mixer: Partial<Record<AgentRoleId, ModelAssignment>>;
  ctx: { db: Database; rootKey: Buffer; user: StoredUserRecord };
  onEvent?: (evt: Record<string, unknown>) => void;
}): Promise<{ findings: GoldfishFinding[]; modelByPersona: Record<string, string> }> {
  const { project, card, personas, mixer, ctx, onEvent } = params;
  const activePersonas = GOLDFISH_PERSONAS.filter((p) => personas.includes(p.id));
  const modelByPersona: Record<string, string> = {};

  if (process.env.AEION_LLM === "mock") {
    const resolvedDecisions = card.decisions.filter((d) => d.resolved).length;
    const findings: GoldfishFinding[] = [];
    for (const p of activePersonas) {
      const assignment = resolveAssignment(mixer, p.roleId);
      checkVaultReadiness(ctx.db, ctx.user.id, assignment);
      modelByPersona[p.id] = formatLitellmModelId(assignment.provider, assignment.modelId);
      onEvent?.({ type: "goldfish_persona", persona: p.id, model: modelByPersona[p.id] });

      // Generate constructive initial challenge on round 0 when decisions haven't been settled yet
      if (card.goldfishRound === 0 || (p.id === "security" && resolvedDecisions === 0)) {
        const isCriticalBlocker =
          (p.id === "security" || p.id === "architecture") &&
          !card.writePaths.length &&
          project.sourceKind !== "empty";
        findings.push({
          id: `GF-${card.goldfishRound + 1}-${p.id.toUpperCase()}`,
          persona: p.id,
          severity: isCriticalBlocker ? "BLOCKER" : p.id === "devil" || p.id === "legal" ? "NIT" : "MAJOR",
          title: `${p.label}: ${p.challengeFocus.split(" and ")[0]}`,
          claim: `Evaluated ${card.featureCode} strictly through the ${p.label} lens without session history.`,
          challenge: `Ensure ${card.featureCode} specifies an explicit negative-control refusal oracle and bounds under ${p.lens.toLowerCase()}.`,
          suggestedQuestion: `What deterministic failure response proves ${card.featureCode} preserves ${p.label.toLowerCase()} invariants?`,
          resolved: resolvedDecisions > 0,
          resolutionNote: resolvedDecisions > 0 ? "Addressed via settled DEC-* decision." : null,
        });
      }
    }
    return { findings, modelByPersona };
  }

  // A missing key must refuse the whole round before any persona spends tokens.
  const assignments = new Map(
    activePersonas.map((p) => [p.id, resolveAssignment(mixer, p.roleId)] as const),
  );
  for (const assignment of assignments.values()) {
    checkVaultReadiness(ctx.db, ctx.user.id, assignment);
  }

  // Fresh zero-history Goldfish runs in parallel; one failed persona must not sink the round.
  const allFindings: GoldfishFinding[] = [];
  const settled = await Promise.allSettled(
    activePersonas.map(async (p) => {
      const assignment = assignments.get(p.id)!;
      modelByPersona[p.id] = formatLitellmModelId(assignment.provider, assignment.modelId);
      onEvent?.({ type: "goldfish_persona", persona: p.id, model: modelByPersona[p.id] });

      const res = await invokeFlueAgent({
        agentRelPath: "src/agents/goldfish.ts",
        userId: ctx.user.id,
        projectId: project.id,
        role: p.roleId,
        assignment,
        persona: PERSONA_UPSTREAM_FILE[p.id],
        // Notice: Goldfish gets ZERO conversation history and ZERO sandbox tools
        message: `Attack feature ${card.featureCode} (${card.title}) strictly through the ${p.label} lens (${p.challengeFocus}). If the brief, Owner Clarifications, Settled Design Decisions, write_paths, and negative-control Verification already settle your lens without gaps or contradictions, respond ONLY with 'SATISFIED: 0 blockers, 0 major gaps.' Otherwise list concise concrete findings prefixed with [BLOCKER], [MAJOR], or [NIT].`,
        blocks: [
          {
            tag: "persona_lens",
            trust: "untrusted-data",
            body: `Persona: ${p.label}\nLens: ${p.lens}\nChallenge focus: ${p.challengeFocus}`,
          },
          {
            tag: "document",
            trust: "untrusted-data",
            body: card.draftMarkdown || `# ${card.featureCode}: ${card.title}\n\n${card.summary}`,
          },
        ],
        ctx,
        onEvent,
      });

      const lines = res.text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /\[(BLOCKER|MAJOR|NIT)\]/i.test(l));
      if (lines.length === 0 && res.text.trim() && !/no issues|looks good|satisfied|0 blockers/i.test(res.text)) {
        lines.push(`[MAJOR] ${res.text.trim().slice(0, 280)}`);
      }
      for (const [idx, rawLine] of lines.slice(0, 4).entries()) {
        const sevMatch = rawLine.match(/\[(BLOCKER|MAJOR|NIT)\]/i);
        const severity = (sevMatch?.[1]?.toUpperCase() as "BLOCKER" | "MAJOR" | "NIT") ?? "MAJOR";
        const body = rawLine
          .replace(/\[(BLOCKER|MAJOR|NIT)\]/i, "")
          .replace(/\*+/g, "")
          .replace(/^[-*•\d.)\s—–:]+/, "")
          .trim();
        if (
          !body ||
          /^(?:none|no\s+(?:blockers?|majors?|nits?|issues?|gaps?|findings?)|n\/a|0\s+(?:blockers?|issues?|gaps?))(?:\b|[.\s—–,:;]|$)/i.test(
            body,
          )
        ) {
          continue;
        }
        allFindings.push({
          id: `GF-${card.goldfishRound + 1}-${p.id.toUpperCase()}-${idx + 1}`,
          persona: p.id,
          severity,
          title: `${p.label}: ${body.slice(0, 48)}${body.length > 48 ? "..." : ""}`,
          claim: `Raised independently by fresh-context ${p.label} Goldfish.`,
          challenge: body,
          suggestedQuestion: `How does ${card.featureCode} resolve: ${body.slice(0, 140)}?`,
          resolved: false,
          resolutionNote: null,
        });
      }
    }),
  );

  // An unanswered lens is unknown, and unknown never reads as satisfied.
  for (const [idx, outcome] of settled.entries()) {
    if (outcome.status === "fulfilled") continue;
    const p = activePersonas[idx]!;
    const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    allFindings.push({
      id: `GF-${card.goldfishRound + 1}-${p.id.toUpperCase()}-FAILED`,
      persona: p.id,
      severity: "MAJOR",
      title: `${p.label}: review did not complete`,
      claim: `The ${p.label} Goldfish failed, so its lens is unverified.`,
      challenge: `Re-run the round once the model is reachable: ${reason.slice(0, 200)}`,
      suggestedQuestion: `Retry the ${p.label} review for ${card.featureCode}.`,
      resolved: false,
      resolutionNote: null,
    });
    onEvent?.({ type: "goldfish_persona_failed", persona: p.id, error: reason.slice(0, 200) });
  }

  return { findings: allFindings, modelByPersona };
}

export async function runCrossFamilyReviewerAgent(params: {
  project: ProjectRecord;
  card: TableauCard;
  markdown: string;
  mixer: Partial<Record<AgentRoleId, ModelAssignment>>;
  ctx: { db: Database; rootKey: Buffer; user: StoredUserRecord };
}): Promise<
  Pick<
    AutomatedReviewReport,
    | "reviewerProvider"
    | "reviewerModel"
    | "reviewerVendorFamily"
    | "drafterVendorFamily"
    | "crossFamilyVerified"
    | "summary"
    | "verdict"
  >
> {
  const reviewerAssign = resolveAssignment(params.mixer, "reviewer");
  const drafterAssign = resolveAssignment(params.mixer, "drafter");
  checkVaultReadiness(params.ctx.db, params.ctx.user.id, reviewerAssign);

  const reviewerFamily = inferVendorFamily(reviewerAssign.provider, reviewerAssign.modelId);
  const drafterFamily = inferVendorFamily(drafterAssign.provider, drafterAssign.modelId);
  const crossFamilyVerified = reviewerFamily !== drafterFamily;

  if (process.env.AEION_LLM === "mock") {
    return {
      reviewerProvider: reviewerAssign.provider,
      reviewerModel: reviewerAssign.modelId,
      reviewerVendorFamily: reviewerFamily,
      drafterVendorFamily: drafterFamily,
      crossFamilyVerified,
      verdict: "approve",
      summary: `Cross-family Automated Review (${reviewerFamily} reviewer vs ${drafterFamily} drafter) confirmed AxiomSpec 0.3 schema compliance, narrow write_paths, and explicit negative-control coverage.`,
    };
  }

  const reviewSchema = {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["approve", "revise", "block"] },
      summary: { type: "string" },
      defects: { type: "array", items: { type: "string" } },
      repair_hint: { type: "string" },
    },
    required: ["verdict", "summary", "defects"],
  };

  const res = await invokeFlueAgent({
    agentRelPath: "src/agents/reviewer.ts",
    userId: params.ctx.user.id,
    projectId: params.project.id,
    role: "reviewer",
    assignment: reviewerAssign,
    message: `Perform final adversarial automated review for ${params.card.featureCode}.`,
    schemas: { submit_review: reviewSchema },
    blocks: [
      {
        tag: "feature_markdown",
        trust: "untrusted-data",
        body: params.markdown,
      },
    ],
    ctx: params.ctx,
  });

  return {
    reviewerProvider: reviewerAssign.provider,
    reviewerModel: reviewerAssign.modelId,
    reviewerVendorFamily: reviewerFamily,
    drafterVendorFamily: drafterFamily,
    crossFamilyVerified,
    ...readReviewVerdict(res.submissions.submit_review, res.text),
  };
}

const REVIEW_VERDICTS = new Set(["approve", "revise", "block"]);

// Fail closed: only an explicit, well-formed approval approves.
export function readReviewVerdict(
  submission: unknown,
  fallbackText: string,
): { verdict: "approve" | "revise" | "block"; summary: string } {
  const payload = (submission && typeof submission === "object" ? submission : {}) as {
    verdict?: unknown;
    summary?: unknown;
  };
  const summary = typeof payload.summary === "string" && payload.summary.trim() ? payload.summary : "";
  if (typeof payload.verdict === "string" && REVIEW_VERDICTS.has(payload.verdict)) {
    return {
      verdict: payload.verdict as "approve" | "revise" | "block",
      summary: summary || fallbackText || "Automated cross-family review completed.",
    };
  }
  return {
    verdict: "revise",
    summary: `The reviewer returned no valid verdict, so the card is not approved. ${summary || fallbackText.slice(0, 400)}`.trim(),
  };
}
