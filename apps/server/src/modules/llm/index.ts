/**
 * Public surface of the `llm` module: the port contracts, the typed error
 * taxonomy, the config schema, the failover router, the four real provider
 * adapters, and the env-driven factory. Vendor SDKs stay inside `adapters/` —
 * nothing re-exported here pulls one into a consumer's type surface.
 */

export {
  providerIdSchema,
  chatMessageSchema,
  chatRequestSchema,
  llmStreamEventSchema,
  noopMeter,
  type ProviderId,
  type ChatMessage,
  type ChatRequest,
  type LlmStreamEvent,
  type LlmProvider,
  type UsageEntry,
  type Meter,
} from "./ports.js";

export {
  LlmError,
  AllProvidersFailedError,
  classifyHttpStatus,
  isLlmError,
  type LlmErrorKind,
  type ProviderFailure,
} from "./errors.js";

export { llmConfigSchema, liveLlmConfig, type LlmConfig } from "./config.js";

export {
  createLlmRouter,
  withMeter,
  type LlmRouter,
  type LlmRouterDeps,
} from "./router.js";

export {
  createAnthropicProvider,
  type AnthropicProviderOptions,
} from "./adapters/anthropic.js";
export {
  createOpenAiProvider,
  type OpenAiProviderOptions,
} from "./adapters/openai.js";
export {
  createGroqProvider,
  type GroqProviderOptions,
} from "./adapters/groq.js";
export {
  createGoogleProvider,
  type GoogleProviderOptions,
} from "./adapters/google.js";
export { createXaiProvider, type XaiProviderOptions } from "./adapters/xai.js";

export { createProvidersFromEnv, type LlmProviderEnv } from "./factory.js";

export {
  makeMockProvider,
  defaultSleep,
  type SleepFn,
  type MockCallScript,
  type MockCall,
  type MockProvider,
  type MockProviderOptions,
} from "./testing/mock-provider.js";
