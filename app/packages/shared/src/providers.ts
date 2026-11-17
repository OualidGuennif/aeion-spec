// Spec: knowledge/components/aeion-agents.md

import type { ModelAssignment } from "./contracts.ts";

export type LlmProviderId =
  | "anthropic"
  | "openai"
  | "deepinfra"
  | "openrouter"
  | "mistral"
  | "deepseek"
  | "opencode-go";

export type PiWireApi = "anthropic-messages" | "openai-completions";

export type AgentRoleId =
  | "elephant"
  | "drafter"
  | "reviewer"
  | "goldfish:pm"
  | "goldfish:security"
  | "goldfish:sre"
  | "goldfish:ux"
  | "goldfish:architecture"
  | "goldfish:finops"
  | "goldfish:legal"
  | "goldfish:devil";

export type GoldfishPersonaId =
  | "pm"
  | "security"
  | "sre"
  | "ux"
  | "architecture"
  | "finops"
  | "legal"
  | "devil";

export interface GoldfishPersonaMeta {
  readonly id: GoldfishPersonaId;
  readonly roleId: AgentRoleId;
  readonly label: string;
  readonly lens: string;
  readonly challengeFocus: string;
}

export interface ProviderPresetModel {
  readonly id: string;
  readonly label: string;
  readonly api: PiWireApi;
  readonly contextWindow: number;
  readonly recommendedFor: readonly ("elephant" | "goldfish" | "reviewer")[];
}

export interface ProviderSpec {
  readonly id: LlmProviderId;
  readonly label: string;
  readonly litellmPrefix: string;
  readonly defaultApi: PiWireApi;
  readonly envVarName: string;
  readonly keyHint: string;
  readonly defaultBaseUrl: string;
  readonly curatedModels: readonly ProviderPresetModel[];
}

export const GOLDFISH_PERSONAS: readonly GoldfishPersonaMeta[] = [
  {
    id: "pm",
    roleId: "goldfish:pm",
    label: "Product & Scope",
    lens: "User outcomes, non-goals, acceptance criteria, and measurable value",
    challengeFocus: "Ambiguous scope boundaries and unverified user demand",
  },
  {
    id: "security",
    roleId: "goldfish:security",
    label: "Security & Trust",
    lens: "Trust boundaries, authz invariants, secret isolation, abuse vectors",
    challengeFocus: "Privilege escalation, injection paths, and missing negative controls",
  },
  {
    id: "sre",
    roleId: "goldfish:sre",
    label: "SRE & Reliability",
    lens: "SLOs, failure modes, rate limits, idempotency, observability & recovery",
    challengeFocus: "Unhandled timeouts, cascade failures, and unmeasurable readiness",
  },
  {
    id: "ux",
    roleId: "goldfish:ux",
    label: "UX & Accessibility",
    lens: "Operator clarity, empty/error states, WCAG AA contrast, responsive layout",
    challengeFocus: "Dead-end states, silent failures, and hostile operator workflows",
  },
  {
    id: "architecture",
    roleId: "goldfish:architecture",
    label: "Architecture",
    lens: "Module boundaries, schema contracts, data ownership, coupling & DAG order",
    challengeFocus: "Cross-layer leaks, circular dependencies, and fragile write scopes",
  },
  {
    id: "finops",
    roleId: "goldfish:finops",
    label: "FinOps & Cost",
    lens: "Token/compute budget, storage growth, unbounded loops, cold-start cost",
    challengeFocus: "Runaway LLM fan-outs, unindexed scans, and uncapped egress",
  },
  {
    id: "legal",
    roleId: "goldfish:legal",
    label: "Compliance & Policy",
    lens: "Data retention, invite-mode ephemerality, licensing, PII & auditability",
    challengeFocus: "Unintended disk persistence, telemetry leaks, and license mismatch",
  },
  {
    id: "devil",
    roleId: "goldfish:devil",
    label: "Devil's Advocate",
    lens: "Premise invalidation, simpler alternatives, adversarial counter-examples",
    challengeFocus: "Sunk-cost complexity, unstated assumptions, and brittle happy paths",
  },
] as const;

export const PROVIDER_CATALOG: Record<LlmProviderId, ProviderSpec> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    litellmPrefix: "anthropic",
    defaultApi: "anthropic-messages",
    envVarName: "ANTHROPIC_API_KEY",
    keyHint: "sk-ant-...",
    defaultBaseUrl: "https://api.anthropic.com",
    curatedModels: [
      {
        id: "claude-sonnet-5-5",
        label: "Claude Sonnet 5.5",
        api: "anthropic-messages",
        contextWindow: 200_000,
        recommendedFor: ["elephant", "reviewer"],
      },
      {
        id: "claude-opus-5-5",
        label: "Claude Opus 5.5",
        api: "anthropic-messages",
        contextWindow: 200_000,
        recommendedFor: ["reviewer"],
      },
      {
        id: "claude-haiku-5-5",
        label: "Claude Haiku 5.5",
        api: "anthropic-messages",
        contextWindow: 200_000,
        recommendedFor: ["goldfish"],
      },
    ],
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    litellmPrefix: "openai",
    defaultApi: "openai-completions",
    envVarName: "OPENAI_API_KEY",
    keyHint: "sk-...",
    defaultBaseUrl: "https://api.openai.com/v1",
    curatedModels: [
      {
        id: "gpt-4.1",
        label: "GPT-4.1",
        api: "openai-completions",
        contextWindow: 1_000_000,
        recommendedFor: ["elephant", "reviewer"],
      },
      {
        id: "gpt-4.1-mini",
        label: "GPT-4.1 Mini",
        api: "openai-completions",
        contextWindow: 1_000_000,
        recommendedFor: ["goldfish"],
      },
      {
        id: "o4-mini",
        label: "o4-mini Reasoning",
        api: "openai-completions",
        contextWindow: 200_000,
        recommendedFor: ["reviewer", "goldfish"],
      },
    ],
  },
  deepinfra: {
    id: "deepinfra",
    label: "DeepInfra",
    litellmPrefix: "deepinfra",
    defaultApi: "openai-completions",
    envVarName: "DEEPINFRA_API_KEY",
    keyHint: "di_... or bearer token",
    defaultBaseUrl: "https://api.deepinfra.com/v1/openai",
    curatedModels: [
      {
        id: "Qwen/Qwen3-235B-A22B",
        label: "Qwen3 235B A22B",
        api: "openai-completions",
        contextWindow: 131_072,
        recommendedFor: ["elephant", "reviewer"],
      },
      {
        id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
        label: "Llama 4 Maverick",
        api: "openai-completions",
        contextWindow: 1_000_000,
        recommendedFor: ["goldfish"],
      },
      {
        id: "deepseek-ai/DeepSeek-V3-0324",
        label: "DeepSeek V3 (DeepInfra)",
        api: "openai-completions",
        contextWindow: 163_840,
        recommendedFor: ["goldfish", "reviewer"],
      },
    ],
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    litellmPrefix: "openrouter",
    defaultApi: "openai-completions",
    envVarName: "OPENROUTER_API_KEY",
    keyHint: "sk-or-v1-...",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    curatedModels: [
      {
        id: "anthropic/claude-sonnet-4.5",
        label: "Claude Sonnet 4.5 (OpenRouter)",
        api: "openai-completions",
        contextWindow: 200_000,
        recommendedFor: ["elephant", "reviewer"],
      },
      {
        id: "openai/gpt-4.1",
        label: "GPT-4.1 (OpenRouter)",
        api: "openai-completions",
        contextWindow: 1_000_000,
        recommendedFor: ["reviewer"],
      },
      {
        id: "google/gemini-2.5-pro",
        label: "Gemini 2.5 Pro (OpenRouter)",
        api: "openai-completions",
        contextWindow: 1_000_000,
        recommendedFor: ["goldfish", "reviewer"],
      },
    ],
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    litellmPrefix: "mistral",
    defaultApi: "openai-completions",
    envVarName: "MISTRAL_API_KEY",
    keyHint: "Mistral API key",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    curatedModels: [
      {
        id: "mistral-large-latest",
        label: "Mistral Large",
        api: "openai-completions",
        contextWindow: 128_000,
        recommendedFor: ["elephant", "reviewer"],
      },
      {
        id: "codestral-latest",
        label: "Codestral",
        api: "openai-completions",
        contextWindow: 256_000,
        recommendedFor: ["goldfish"],
      },
      {
        id: "mistral-medium-latest",
        label: "Mistral Medium",
        api: "openai-completions",
        contextWindow: 128_000,
        recommendedFor: ["goldfish"],
      },
    ],
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    litellmPrefix: "deepseek",
    defaultApi: "openai-completions",
    envVarName: "DEEPSEEK_API_KEY",
    keyHint: "sk-...",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    curatedModels: [
      {
        id: "deepseek-chat",
        label: "DeepSeek V3 Chat",
        api: "openai-completions",
        contextWindow: 128_000,
        recommendedFor: ["elephant", "goldfish"],
      },
      {
        id: "deepseek-reasoner",
        label: "DeepSeek R1 Reasoner",
        api: "openai-completions",
        contextWindow: 128_000,
        recommendedFor: ["reviewer", "goldfish"],
      },
    ],
  },
  "opencode-go": {
    id: "opencode-go",
    label: "OpenCode Go",
    litellmPrefix: "opencode_go",
    defaultApi: "openai-completions",
    envVarName: "OPENCODE_API_KEY",
    keyHint: "oc-...",
    defaultBaseUrl: "https://opencode.ai/inference/go/v1",
    curatedModels: [
      {
        id: "deepseek-v4.1-flash",
        label: "DeepSeek V4.1 Flash (OpenCode Go)",
        api: "openai-completions",
        contextWindow: 1_000_000,
        recommendedFor: ["elephant", "goldfish"],
      },
      {
        id: "claude-haiku-5-5",
        label: "Claude Haiku 5.5 (OpenCode Go)",
        api: "anthropic-messages",
        contextWindow: 1_000_000,
        recommendedFor: ["reviewer", "goldfish"],
      },
      {
        id: "glm-5.3-flash",
        label: "GLM-5.3 Flash (OpenCode Go)",
        api: "openai-completions",
        contextWindow: 1_000_000,
        recommendedFor: ["elephant", "goldfish", "reviewer"],
      },
      {
        id: "minimax-m3.1-flash",
        label: "MiniMax M3.1 Flash (OpenCode Go)",
        api: "openai-completions",
        contextWindow: 512_000,
        recommendedFor: ["goldfish", "reviewer"],
      },
      {
        id: "qwen3.8-flash",
        label: "Qwen 3.8 Flash (OpenCode Go)",
        api: "anthropic-messages",
        contextWindow: 131_072,
        recommendedFor: ["goldfish", "reviewer"],
      },
      {
        id: "qwen4-max",
        label: "Qwen 4 Max (OpenCode Go)",
        api: "openai-completions",
        contextWindow: 131_072,
        recommendedFor: ["elephant", "reviewer"],
      },
    ],
  },
};

export const ALL_PROVIDER_IDS: readonly LlmProviderId[] = [
  "anthropic",
  "openai",
  "deepinfra",
  "openrouter",
  "mistral",
  "deepseek",
  "opencode-go",
];

export function formatLitellmModelId(
  provider: LlmProviderId,
  modelId: string,
): string {
  const spec = PROVIDER_CATALOG[provider];
  const clean = modelId.trim();
  const prefix = `${spec.litellmPrefix}/`;
  return clean.startsWith(prefix) ? clean : `${prefix}${clean}`;
}

export function inferVendorFamily(
  provider: LlmProviderId,
  modelId: string,
): string {
  const normalized = modelId.toLowerCase();
  if (normalized.includes("claude") || provider === "anthropic") {
    return "anthropic";
  }
  if (
    normalized.includes("gpt") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4") ||
    normalized.startsWith("o1") ||
    provider === "openai"
  ) {
    return "openai";
  }
  if (normalized.includes("gemini")) return "google";
  if (normalized.includes("deepseek") || provider === "deepseek") {
    return "deepseek";
  }
  if (normalized.includes("mistral") || normalized.includes("codestral") || provider === "mistral") {
    return "mistral";
  }
  if (normalized.includes("llama")) return "meta";
  if (normalized.includes("qwen")) return "qwen";
  if (normalized.includes("kimi")) return "moonshot";
  if (normalized.includes("glm")) return "zhipu";
  if (normalized.includes("minimax")) return "minimax";
  return provider;
}

// When a customer's OpenCode Go key reports its enabled models, keep an enabled choice or fall back by role.
export function resolveEnabledOpenCodeModel(
  role: AgentRoleId,
  modelId: string,
  enabledModels: readonly string[],
): string {
  const clean = modelId.trim().replace(/^opencode_go\//, "");
  const allowed = enabledModels.map((m) => m.trim().replace(/^opencode_go\//, "")).filter(Boolean);
  if (allowed.length === 0 || allowed.includes(clean)) return clean;
  const preferred =
    role === "reviewer"
      ? ["claude-haiku-5-5", "glm-5.3-flash", "minimax-m3.1-flash", "qwen3.8-flash", "qwen4-max", "deepseek-v4.1-flash"]
      : ["deepseek-v4.1-flash", "glm-5.3-flash", "qwen4-max", "minimax-m3.1-flash", "qwen3.8-flash", "claude-haiku-5-5"];
  return preferred.find((m) => allowed.includes(m)) ?? allowed[0]!;
}

export function resolveWireApi(
  provider: LlmProviderId,
  modelId: string,
): PiWireApi {
  const preset = PROVIDER_CATALOG[provider].curatedModels.find(
    (entry) => entry.id === modelId,
  );
  if (preset) return preset.api;
  if (provider === "anthropic") return "anthropic-messages";
  if (
    provider === "opencode-go" &&
    (modelId.startsWith("claude-") ||
      modelId.startsWith("qwen") ||
      modelId.startsWith("minimax-m3"))
  ) {
    return "anthropic-messages";
  }
  return "openai-completions";
}

// Drafting providers first; Anthropic last so that, with several keys, Claude reviews another family's draft.
const DEFAULT_PROVIDER_ORDER: readonly LlmProviderId[] = [
  "openai",
  "opencode-go",
  "deepseek",
  "mistral",
  "deepinfra",
  "openrouter",
  "anthropic",
];

function presetFor(provider: LlmProviderId, use: "elephant" | "goldfish" | "reviewer"): ProviderPresetModel {
  const models = PROVIDER_CATALOG[provider].curatedModels;
  return models.find((m) => m.recommendedFor.includes(use)) ?? models[0]!;
}

function assignment(
  role: AgentRoleId,
  provider: LlmProviderId,
  model: ProviderPresetModel,
  temperature: number,
): ModelAssignment {
  return { role, provider, modelId: model.id, api: model.api, temperature, thinkingLevel: "medium" };
}

// The reviewer comes from another vendor family than the drafter whenever the held keys allow it, Claude first.
function crossFamilyReviewer(
  providers: readonly LlmProviderId[],
  drafterFamily: string,
): { provider: LlmProviderId; model: ProviderPresetModel } | null {
  const candidates = providers.flatMap((provider) =>
    PROVIDER_CATALOG[provider].curatedModels
      .filter((model) => inferVendorFamily(provider, model.id) !== drafterFamily)
      .map((model) => ({ provider, model })),
  );
  const rank = (c: { provider: LlmProviderId; model: ProviderPresetModel }) =>
    (inferVendorFamily(c.provider, c.model.id) === "anthropic" ? 0 : 2) +
    (c.model.recommendedFor.includes("reviewer") ? 0 : 1);
  return candidates.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

// A new project's mixer, built only from providers the owner holds keys for (none: OpenAI drafts, Anthropic reviews).
export function buildDefaultMixer(
  heldProviders: readonly LlmProviderId[],
): Partial<Record<AgentRoleId, ModelAssignment>> {
  const held = DEFAULT_PROVIDER_ORDER.filter((p) => heldProviders.includes(p));
  const providers = held.length > 0 ? held : (["openai", "anthropic"] as const);
  const primary = providers[0]!;
  const drafterModel = presetFor(primary, "elephant");
  const reviewer =
    crossFamilyReviewer(providers, inferVendorFamily(primary, drafterModel.id)) ??
    { provider: primary, model: presetFor(primary, "reviewer") };
  const goldfishModel = presetFor(primary, "goldfish");
  const mixer: Partial<Record<AgentRoleId, ModelAssignment>> = {
    elephant: assignment("elephant", primary, drafterModel, 0.25),
    drafter: assignment("drafter", primary, drafterModel, 0.2),
    reviewer: assignment("reviewer", reviewer.provider, reviewer.model, 0.1),
  };
  for (const persona of GOLDFISH_PERSONAS) {
    mixer[persona.roleId] = assignment(persona.roleId, primary, goldfishModel, 0.3);
  }
  return mixer;
}
