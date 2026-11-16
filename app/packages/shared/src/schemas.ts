// Spec: knowledge/components/aeion-agents.md

import { t } from "elysia";

export const LlmProviderSchema = t.Union([
  t.Literal("anthropic"),
  t.Literal("openai"),
  t.Literal("deepinfra"),
  t.Literal("openrouter"),
  t.Literal("mistral"),
  t.Literal("deepseek"),
  t.Literal("opencode-go"),
]);

export const RoleIdSchema = t.Union([
  t.Literal("elephant"),
  t.Literal("drafter"),
  t.Literal("reviewer"),
  t.Literal("goldfish:pm"),
  t.Literal("goldfish:security"),
  t.Literal("goldfish:sre"),
  t.Literal("goldfish:ux"),
  t.Literal("goldfish:architecture"),
  t.Literal("goldfish:finops"),
  t.Literal("goldfish:legal"),
  t.Literal("goldfish:devil"),
]);

export const GoldfishPersonaSchema = t.Union([
  t.Literal("pm"),
  t.Literal("security"),
  t.Literal("sre"),
  t.Literal("ux"),
  t.Literal("architecture"),
  t.Literal("finops"),
  t.Literal("legal"),
  t.Literal("devil"),
]);

export const RegisterBodySchema = t.Object({
  email: t.String({ format: "email", minLength: 5, maxLength: 160 }),
  password: t.String({ minLength: 12, maxLength: 200 }),
  displayName: t.String({ minLength: 2, maxLength: 80 }),
});

export const LoginBodySchema = t.Object({
  email: t.String({ format: "email", minLength: 5, maxLength: 160 }),
  password: t.String({ minLength: 1, maxLength: 200 }),
});

export const StoreVaultKeySchema = t.Object({
  purpose: t.Union([t.Literal("llm_provider"), t.Literal("github_readonly")]),
  provider: t.Union([LlmProviderSchema, t.Literal("github")]),
  label: t.String({ minLength: 1, maxLength: 80 }),
  secret: t.String({ minLength: 6, maxLength: 512 }),
});

export const SaveModelMixerSchema = t.Object({
  assignments: t.Record(
    t.String(),
    t.Object({
      provider: LlmProviderSchema,
      modelId: t.String({ minLength: 1, maxLength: 160 }),
      temperature: t.Optional(t.Number({ minimum: 0, maximum: 1.5 })),
      thinkingLevel: t.Optional(
        t.Union([
          t.Literal("off"),
          t.Literal("low"),
          t.Literal("medium"),
          t.Literal("high"),
          t.Literal("max"),
        ]),
      ),
    }),
  ),
});

export const CreateProjectSchema = t.Object({
  name: t.String({ minLength: 2, maxLength: 100 }),
  description: t.Optional(t.String({ maxLength: 1000 })),
  releaseTitle: t.Optional(t.String({ minLength: 2, maxLength: 120 })),
  releaseVersion: t.Optional(t.String({ pattern: "^v?\\d+\\.\\d+\\.\\d+$" })),
  sourceKind: t.Union([
    t.Literal("empty"),
    t.Literal("github_public"),
    t.Literal("github_private"),
    t.Literal("upload"),
  ]),
  sourceRef: t.Optional(t.String({ maxLength: 300 })),
  githubVaultKeyId: t.Optional(t.String({ maxLength: 80 })),
});

export const CreateCardSchema = t.Object({
  title: t.String({ minLength: 3, maxLength: 140 }),
  summary: t.String({ minLength: 10, maxLength: 4000 }),
  area: t.Optional(t.String({ minLength: 2, maxLength: 40 })),
  phase: t.Optional(t.String({ pattern: "^P[0-9]+$" })),
  size: t.Optional(t.Union([t.Literal("S"), t.Literal("M"), t.Literal("L")])),
  writePaths: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 200 }))),
  dependsOn: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 80 }))),
});

export const UpdateCardSchema = t.Object({
  title: t.Optional(t.String({ minLength: 3, maxLength: 140 })),
  summary: t.Optional(t.String({ minLength: 10, maxLength: 4000 })),
  area: t.Optional(t.String({ minLength: 2, maxLength: 40 })),
  phase: t.Optional(t.String({ pattern: "^P[0-9]+$" })),
  size: t.Optional(t.Union([t.Literal("S"), t.Literal("M"), t.Literal("L")])),
  writePaths: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 200 }))),
  dependsOn: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 80 }))),
  resolveFindingIds: t.Optional(
    t.Array(
      t.Object({
        findingId: t.String({ minLength: 1, maxLength: 80 }),
        note: t.String({ minLength: 2, maxLength: 500 }),
      }),
    ),
  ),
});

export const MoveCardSchema = t.Object({
  targetColumn: t.Union([
    t.Literal("idea"),
    t.Literal("goldfish_interview"),
    t.Literal("automated_review"),
    t.Literal("validated"),
    t.Literal("archived"),
  ]),
  position: t.Optional(t.Integer({ minimum: 0 })),
});

export const InterviewTurnSchema = t.Object({
  message: t.String({ minLength: 1, maxLength: 8000 }),
  decisionAnswers: t.Optional(
    t.Array(
      t.Object({
        decisionId: t.String(),
        chosenOption: t.Optional(t.String()),
        answerText: t.String({ minLength: 1, maxLength: 2000 }),
      }),
    ),
  ),
  personas: t.Optional(t.Array(GoldfishPersonaSchema)),
});

export const SatisfyCardSchema = t.Object({
  userSatisfied: t.Boolean(),
  note: t.Optional(t.String({ maxLength: 500 })),
});

export const UpdateReleaseMetaSchema = t.Object({
  title: t.String({ minLength: 2, maxLength: 120 }),
  version: t.String({ pattern: "^v?\\d+\\.\\d+\\.\\d+$" }),
  notes: t.Optional(t.String({ maxLength: 4000 })),
});

export const ValidateReleaseSchema = t.Object({
  nextReleaseTitle: t.String({ minLength: 2, maxLength: 120 }),
  nextReleaseVersion: t.String({ pattern: "^v?\\d+\\.\\d+\\.\\d+$" }),
  releaseNotes: t.Optional(t.String({ maxLength: 4000 })),
  signerIdentity: t.Optional(t.String({ minLength: 2, maxLength: 120 })),
  cleanValidatedCards: t.Optional(t.Boolean()),
});

export const BuilderFeedbackSchema = t.Object({
  featureCode: t.String({ minLength: 2, maxLength: 60 }),
  status: t.Union([
    t.Literal("started"),
    t.Literal("blocked"),
    t.Literal("completed"),
    t.Literal("failed"),
  ]),
  detail: t.String({ minLength: 1, maxLength: 2000 }),
  artifactDigest: t.Optional(t.String({ maxLength: 128 })),
});
