/**
 * Public surface of the `llm` module. Task 1 ships the contracts and the test
 * harness only — the router, adapters, HTTP, and env wiring land in later tasks.
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

export { llmConfigSchema, type LlmConfig } from "./config.js";

export {
  makeMockProvider,
  defaultSleep,
  type SleepFn,
  type MockCallScript,
  type MockCall,
  type MockProvider,
  type MockProviderOptions,
} from "./testing/mock-provider.js";
