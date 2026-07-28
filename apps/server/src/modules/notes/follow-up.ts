import { z } from "zod";
import {
  followUpDraftSchema,
  type FollowUpDraft,
  type FollowUpTone,
  type MeetingNotes,
} from "@nova/shared";

import type { JobUsage } from "../../db/jobs.js";
import { withMeter, type LlmRouter, type Meter } from "../llm/index.js";

import { runLadder } from "./ladder.js";
import type { NotesLogger } from "./ports.js";
import {
  buildFollowUpMessages,
  buildFollowUpRepairMessages,
} from "./prompts/follow-up.js";

/**
 * The follow-up draft generator (adr-0006 §8). Its input is the VALIDATED notes
 * object, the requested tone, and the meeting title — it CANNOT receive a
 * transcript, so "cites-notes-only" holds by construction (the prompt builder only
 * ever sees notes-derived strings). Runs SYNCHRONOUSLY in the request (one small
 * call from stored notes; notes regeneration is the only queued job).
 *
 * Flow: the structured-output ladder (salvage → zod → one repair) over
 * `followUpDraftSchema` MINUS `tone` (the pipeline stamps the requested tone, the
 * same way the notes pipeline stamps `version`/`source`). On a CONTENT failure — the
 * ladder exhausts its rungs — a deterministic minimal draft is assembled from the
 * notes object IN CODE (still cites-notes-only by construction; `followUpDraftSchema`
 * has no `source` field, so `fellBack` is the observability flag). Transport failures
 * are NOT swallowed: a router throw (`LlmError`/`AllProvidersFailedError`) propagates
 * so the REST layer maps it to a typed 503 (never a 500 stack leak).
 */

/**
 * The ONLY inputs a follow-up draft is built from — no transcript by construction.
 * `userId`/`meetingId` (Phase 6) are metering ATTRIBUTION only — ids, not content,
 * so cites-notes-only still holds; they never reach a prompt builder.
 */
export interface FollowUpInput {
  readonly notes: MeetingNotes;
  readonly tone: FollowUpTone;
  readonly meetingTitle: string;
  readonly userId?: string;
  readonly meetingId?: string;
}

/** A generated draft + its per-call usage + whether the deterministic fallback fired. */
export interface FollowUpResult {
  readonly draft: FollowUpDraft;
  /** One {@link JobUsage} entry per router call (generate, then repair if spent). */
  readonly usage: JobUsage[];
  /** The ladder exhausted its rungs and the code-assembled fallback draft was used. */
  readonly fellBack: boolean;
}

/** Construction dependencies (mirrors the pipeline's locked shape). */
export interface FollowUpDeps {
  readonly router: LlmRouter;
  readonly logger: NotesLogger;
  /**
   * Per-request metering factory (Phase 6, adr-0007 §2 — `metering.meterFor`).
   * Applied only when the input carries a `userId`; the follow-up runs in a
   * request, so attribution comes with each call, not construction.
   */
  readonly meterFor?: (userId: string, meetingId?: string) => Meter;
}

/** The draft body schema the model must return — tone is stamped by the pipeline. */
const draftRequestSchema = followUpDraftSchema.omit({ tone: true });

/**
 * Build a follow-up draft runner over explicit deps (pure of env/DB). The returned
 * function's parameter type is {@link FollowUpInput}, which has no transcript field —
 * the type-level half of the cites-notes-only guarantee.
 */
export function generateFollowUp(
  deps: FollowUpDeps,
): (input: FollowUpInput) => Promise<FollowUpResult> {
  const { logger } = deps;

  return async function run(input: FollowUpInput): Promise<FollowUpResult> {
    const { notes, tone, meetingTitle } = input;
    const messages = buildFollowUpMessages({ notes, tone, meetingTitle });

    // Request-scoped metering (Phase 6): stamp the caller's attribution onto
    // every router call of this draft (generate + the one repair, if spent).
    const router =
      deps.meterFor && input.userId !== undefined
        ? withMeter(deps.router, deps.meterFor(input.userId, input.meetingId))
        : deps.router;

    const ladder = await runLadder({
      schema: draftRequestSchema,
      messages,
      router,
      repair: (invalidText, issues) =>
        buildFollowUpRepairMessages(invalidText, issues),
    });

    if (ladder.result.status === "ok") {
      const draft: FollowUpDraft = { tone, ...ladder.result.value };
      logger.info(
        {
          tone,
          repair_used: ladder.telemetry.repairUsed,
          model_calls: ladder.usage.length,
        },
        "notes.follow_up.generated",
      );
      return { draft, usage: ladder.usage, fellBack: false };
    }

    // Content failure: assemble a deterministic draft from the notes object IN CODE.
    // Still cites-notes-only (its content is drawn only from `notes`).
    const draft = buildFallbackFollowUp(notes, tone);
    logger.info(
      { tone, model_calls: ladder.usage.length },
      "notes.follow_up.fell_back",
    );
    return { draft, usage: ladder.usage, fellBack: true };
  };
}

/**
 * The ladder's last rung for a follow-up: a deterministic, always
 * `followUpDraftSchema`-valid draft assembled from the notes object (no model call).
 * Subject from the title; body a plain notes summary (tl;dr + agreed decisions +
 * action items) — cites-notes-only by construction. `min(1)` fields are guarded so
 * this can never fail the schema (the notes fields are themselves `min(1)`, but the
 * lists may be empty).
 */
export function buildFallbackFollowUp(
  notes: MeetingNotes,
  tone: FollowUpTone,
): FollowUpDraft {
  const lines = [`Following up on ${notes.title}.`, "", notes.tldr];

  if (notes.decisions.length > 0) {
    lines.push("", "What we agreed:");
    for (const d of notes.decisions) lines.push(`- ${d.text}`);
  }
  if (notes.actionItems.length > 0) {
    lines.push("", "Next steps:");
    for (const item of notes.actionItems) {
      const owner = item.owner !== null ? ` (${item.owner})` : "";
      const deadline = item.deadline !== null ? ` by ${item.deadline}` : "";
      lines.push(`- ${item.text}${owner}${deadline}`);
    }
  }

  const draft = {
    tone,
    subject: `Follow-up: ${notes.title}`,
    body: lines.join("\n"),
  };
  // Parse through the shared schema so the fallback is provably wire-valid.
  return followUpDraftSchema.parse(draft);
}

/** Re-exported for callers that want the request-body draft shape (tone omitted). */
export type FollowUpDraftBody = z.infer<typeof draftRequestSchema>;
