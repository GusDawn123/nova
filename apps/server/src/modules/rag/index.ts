import { chunker } from "./chunker.js";
import { ragConfig, type RagConfig } from "./config.js";
import { isRagError, RagError } from "./ports.js";
import {
  createRagService,
  type RagLogger,
  type RagService,
} from "./service.js";
import { pgVectorStoreFromEnv } from "./adapters/pgvector.js";
import {
  voyageAdapterFromEnv,
  type VoyageUsageLog,
} from "./adapters/voyage.js";

/**
 * Public surface of modules/rag — the ONLY things a route, the completion sweeper,
 * or any feature may import (RULES §5). It exposes the service factory, the
 * env-driven module factory, and the boundary TYPES/errors a caller reasons about.
 * It deliberately does NOT re-export the Voyage / pgvector adapters or the ports'
 * internal wiring: no consumer gets to bind a vendor SDK into its type surface.
 */

// ---------------------------------------------------------------------------
// The env-driven module factory (mirrors createSttVendorsFromEnv's keyless posture).
// ---------------------------------------------------------------------------

/** Optional wiring inputs; all defaulted so `createRagFromEnv(env)` is enough. */
export interface RagFromEnvDeps {
  /** Structured log sink (Fastify `app.log`). Counts only ever cross it. */
  readonly logger?: RagLogger;
  /** Tunable overrides; defaults to the process-wide {@link ragConfig}. */
  readonly config?: RagConfig;
  /** Voyage usage-line sink (metering). Defaults to one info-level JSON line. */
  readonly logUsage?: (entry: VoyageUsageLog) => void;
}

/**
 * A stub {@link RagService} for a keyless (or DB-less) deploy: every method throws
 * `RAG_NOT_CONFIGURED`, so the server still BOOTS and callers degrade explicitly
 * (Phase 7's live path drops RAG and proceeds) instead of crashing — the same
 * posture keyless STT takes. Constructed only when Voyage or the DB URL is absent.
 */
function notConfiguredService(): RagService {
  const message =
    "RAG is not configured: set VOYAGE_API_KEY and SUPABASE_DB_URL to enable memory.";
  // Reject (never throw synchronously) so callers always get a typed rejected
  // promise to await, matching the live service's async surface.
  return {
    ingest: () => Promise.reject(RagError.notConfigured(message)),
    query: () => Promise.reject(RagError.notConfigured(message)),
  };
}

/**
 * Build the live {@link RagService} from the environment when BOTH the embeddings
 * key (`VOYAGE_API_KEY`) and the store URL (`SUPABASE_DB_URL`) are present; when
 * either is missing, return the not-configured stub. Only `RAG_NOT_CONFIGURED` is
 * swallowed into the stub — any other adapter error propagates (a genuine misconfig
 * must be loud, not silently degraded).
 */
export function createRagFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: RagFromEnvDeps = {},
): RagService {
  try {
    const { embedder, reranker } = voyageAdapterFromEnv(
      env,
      deps.config ?? ragConfig,
      deps.logUsage,
    );
    const store = pgVectorStoreFromEnv(env, deps.config ?? ragConfig);
    return createRagService({
      chunker,
      embedder,
      store,
      reranker,
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...(deps.config ? { config: deps.config } : {}),
    });
  } catch (err) {
    if (isRagError(err) && err.code === "RAG_NOT_CONFIGURED") {
      return notConfiguredService();
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Re-exports: the service surface + boundary types/errors ONLY (no adapters).
// ---------------------------------------------------------------------------

export {
  createRagService,
  ragIngestSourceSchema,
  type RagService,
  type RagServiceDeps,
  type RagIngestSource,
  type RagIngestResult,
  type RagQueryOpts,
  type RagQueryResult,
  type RagTier,
  type RagUsage,
  type RagLogger,
} from "./service.js";

export {
  RagError,
  isRagError,
  type RagErrorCode,
  type RagHit,
  type TranscriptTurn,
} from "./ports.js";

export { ragConfig, type RagConfig } from "./config.js";
