/**
 * Public surface of modules/notes (RULES §2 — modules are islands; consumers import
 * only from here). Task 2 exposes the durable-queue worker + its config; Tasks 3–5
 * add the pipeline, writer, and REST surface behind this same barrel.
 */

export { createNotesWorker, type NotesWorkerDeps } from "./worker.js";
export { createNotesPipeline, type NotesPipelineDeps } from "./pipeline.js";
export {
  createNotesJobHandler,
  type NotesJobHandlerDeps,
} from "./handler.js";
export {
  generateFollowUp,
  buildFallbackFollowUp,
  type FollowUpDeps,
  type FollowUpInput,
  type FollowUpResult,
} from "./follow-up.js";
export {
  createNotesRoutes,
  type NotesRoutesDeps,
} from "./routes.js";
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
