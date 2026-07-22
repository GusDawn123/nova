import type {
  ChatRequest,
  LlmStreamEvent,
  Meter,
} from "../../llm/index.js";
import type { LlmRouter } from "../../llm/index.js";

/**
 * A prompt-READING mock {@link LlmRouter} for the map-reduce suites — vitest-free
 * scaffolding (compiled as ordinary source, like the llm `router-harness`). Unlike
 * the scripted llm mock provider (which returns a fixed script regardless of
 * input), this router INSPECTS each request's system prompt to decide which stage
 * it is answering (classify / map / reduce / single-pass generate) and calls the
 * matching handler with the user-message text.
 *
 * That is exactly what proves boundary-loss does not eat a planted fact: the `map`
 * handler is handed the real segment text the pipeline chunked, echoes back only
 * the facts it actually finds in that text, and the merged result must still carry
 * a fact spoken in the FIRST chunk and one spoken in the LAST.
 */

/** A parsed view of one incoming request: its stage + the user-turn content. */
export type NotesStage = "classify" | "map" | "reduce" | "generate" | "repair";

export interface NotesRouterCall {
  readonly stage: NotesStage;
  readonly userContent: string;
  /** The per-call meter the caller threaded via `opts.meter` (Phase 6), if any. */
  readonly meter?: Meter;
}

export interface NotesRouterHandlers {
  /** The one-word classification (default `"sales"`). */
  classify?: (userContent: string) => string;
  /** Chunk-facts object for a map call (default: empty facts + a mini-summary). */
  map?: (userContent: string) => unknown;
  /** Narrative object for the reduce call (default: a valid generic narrative). */
  reduce?: (userContent: string) => unknown;
  /** Notes object for a single-pass generate call (no default — set when used). */
  generate?: (userContent: string) => unknown;
}

export interface MockNotesRouter extends LlmRouter {
  readonly calls: NotesRouterCall[];
}

const DEFAULT_MAP = {
  miniSummary: "A segment of the call. Nothing notable was extracted here. End.",
  decisions: [],
  actionItems: [],
  openQuestions: [],
  risks: [],
  insights: {
    objections: [],
    buyingSignals: [],
    questionsAsked: [],
    answersToRevisit: [],
  },
};

const DEFAULT_REDUCE = {
  title: "Long call",
  tldr: "A long call summarised from its segments.",
  overview:
    "The call ran long and was summarised from ordered segment summaries, giving equal weight to the beginning and the end.",
  openQuestions: [],
  risks: [],
  typeInsights: { kind: "sales", objections: [], buyingSignals: [] },
};

/** Classify a request by its system prompt marker. */
function stageOf(req: ChatRequest): NotesStage {
  const system = req.messages.find((m) => m.role === "system")?.content ?? "";
  if (system.includes("label the type of a phone call")) return "classify";
  if (system.includes("extract structured facts from ONE SEGMENT")) return "map";
  if (system.includes("write the final notes for a LONG")) return "reduce";
  if (system.includes("fix a JSON object")) return "repair";
  return "generate";
}

/** The last user turn's content (what the model "reads"). */
function userContentOf(req: ChatRequest): string {
  const users = req.messages.filter((m) => m.role === "user");
  return users[users.length - 1]?.content ?? "";
}

/** Build a prompt-reading mock router over the given per-stage handlers. */
export function makeNotesRouter(
  handlers: NotesRouterHandlers = {},
): MockNotesRouter {
  const calls: NotesRouterCall[] = [];

  async function* stream(
    req: ChatRequest,
    opts?: { signal?: AbortSignal; meter?: Meter },
  ): AsyncGenerator<LlmStreamEvent> {
    const stage = stageOf(req);
    const userContent = userContentOf(req);
    calls.push(
      opts?.meter
        ? { stage, userContent, meter: opts.meter }
        : { stage, userContent },
    );
    await Promise.resolve(); // async generator: yields on the microtask queue



    let text: string;
    if (stage === "classify") {
      text = handlers.classify?.(userContent) ?? "sales";
    } else if (stage === "map") {
      text = JSON.stringify(handlers.map?.(userContent) ?? DEFAULT_MAP);
    } else if (stage === "reduce") {
      text = JSON.stringify(handlers.reduce?.(userContent) ?? DEFAULT_REDUCE);
    } else if (stage === "generate") {
      text = JSON.stringify(handlers.generate?.(userContent) ?? DEFAULT_REDUCE);
    } else {
      // A repair should not be needed in these suites (handlers return valid JSON);
      // echo an empty object so a stray repair fails loudly rather than hanging.
      text = "{}";
    }

    yield { type: "token", text };
    yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } };
  }

  return { calls, stream };
}
