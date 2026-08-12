import { contextBridge } from "electron";

/**
 * Everything the renderer is allowed to reach, in one namespaced object.
 * `contextIsolation` means nothing else crosses from the main process, so this
 * type is the complete privilege surface of the UI — keep it that way.
 *
 * Empty in this chunk: the scaffold proves the bridge exists and is named. The
 * first real channel arrives with the feature work.
 */
export type NovaBridge = Record<string, never>;

const novaBridge: NovaBridge = {};

contextBridge.exposeInMainWorld("novaBridge", novaBridge);
