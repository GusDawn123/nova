/**
 * Public surface of modules/notes (RULES §2 — modules are islands; consumers import
 * only from here). Task 2 exposes the durable-queue worker + its config; Tasks 3–5
 * add the pipeline, writer, and REST surface behind this same barrel.
 */

export { createNotesWorker, type NotesWorkerDeps } from "./worker.js";
export {
  type NotesJobHandler,
  type NotesLogger,
  type NotesWorker,
  type ClaimedJob,
  type JobUsage,
} from "./ports.js";
export {
  notesConfig,
  notesConfigSchema,
  computeBackoff,
  type NotesConfig,
} from "./config.js";
