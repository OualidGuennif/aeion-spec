// Spec: knowledge/components/aeion-engine.md

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cors } from "@elysiajs/cors";
import { Elysia, t } from "elysia";
import {
  ALL_PROVIDER_IDS,
  BuilderFeedbackSchema,
  CreateCardSchema,
  CreateProjectSchema,
  GOLDFISH_PERSONAS,
  InterviewTurnSchema,
  LoginBodySchema,
  MoveCardSchema,
  PROVIDER_CATALOG,
  RegisterBodySchema,
  resolveWireApi,
  SatisfyCardSchema,
  SaveModelMixerSchema,
  StoreVaultKeySchema,
  UpdateCardSchema,
  UpdateReleaseMetaSchema,
  ValidateReleaseSchema,
  type AgentRoleId,
  type ModelAssignment,
} from "@aeion-spec/shared";
import {
  AuthConflictError,
  buildSessionCookieHeader,
  clearSessionCookieHeader,
  ForbiddenError,
  loginUser,
  registerUser,
  requireAuthContext,
  revokeSession,
  startInviteSession,
  UnauthorizedError,
} from "./auth/service.ts";
import {
  buildAxiom03Document,
  compareAxiom03Releases,
  signAndVerifyAxiom03Release,
  validateAxiom03Spec,
} from "./axiom/compiler.ts";
import { onInviteWorkspaceDestroyed, ReleaseNotActiveError, StoreRepository } from "./db/repository.ts";
import {
  buildFeatureMarkdown,
  buildObservabilityBundle,
} from "./observability/exporter.ts";
import {
  clearInviteSandboxes,
  ingestGithubSource,
  ingestUploadedArchive,
  listSandboxFiles,
  PayloadTooLargeError,
  probeOpenShellRuntime,
  readBoundedUploadBytes,
  readSandboxSlice,
} from "./openshell/service.ts";
import { MissingVaultCredentialError } from "./relay/flue-runner.ts";
import {
  computeMixerConfig,
  evaluateSatisfaction,
  invalidateReview,
  runAutomatedReviewPipeline,
  startOrContinueInterview,
  transitionTableauCard,
  WorkflowGateError,
} from "./tableau/orchestrator.ts";

// The first schema violation, in one line, instead of Elysia's full JSON dump.
function validationMessage(err: unknown): string {
  const all = (err as { all?: Array<{ path?: string; message?: string; summary?: string }> }).all;
  const first = Array.isArray(all) ? all[0] : undefined;
  if (!first) return "Invalid request.";
  const field = first.path ? first.path.replace(/^\//, "").replace(/\//g, ".") : "body";
  return `Invalid ${field}: ${first.summary ?? first.message ?? "unexpected value"}.`;
}

function mapErrorStatus(err: unknown, code?: string | number): { status: number; message: string } {
  if (code === "NOT_FOUND") return { status: 404, message: "Not found." };
  if (code === "VALIDATION") return { status: 422, message: validationMessage(err) };
  if (code === "PARSE") return { status: 400, message: "Request body could not be parsed." };
  // A programming error is ours, not the caller's: answer 500 without its internals.
  if (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError) {
    console.error(err);
    return { status: 500, message: "Unexpected server error." };
  }
  if (
    err instanceof AuthConflictError ||
    err instanceof UnauthorizedError ||
    err instanceof ForbiddenError ||
    err instanceof PayloadTooLargeError ||
    err instanceof MissingVaultCredentialError ||
    err instanceof WorkflowGateError ||
    err instanceof ReleaseNotActiveError ||
    err instanceof NotFoundError
  ) {
    return { status: err.status, message: err.message };
  }
  const msg = err instanceof Error ? err.message : "Unexpected server error";
  return { status: 400, message: msg };
}

// An invite's quarantined files live only in RAM and must go with its workspace, on logout or expiry.
onInviteWorkspaceDestroyed(clearInviteSandboxes);

function getActiveRelease(
  projectId: string,
  activeReleaseId: string | null,
  db: import("bun:sqlite").Database,
) {
  const releases = StoreRepository.listReleases(db, projectId);
  const rel =
    releases.find((r) => r.id === activeReleaseId) ??
    releases.find((r) => r.status === "active") ??
    releases[0];
  if (!rel) throw new Error("Project has no active release sheet.");
  return rel;
}

class NotFoundError extends Error {
  readonly status = 404;
}

// The repository's VERSION is the one release number; the health check reports it instead of a copy.
const APP_VERSION = (() => {
  try {
    return readFileSync(resolve(import.meta.dir, "../../../../VERSION"), "utf8").trim();
  } catch {
    return "unknown";
  }
})();

// Cards with a model run in flight (an interview turn or a review). The run saves the card it loaded
// when it ends, so a write that lands meanwhile would be silently overwritten; it is refused instead.
const cardsInFlight = new Set<string>();
// Active release sheets whose seal is running; their cards wait until it ends.
const releasesSealing = new Set<string>();

function assertCardIdle(card: { id: string; featureCode: string }): void {
  if (cardsInFlight.has(card.id)) {
    throw new WorkflowGateError(
      `${card.featureCode} is busy: an interview turn or a review is running. Try again when it ends.`,
    );
  }
}

// Holds the card for the whole run; the caller has already checked it is idle.
async function whileCardInFlight<T>(cardId: string, run: () => Promise<T>): Promise<T> {
  cardsInFlight.add(cardId);
  try {
    return await run();
  } finally {
    cardsInFlight.delete(cardId);
  }
}

// A card the caller may change: in this project, in the active release, not archived unless asked,
// and not in the middle of a model run.
function requireActiveCard(
  db: import("bun:sqlite").Database,
  project: { id: string; activeReleaseId: string | null },
  cardId: string,
  options: { allowArchived?: boolean } = {},
) {
  const release = getActiveRelease(project.id, project.activeReleaseId, db);
  const card = StoreRepository.getCard(db, project.id, cardId);
  if (!card) throw new NotFoundError("Card not found.");
  if (card.releaseId !== release.id) {
    throw new WorkflowGateError(`${card.featureCode} belongs to a sealed release and is read-only.`);
  }
  if (card.column === "archived" && !options.allowArchived) {
    throw new WorkflowGateError(`${card.featureCode} is archived; restore it to Idea first.`);
  }
  assertCardIdle(card);
  if (releasesSealing.has(release.id)) {
    throw new WorkflowGateError(`Release ${release.version} is being sealed; try again when it ends.`);
  }
  return { release, card };
}

// Semantic version order of "1.2.3" (a leading "v" is ignored).
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(".").map(Number);
  const pb = b.replace(/^v/i, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export const app = new Elysia({ name: "aeion-spec-api" })
  .use(
    cors({
      origin: [
        "http://localhost:4170",
        "http://127.0.0.1:4170",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
      ],
      credentials: true,
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Aeion",
        "X-CSRF-Token",
        "X-Aeion-Session",
      ],
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    }),
  )
  .onError(({ code, error, set }) => {
    const mapped = mapErrorStatus(error, code);
    set.status = mapped.status;
    return { error: mapped.message };
  })
  // Health & System Capabilities
  .get("/api/health", async () => {
    const openshell = await probeOpenShellRuntime();
    return {
      ok: true,
      service: "aeion-spec",
      version: APP_VERSION,
      axiomVersion: "axiomspec/0.3",
      llmMode: process.env.AEION_LLM === "mock" ? "mock" : "litellm",
      openshell,
    };
  })
  .get("/api/catalog", () => ({
    providers: ALL_PROVIDER_IDS.map((id) => PROVIDER_CATALOG[id]),
    personas: GOLDFISH_PERSONAS,
  }))
  // Auth + Dual Persistence Modes (Authenticated vs RAM-Only Invite Mode)
  .post(
    "/api/auth/register",
    async ({ body, set }) => {
      const res = await registerUser(body);
      set.headers["set-cookie"] = buildSessionCookieHeader(
        res.rawToken,
        7 * 24 * 60 * 60,
      );
      return {
        user: res.user,
        sessionToken: res.rawToken,
        builderTokenPlain: res.builderTokenPlain,
      };
    },
    { body: RegisterBodySchema },
  )
  .post(
    "/api/auth/login",
    async ({ body, set }) => {
      const res = await loginUser(body);
      set.headers["set-cookie"] = buildSessionCookieHeader(
        res.rawToken,
        7 * 24 * 60 * 60,
      );
      return { user: res.user, sessionToken: res.rawToken };
    },
    { body: LoginBodySchema },
  )
  .post("/api/auth/invite", ({ set }) => {
    const res = startInviteSession();
    set.headers["set-cookie"] = buildSessionCookieHeader(
      res.rawToken,
      2 * 60 * 60,
    );
    return {
      user: res.user,
      sessionToken: res.rawToken,
      builderTokenPlain: res.builderTokenPlain,
      ephemeralWarning:
        "Invite Mode active: all specs, cards, Goldfish interviews, and keys live strictly in encrypted RAM and are erased permanently when your session ends.",
    };
  })
  .get("/api/auth/session", ({ request }) => {
    const ctx = requireAuthContext(request.headers);
    return {
      user: {
        id: ctx.user.id,
        email: ctx.user.email,
        displayName: ctx.user.displayName,
        mode: ctx.user.mode,
        expiresAt: ctx.session.expiresAt,
        csrfToken: ctx.session.csrfToken,
        builderTokenPreview: ctx.user.builderTokenPreview,
      },
    };
  })
  .post("/api/auth/logout", ({ request, set }) => {
    // Revoking an invite session destroys its workspace; the teardown hook clears its sandboxes.
    revokeSession(request.headers);
    set.headers["set-cookie"] = clearSessionCookieHeader();
    return { ok: true };
  })
  .post("/api/auth/builder-token/rotate", ({ request }) => {
    const ctx = requireAuthContext(request.headers, { requireCsrf: true });
    return StoreRepository.rotateBuilderToken(ctx);
  })
  // Encrypted Key Vault (Never returns plaintext keys!)
  .get("/api/vault/keys", ({ request }) => {
    const ctx = requireAuthContext(request.headers);
    return { keys: StoreRepository.listVaultKeys(ctx.db, ctx.user.id) };
  })
  .post(
    "/api/vault/keys",
    ({ request, body }) => {
      const ctx = requireAuthContext(request.headers, { requireCsrf: true });
      const summary = StoreRepository.storeVaultKey(ctx, body);
      return { key: summary };
    },
    { body: StoreVaultKeySchema },
  )
  .delete(
    "/api/vault/keys/:keyId",
    ({ request, params }) => {
      const ctx = requireAuthContext(request.headers, { requireCsrf: true });
      const deleted = StoreRepository.deleteVaultKey(
        ctx.db,
        ctx.user.id,
        params.keyId,
      );
      return { deleted };
    },
    { params: t.Object({ keyId: t.String() }) },
  )
  // Multi-Project + 4 Source Ingestion Modes
  .get("/api/projects", ({ request }) => {
    const ctx = requireAuthContext(request.headers);
    return { projects: StoreRepository.listProjects(ctx.db, ctx.user.id) };
  })
  .post(
    "/api/projects",
    async ({ request, body, set }) => {
      const ctx = requireAuthContext(request.headers, { requireCsrf: true });
      if (body.sourceKind === "github_public" && !body.sourceRef) {
        set.status = 400;
        return { error: "Public GitHub URL is required for github_public source." };
      }
      if (body.sourceKind === "github_private" && !body.sourceRef) {
        set.status = 400;
        return { error: "Private GitHub URL is required for github_private source." };
      }
      const created = StoreRepository.createProject(ctx.db, ctx.user.id, {
        name: body.name,
        description: body.description ?? "",
        releaseTitle: body.releaseTitle ?? "Genesis Specification Release",
        releaseVersion: body.releaseVersion ?? "0.1.0",
        sourceKind: body.sourceKind,
        sourceRef: body.sourceRef ?? null,
        githubVaultKeyId: body.githubVaultKeyId ?? null,
        openshellSummary: null,
      });

      if (
        body.sourceKind === "github_public" ||
        body.sourceKind === "github_private"
      ) {
        let summary;
        try {
          if (body.sourceKind === "github_private") {
            const tokPromise = StoreRepository.withProviderSecret(
              ctx,
              {
                purpose: "github_readonly",
                provider: "github",
                keyId: body.githubVaultKeyId ?? null,
              },
              (ghToken) =>
                ingestGithubSource({
                  projectId: created.project.id,
                  sessionMode: ctx.user.mode,
                  ownerSessionId: ctx.session.id,
                  sourceKind: "github_private",
                  repoUrl: body.sourceRef!,
                  githubToken: ghToken,
                }),
            );
            summary = await tokPromise;
          } else {
            summary = await ingestGithubSource({
              projectId: created.project.id,
              sessionMode: ctx.user.mode,
              ownerSessionId: ctx.session.id,
              sourceKind: "github_public",
              repoUrl: body.sourceRef!,
            });
          }
        } catch (err) {
          // A project whose source never arrived would look ready but have nothing to read: undo it.
          StoreRepository.deleteProject(ctx.db, ctx.user.id, created.project.id);
          throw err;
        }
        StoreRepository.updateProjectOpenShell(ctx.db, created.project.id, summary);
        created.project.openshellSummary = summary;
      }

      return created;
    },
    { body: CreateProjectSchema },
  )
  .post("/api/projects/:projectId/source/upload", async ({ request, params, set }) => {
    const ctx = requireAuthContext(request.headers, { requireCsrf: true });
    const project = StoreRepository.getProject(ctx.db, ctx.user.id, params.projectId);
    if (!project) {
      set.status = 404;
      return { error: "Project not found." };
    }
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 105 * 1024 * 1024) {
      set.status = 413;
      return { error: "Upload exceeds strict 100 MiB archive limit." };
    }
    const form = await request.formData();
    const file = form.get("archive");
    if (!(file instanceof Blob)) {
      set.status = 400;
      return { error: "Missing 'archive' (.zip or .tar.gz) multipart field." };
    }
    const bytes = await readBoundedUploadBytes(file);
    const filename = file instanceof File ? file.name : "source.zip";
    const summary = await ingestUploadedArchive({
      projectId: project.id,
      sessionMode: ctx.user.mode,
      ownerSessionId: ctx.session.id,
      filename,
      archiveBytes: bytes,
    });
    StoreRepository.updateProjectOpenShell(ctx.db, project.id, summary);
    return { summary };
  })
  .get("/api/projects/:projectId/source/files", ({ request, params, set }) => {
    const ctx = requireAuthContext(request.headers);
    const project = StoreRepository.getProject(ctx.db, ctx.user.id, params.projectId);
    if (!project) {
      set.status = 404;
      return { error: "Project not found." };
    }
    return {
      openshellSummary: project.openshellSummary,
      files: listSandboxFiles(project.id),
    };
  })
  .get("/api/projects/:projectId/source/file", ({ request, params, query, set }) => {
    const ctx = requireAuthContext(request.headers);
    const project = StoreRepository.getProject(ctx.db, ctx.user.id, params.projectId);
    if (!project) {
      set.status = 404;
      return { error: "Project not found." };
    }
    const path = String((query as { path?: string }).path || "");
    const slice = readSandboxSlice(project.id, path, 1, 120);
    if (!slice) {
      set.status = 404;
      return { error: "File not found in quarantined OpenShell workspace." };
    }
    return slice;
  })
  // Model Mixer per Project (per role & individual Goldfish persona)
  .get("/api/projects/:projectId/mixer", ({ request, params, set }) => {
    const ctx = requireAuthContext(request.headers);
    const project = StoreRepository.getProject(ctx.db, ctx.user.id, params.projectId);
    if (!project) {
      set.status = 404;
      return { error: "Project not found." };
    }
    return computeMixerConfig(ctx.db, ctx.user.id, project.id);
  })
  .put(
    "/api/projects/:projectId/mixer",
    ({ request, params, body, set }) => {
      const ctx = requireAuthContext(request.headers, { requireCsrf: true });
      const project = StoreRepository.getProject(ctx.db, ctx.user.id, params.projectId);
      if (!project) {
        set.status = 404;
        return { error: "Project not found." };
      }
      const next: Partial<Record<AgentRoleId, ModelAssignment>> = {};
      for (const [roleKey, cfg] of Object.entries(body.assignments)) {
        const role = roleKey as AgentRoleId;
        next[role] = {
          role,
          provider: cfg.provider,
          modelId: cfg.modelId.trim(),
          api: resolveWireApi(cfg.provider, cfg.modelId.trim()),
          temperature: cfg.temperature ?? 0.2,
          thinkingLevel: cfg.thinkingLevel ?? "medium",
        };
      }
      StoreRepository.saveMixer(ctx.db, project.id, next);
      return computeMixerConfig(ctx.db, ctx.user.id, project.id);
    },
    { body: SaveModelMixerSchema },
  )
  // Jira-Like Tableau & Cards
  .get("/api/projects/:projectId/tableau", ({ request, params, set }) => {
    const ctx = requireAuthContext(request.headers);
    const project = StoreRepository.getProject(ctx.db, ctx.user.id, params.projectId);
    if (!project) {
      set.status = 404;
      return { error: "Project not found." };
    }
    const release = getActiveRelease(project.id, project.activeReleaseId, ctx.db);
    const releaseCards = StoreRepository.listCards(ctx.db, project.id, release.id);
    const cards = releaseCards.filter((c) => c.column !== "archived");
    const archivedCards = releaseCards.filter((c) => c.column === "archived");
    const releases = StoreRepository.listReleases(ctx.db, project.id);
    const mixer = computeMixerConfig(ctx.db, ctx.user.id, project.id);
    return { project, release, cards, archivedCards, releases, mixer };
  })
  .post(
    "/api/projects/:projectId/cards",
    ({ request, params, body, set }) => {
      const ctx = requireAuthContext(request.headers, { requireCsrf: true });
      const project = StoreRepository.getProject(ctx.db, ctx.user.id, params.projectId);
      if (!project) {
        set.status = 404;
        return { error: "Project not found." };
      }
      const release = getActiveRelease(project.id, project.activeReleaseId, ctx.db);
      const card = StoreRepository.createCard(ctx.db, {
        projectId: project.id,
        releaseId: release.id,
        title: body.title,
        summary: body.summary,
        area: body.area ?? "foundation",
        phase: body.phase ?? "P1",
        size: body.size ?? "M",
        writePaths: body.writePaths ?? [],
        dependsOn: body.dependsOn ?? [],
      });
      return { card };
    },
    { body: CreateCardSchema },
  )
  .patch(
    "/api/projects/:projectId/cards/:cardId",
    ({ request, params, body, set }) => {
      const ctx = requireAuthContext(request.headers, { requireCsrf: true });
      const project = StoreRepository.getProject(ctx.db, ctx.user.id, params.projectId);
      if (!project) {
        set.status = 404;
        return { error: "Project not found." };
      }
      const { release, card } = requireActiveCard(ctx.db, project, params.cardId);
      if (body.title !== undefined) card.title = body.title.trim();
      if (body.summary !== undefined) card.summary = body.summary.trim();
      if (body.area !== undefined) card.area = body.area.trim();
      if (body.phase !== undefined) card.phase = body.phase.trim();
      if (body.size !== undefined) card.size = body.size;
      if (body.writePaths !== undefined) card.writePaths = body.writePaths;
      if (body.dependsOn !== undefined) card.dependsOn = body.dependsOn;
      if (body.resolveFindingIds) {
        for (const item of body.resolveFindingIds) {
          const f = card.findings.find((x) => x.id === item.findingId);
          if (f) {
            f.resolved = true;
            f.resolutionNote = item.note.trim();
          }
        }
      }
      const allCards = StoreRepository.listCards(ctx.db, project.id, release.id);
      const seq = Math.max(1, allCards.findIndex((c) => c.id === card.id) + 1);
      card.draftMarkdown = buildFeatureMarkdown({ project, release, card, sequence: seq });
      card.goldfishSatisfied = evaluateSatisfaction(card);
      invalidateReview(card);
      StoreRepository.saveCard(ctx.db, card);
      return { card };
    },
    { body: UpdateCardSchema },
  )
  .post(
    "/api/projects/:projectId/cards/:cardId/move",
    async ({ request, params, body, set }) => {
      const ctx = requireAuthContext(request.headers, { requireCsrf: true });
      const project = StoreRepository.getProject(ctx.db, ctx.user.id, params.projectId);
      if (!project) {
        set.status = 404;
        return { error: "Project not found." };
      }
      const { release, card } = requireActiveCard(ctx.db, project, params.cardId, {
        allowArchived: true,
      });
      const updated = await whileCardInFlight(card.id, () =>
        transitionTableauCard({
          ctx,
          project,
          release,
          card,
          targetColumn: body.targetColumn,
          position: body.position,
        }),
      );
      return { card: updated };
    },
    { body: MoveCardSchema },
  )
  .post(
    "/api/projects/:projectId/cards/:cardId/interview",
    async ({ request, params, body, set }) => {
      const ctx = requireAuthContext(request.headers, { requireCsrf: true });
      const project = StoreRepository.getProject(ctx.db, ctx.user.id, params.projectId);
      if (!project) {
        set.status = 404;
        return { error: "Project not found." };
      }
      const { release, card } = requireActiveCard(ctx.db, project, params.cardId);
      if (card.column === "idea") {
        card.column = "goldfish_interview";
      }
      const updated = await whileCardInFlight(card.id, () =>
        startOrContinueInterview({
          ctx,
          project,
          release,
          card,
          userMessage: body.message,
          decisionAnswers: body.decisionAnswers,
          personas: body.personas,
        }),
      );
      return { card: updated };
    },
    { body: InterviewTurnSchema },
  )
  .post(
    "/api/projects/:projectId/cards/:cardId/interview/stream",
    ({ request, params, body, set }) => {
      const ctx = requireAuthContext(request.headers, { requireCsrf: true });
      const project = StoreRepository.getProject(ctx.db, ctx.user.id, params.projectId);
      if (!project) {
        set.status = 404;
        return { error: "Project not found." };
      }
      const { release, card } = requireActiveCard(ctx.db, project, params.cardId);
      if (card.column === "idea") card.column = "goldfish_interview";

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const push = (eventName: string, data: unknown) => {
            controller.enqueue(
              encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          };
          try {
            const updated = await whileCardInFlight(card.id, () =>
              startOrContinueInterview({
                ctx,
                project,
                release,
                card,
                userMessage: body.message,
                decisionAnswers: body.decisionAnswers,
                personas: body.personas,
                onEvent: (evt) => push("progress", evt),
              }),
            );
            push("complete", { card: updated });
          } catch (err) {
            push("error", {
              error: err instanceof Error ? err.message : "Interview failed",
            });
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    },
    { body: InterviewTurnSchema },
  )
  .post(
    "/api/projects/:projectId/cards/:cardId/satisfy",
    ({ request, params, body, set }) => {
      const ctx = requireAuthContext(request.headers, { requireCsrf: true });
      const project = StoreRepository.getProject(ctx.db, ctx.user.id, params.projectId);
      if (!project) {
        set.status = 404;
        return { error: "Project not found." };
      }
      const { card } = requireActiveCard(ctx.db, project, params.cardId);
      card.userSatisfied = body.userSatisfied;
      // Withdrawn satisfaction voids an approval reached on it.
      if (!body.userSatisfied) invalidateReview(card);
      if (body.note) {
        card.messages.push({
          id: `msg_${crypto.randomUUID()}`,
          role: "user",
          persona: null,
          round: card.goldfishRound,
          content: `[Satisfaction Update: ${body.userSatisfied ? "Satisfied" : "Needs Work"}] ${body.note}`,
          modelUsed: null,
          contextIsolated: false,
          createdAt: new Date().toISOString(),
        });
      }
      StoreRepository.saveCard(ctx.db, card);
      return { card };
    },
    { body: SatisfyCardSchema },
  )
  .post("/api/projects/:projectId/cards/:cardId/review", async ({ request, params, set }) => {
    const ctx = requireAuthContext(request.headers, { requireCsrf: true });
    const project = StoreRepository.getProject(ctx.db, ctx.user.id, params.projectId);
    if (!project) {
      set.status = 404;
      return { error: "Project not found." };
    }
    const { release, card } = requireActiveCard(ctx.db, project, params.cardId);
    // The same gate as the move to Automated Review: no paid reviewer run on a card nobody approved yet.
    if (!card.goldfishSatisfied || !card.userSatisfied) {
      throw new WorkflowGateError(
        `${card.featureCode} needs both the swarm and the owner satisfied before its review runs.`,
      );
    }
    const updated = await whileCardInFlight(card.id, () =>
      runAutomatedReviewPipeline({
        ctx,
        project,
        release,
        card,
      }),
    );
    return { card: updated };
  })
  // Release Metadata, Validate ("Clean the Sheet"), and Historical Releases Vault
  .patch(
    "/api/projects/:projectId/release",
    ({ request, params, body, set }) => {
      const ctx = requireAuthContext(request.headers, { requireCsrf: true });
      const project = StoreRepository.getProject(ctx.db, ctx.user.id, params.projectId);
      if (!project) {
        set.status = 404;
        return { error: "Project not found." };
      }
      const release = getActiveRelease(project.id, project.activeReleaseId, ctx.db);
      // The seal signs the header it read; a rename during it would mislabel the signed snapshot.
      if (releasesSealing.has(release.id)) {
        throw new WorkflowGateError(`Release ${release.version} is being sealed; try again when it ends.`);
      }
      StoreRepository.updateActiveReleaseMeta(
        ctx.db,
        project.id,
        release.id,
        body.title,
        body.version,
        body.notes ?? "",
      );
      return {
        release: getActiveRelease(project.id, project.activeReleaseId, ctx.db),
      };
    },
    { body: UpdateReleaseMetaSchema },
  )
  .post(
    "/api/projects/:projectId/releases/validate",
    async ({ request, params, body, set }) => {
      const ctx = requireAuthContext(request.headers, { requireCsrf: true });
      const project = StoreRepository.getProject(ctx.db, ctx.user.id, params.projectId);
      if (!project) {
        set.status = 404;
        return { error: "Project not found." };
      }
      const currentRel = getActiveRelease(project.id, project.activeReleaseId, ctx.db);
      if (compareVersions(body.nextReleaseVersion, currentRel.version) <= 0) {
        set.status = 409;
        return {
          error: `The next version (${body.nextReleaseVersion}) must be greater than the current ${currentRel.version}.`,
        };
      }
      const allActiveCards = StoreRepository.listCards(ctx.db, project.id, currentRel.id).filter(
        (c) => c.column !== "archived",
      );
      const validatedCards = allActiveCards.filter((c) => c.column === "validated");
      if (validatedCards.length === 0) {
        set.status = 409;
        return {
          error:
            "At least one card must reach the Validated column before validating & cleaning the release sheet.",
        };
      }

      // A model run that saves its card after the seal would write the old release back onto it,
      // and a second seal of the same sheet would leave two active ones: both wait for this one.
      for (const c of StoreRepository.listCards(ctx.db, project.id, currentRel.id)) assertCardIdle(c);
      if (releasesSealing.has(currentRel.id)) {
        throw new WorkflowGateError(`Release ${currentRel.version} is already being sealed.`);
      }
      releasesSealing.add(currentRel.id);
      try {
        const previousSealed = StoreRepository.listReleases(ctx.db, project.id).find(
          (r) => r.status === "sealed" && r.axiomSnapshotJson && r.sealedDigest,
        );

        // Keep cumulative validated project features across cleaned sheets so AxiomSpec G14 preserves history
        const priorCards = StoreRepository.listCumulativeSealedCards(
          ctx.db,
          project.id,
        );
        const cumulativeByCode = new Map<string, typeof validatedCards[number]>();
        for (const pc of priorCards) cumulativeByCode.set(pc.featureCode, pc);
        for (const vc of validatedCards) cumulativeByCode.set(vc.featureCode, vc);
        const cumulativeCards = [...cumulativeByCode.values()];

        const compiledDoc = buildAxiom03Document({
          project,
          release: currentRel,
          cards: cumulativeCards,
          previousRelease: previousSealed ?? null,
          previousSpec: previousSealed?.axiomSnapshotJson ?? null,
        });

        const report = await validateAxiom03Spec(
          compiledDoc,
          previousSealed?.axiomSnapshotJson ?? null,
        );
        if (!report.valid) {
          set.status = 422;
          return {
            error: `AxiomSpec 0.3 release seal blocked: ${report.errors.slice(0, 3).join("; ")}`,
            axiomReport: report,
          };
        }

        const signed = await signAndVerifyAxiom03Release(
          report.specJson,
          previousSealed?.axiomSnapshotJson ?? null,
        );
        const obsBundle = buildObservabilityBundle({
          project,
          release: currentRel,
          cards: cumulativeCards,
          focusCard: validatedCards[0]!,
        });

        const { sealedReleaseId, nextReleaseId } = StoreRepository.sealReleaseAndAdvance(
          ctx.db,
          {
            projectId: project.id,
            currentReleaseId: currentRel.id,
            bumpKind: report.recommendedBump,
            riskScore: report.riskScore,
            sealedDigest: signed.specDigest,
            approvalSignature: signed.signature,
            axiomSnapshotJson: signed.spec,
            observabilityManifestJson: obsBundle.manifest,
            cardsSnapshot: validatedCards,
            nextTitle: body.nextReleaseTitle,
            nextVersion: body.nextReleaseVersion,
            releaseNotes: body.releaseNotes ?? null,
            cleanValidatedCards: body.cleanValidatedCards ?? true,
          },
        );

        const releases = StoreRepository.listReleases(ctx.db, project.id);
        return {
          sealedRelease: releases.find((r) => r.id === sealedReleaseId),
          nextRelease: releases.find((r) => r.id === nextReleaseId),
          approvalBundle: signed.approvalBundle,
          axiomReport: report,
        };
      } finally {
        releasesSealing.delete(currentRel.id);
      }
    },
    { body: ValidateReleaseSchema },
  )
  .get("/api/projects/:projectId/releases", ({ request, params, set }) => {
    const ctx = requireAuthContext(request.headers);
    const project = StoreRepository.getProject(ctx.db, ctx.user.id, params.projectId);
    if (!project) {
      set.status = 404;
      return { error: "Project not found." };
    }
    return { releases: StoreRepository.listReleases(ctx.db, project.id) };
  })
  .get("/api/projects/:projectId/releases/:releaseId", ({ request, params, set }) => {
    const ctx = requireAuthContext(request.headers);
    const project = StoreRepository.getProject(ctx.db, ctx.user.id, params.projectId);
    if (!project) {
      set.status = 404;
      return { error: "Project not found." };
    }
    const releases = StoreRepository.listReleases(ctx.db, project.id);
    const release = releases.find((r) => r.id === params.releaseId);
    if (!release) {
      set.status = 404;
      return { error: "Release not found." };
    }
    const cardsSnapshot = StoreRepository.getReleaseCardsSnapshot(ctx.db, release.id);
    return { release, cardsSnapshot };
  })
  .get(
    "/api/projects/:projectId/releases/:releaseId/compare/:otherId",
    async ({ request, params, set }) => {
      const ctx = requireAuthContext(request.headers);
      const project = StoreRepository.getProject(ctx.db, ctx.user.id, params.projectId);
      if (!project) {
        set.status = 404;
        return { error: "Project not found." };
      }
      const releases = StoreRepository.listReleases(ctx.db, project.id);
      const baseRel = releases.find((r) => r.id === params.releaseId);
      const candRel = releases.find((r) => r.id === params.otherId);
      if (!baseRel?.axiomSnapshotJson || !candRel?.axiomSnapshotJson) {
        set.status = 400;
        return { error: "Both releases must be sealed AxiomSpec 0.3 snapshots to compare." };
      }
      const diff = await compareAxiom03Releases(
        baseRel.axiomSnapshotJson,
        candRel.axiomSnapshotJson,
      );
      return {
        fromReleaseId: baseRel.id,
        fromVersion: baseRel.version,
        toReleaseId: candRel.id,
        toVersion: candRel.version,
        recommendedBump: diff.recommendedBump,
        riskScore: diff.riskScore,
        addedNodes: diff.addedNodes,
        removedNodes: diff.removedNodes,
        changedNodes: diff.changedNodes,
        breakingChanges: diff.breakingChanges,
        rawReport: diff.report,
      };
    },
  )
  // Authenticated Read-Only Builder Agent API (+ aeion-framework compatible snapshot routes)
  .get("/api/v1/builder/projects/:slug/spec", async ({ request, params, query, set }) => {
    const authHdr = request.headers.get("authorization") || "";
    const token = authHdr.replace(/^Bearer\s+/i, "").trim();
    const bCtx = token ? StoreRepository.resolveBuilderContext(token) : null;
    if (!bCtx) {
      set.status = 401;
      return { error: "Valid Builder Bearer token (aeion_bld_...) required." };
    }
    const projects = StoreRepository.listProjects(bCtx.db, bCtx.userId);
    const project = projects.find((p) => p.slug === params.slug || p.id === params.slug);
    if (!project) {
      set.status = 404;
      return { error: `Unknown builder project '${params.slug}'.` };
    }
    const releases = StoreRepository.listReleases(bCtx.db, project.id);
    const reqVersion = (query as { version?: string }).version?.replace(/^v/i, "");
    const release = reqVersion
      ? releases.find((r) => r.version === reqVersion)
      : releases.find((r) => r.status === "sealed") ?? releases[0];
    if (!release) {
      set.status = 404;
      return { error: "Release snapshot not found." };
    }
    const cards = StoreRepository.getReleaseCardsSnapshot(bCtx.db, release.id);
    const axiomSpec03 =
      release.axiomSnapshotJson ??
      buildAxiom03Document({ project, release, cards });
    const bundle =
      cards.length > 0
        ? buildObservabilityBundle({ project, release, cards, focusCard: cards[0]! })
        : null;
    const observabilityManifest =
      release.observabilityManifestJson ?? bundle?.manifest ?? {};
    return {
      project: {
        id: project.id,
        slug: project.slug,
        name: project.name,
        sourceKind: project.sourceKind,
      },
      release: {
        id: release.id,
        version: release.version,
        title: release.title,
        status: release.status,
        sealedDigest: release.sealedDigest,
        sealedAt: release.sealedAt,
      },
      axiomSpec03,
      observabilityManifest,
      features: cards.map((c, idx) => {
        const md =
          c.draftMarkdown ||
          buildObservabilityBundle({ project, release, cards, focusCard: c }).feature
            .markdown;
        return {
          featureCode: c.featureCode,
          title: c.title,
          column: c.column,
          markdown: md,
          byteCount: Buffer.byteLength(md, "utf8"),
          sequence: idx + 1,
        };
      }),
    };
  })
  .post(
    "/api/v1/builder/projects/:slug/feedback",
    ({ request, params, body, set }) => {
      const authHdr = request.headers.get("authorization") || "";
      const token = authHdr.replace(/^Bearer\s+/i, "").trim();
      const bCtx = token ? StoreRepository.resolveBuilderContext(token) : null;
      if (!bCtx) {
        set.status = 401;
        return { error: "Valid Builder Bearer token required." };
      }
      const projects = StoreRepository.listProjects(bCtx.db, bCtx.userId);
      const project = projects.find((p) => p.slug === params.slug || p.id === params.slug);
      if (!project) {
        set.status = 404;
        return { error: "Project not found." };
      }
      StoreRepository.insertBuilderFeedback(bCtx.db, {
        projectId: project.id,
        featureCode: body.featureCode,
        status: body.status,
        detail: body.detail,
        artifactDigest: body.artifactDigest ?? null,
      });
      return { recorded: true };
    },
    { body: BuilderFeedbackSchema },
  )
  // aeion-framework compatible HTTP Snapshot / Release endpoints (authenticated with Builder Bearer token)
  .get("/v1/snapshots", ({ request, set }) => {
    const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const bCtx = token ? StoreRepository.resolveBuilderContext(token) : null;
    if (!bCtx) {
      set.status = 401;
      return { error: "Valid Builder Bearer token required." };
    }
    const projects = StoreRepository.listProjects(bCtx.db, bCtx.userId);
    return {
      snapshots: projects.map((p) => ({
        projectSlug: p.slug,
        projectName: p.name,
        activeReleaseVersion: p.activeReleaseVersion,
        sourceKind: p.sourceKind,
      })),
    };
  })
  .get("/v1/releases/:slug", ({ request, params, set }) => {
    const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const bCtx = token ? StoreRepository.resolveBuilderContext(token) : null;
    if (!bCtx) {
      set.status = 401;
      return { error: "Valid Builder Bearer token required." };
    }
    const projects = StoreRepository.listProjects(bCtx.db, bCtx.userId);
    const project = projects.find((p) => p.slug === params.slug || p.id === params.slug);
    if (!project) {
      set.status = 404;
      return { error: "Project not found." };
    }
    return {
      project: project.slug,
      releases: StoreRepository.listReleases(bCtx.db, project.id).map((r) => ({
        id: r.id,
        version: r.version,
        title: r.title,
        status: r.status,
        sealedDigest: r.sealedDigest,
        bumpKind: r.bumpKind,
        riskScore: r.riskScore,
        sealedAt: r.sealedAt,
      })),
    };
  });

export type App = typeof app;
