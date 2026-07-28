/**
 * Public surface of modules/notes (RULES §2 — modules are islands; consumers import
 * only from here). Task 2 exposes the durable-queue worker + its config; Tasks 3–5
 * add the pipeline, writer, and REST surface behind this same barrel.
 */

export { createNotesWorker, type NotesWorkerDeps } from "./worker.js";
export { createNotesPipeline, type NotesPipelineDeps } from "./pipeline.js";
export { createNotesJobHandler, type NotesJobHandlerDeps } from "./handler.js";
export {
  generateFollowUp,
  buildFallbackFollowUp,
  type FollowUpDeps,
  type FollowUpInput,
  type FollowUpResult,
} from "./follow-up.js";
export { createNotesRoutes, type NotesRoutesDeps } from "./routes.js";
export {
  type NotesJobHandler,
  type NotesLogger,
  type NotesWorker,
  type NotesPipeline,
  type NotesMeetingMeta,
  type NotesReader,
  type NotesReadModel,
  type NotesSource,
  type NotesSourceMeeting,
  type NotesWriter,
  type FollowUpWriter,
  type TranscriptTurn,
  type ClaimedJob,
  type JobUsage,
} from "./ports.js";
export {
  notesConfig,
  notesConfigSchema,
  computeBackoff,
  type NotesConfig,
} from "./config.js";
export { joinTranscriptText, verifyNotes } from "./verify-quotes.js";
export { reconcileIds, RECONCILE_THRESHOLD } from "./reconcile-ids.js";
/**
 * The live-notes fold (Phase 8). `modules/live`'s notes conductor owns the LOOP
 * and reaches the notes domain only through these — the prompt, the ops schema,
 * the reducer and the ladder all stay internal (RULES §2).
 */
export {
  applyFold,
  emptyLiveNotes,
  initialFoldState,
  deriveSeqCounters,
  foldResultSchema,
  MAX_OPS_PER_FOLD,
  LIVE_FORMING_TLDR,
  type FoldContext,
  type FoldOutcome,
  type FoldResult,
  type FoldState,
  type DroppedOp,
  type LiveFoldConfig,
  type SeqCounters,
} from "./live-fold.js";
export {
  createLiveFoldRunner,
  type FoldRequest,
  type LiveFoldRunner,
  type LiveFoldRunnerDeps,
} from "./live-fold-runner.js";
