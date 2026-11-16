// Spec: knowledge/components/aeion-agents.md
// Multi-provider Pi + Flue adapter routed exclusively through aeion-spec's loopback ContextRelay & LiteLLM.
// Real provider API keys never enter this process or environment; only an ephemeral single-run AEION_RELAY_TOKEN.
import { createProvider } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { setProvider } from '@flue/runtime';

export const DEFAULT_PROVIDER_ID = 'opencode-go';

type ModelMetadata = {
  provider?: string;
  id: string;
  name: string;
  api?: 'openai-completions' | 'anthropic-messages';
  context: number;
  input: number;
  output: number;
  cacheRead: number;
  maxOutputTokens: number;
};

const THINKING: Record<string, Record<string, string>> = {
  'deepseek-v4.1-flash': { minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' },
  'deepseek-v4-pro': { minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' },
  'o4-mini': { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' },
};

export function modelFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const relayUrl = env.AEION_RELAY_URL;
  if (!relayUrl || !/^http:\/\/127\.0\.0\.1:\d+(?:\/relay\/[a-zA-Z0-9_-]+)?\/v1$/.test(relayUrl)) {
    throw new Error('AEION_RELAY_URL must point to the aeion-spec loopback ContextRelay');
  }
  if (!env.AEION_RELAY_TOKEN) throw new Error('AEION_RELAY_TOKEN is required');
  const meta: ModelMetadata = JSON.parse(env.AEION_MODEL_JSON ?? 'null');
  if (!meta || typeof meta.id !== 'string' || !Number.isSafeInteger(meta.context)) {
    throw new Error('AEION_MODEL_JSON is invalid');
  }
  if (!Number.isSafeInteger(meta.maxOutputTokens) || meta.maxOutputTokens < 1 || meta.maxOutputTokens > 131072) {
    throw new Error('Output budget invalid');
  }

  const providerId = (meta.provider || DEFAULT_PROVIDER_ID).trim();
  const wireApi = meta.api === 'anthropic-messages' ? ('anthropic-messages' as const) : ('openai-completions' as const);
  const baseUrl = wireApi === 'anthropic-messages' ? relayUrl.slice(0, -3) : relayUrl;

  return {
    id: meta.id,
    name: meta.name,
    api: wireApi,
    provider: providerId,
    baseUrl,
    reasoning: meta.id in THINKING || meta.id.includes('reasoner') || meta.id.includes('claude'),
    input: ['text' as const],
    cost: { input: meta.input ?? 0, output: meta.output ?? 0, cacheRead: meta.cacheRead ?? 0, cacheWrite: 0 },
    contextWindow: meta.context,
    maxTokens: meta.maxOutputTokens,
    thinkingLevelMap: THINKING[meta.id] ?? {},
    compat:
      wireApi === 'openai-completions'
        ? {
            supportsDeveloperRole: false,
            supportsStore: false,
            supportsReasoningEffort: meta.id in THINKING,
            ...(meta.id.startsWith('deepseek') ? { thinkingFormat: 'deepseek' as const } : {}),
            supportsUsageInStreaming: true,
            maxTokensField: 'max_tokens' as const,
          }
        : undefined,
  };
}

export function registerProvider(env: NodeJS.ProcessEnv = process.env) {
  const model = modelFromEnv(env);
  const token = env.AEION_RELAY_TOKEN!;
  const apiImpl = model.api === 'anthropic-messages' ? anthropicMessagesApi() : openAICompletionsApi();

  setProvider(
    createProvider({
      id: model.provider,
      name: `${model.provider} via aeion-spec LiteLLM ContextRelay`,
      baseUrl: model.baseUrl,
      auth: {
        apiKey: {
          name: 'aeion-spec ephemeral relay token',
          resolve: async () => ({ auth: { apiKey: token } }),
        },
      },
      models: [model],
      api: apiImpl as never,
    }),
  );
  return `${model.provider}/${model.id}`;
}
