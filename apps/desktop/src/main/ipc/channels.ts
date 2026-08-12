/**
 * Every IPC channel name, in one place.
 *
 * A channel name is a string shared by three files that never import each other
 * at runtime (main's handlers, the preload bridge, and — through the bridge —
 * the renderer). A typo in any one of them is a hang, not a compile error, which
 * is exactly the failure this constant exists to make impossible.
 *
 * Namespaced `nova:<area>:<verb>` so nothing in Electron's own channel space,
 * or in a dependency that decides to talk over IPC, can collide with ours.
 */
export const IpcChannel = {
  /** renderer → main, request/response. */
  authSignIn: "nova:auth:sign-in",
  authSignUp: "nova:auth:sign-up",
  authSignOut: "nova:auth:sign-out",
  authGetState: "nova:auth:get-state",
  apiGetMe: "nova:api:get-me",
  /**
   * main → renderer, push. The UI cannot poll for this: a token refresh or a
   * restored session happens on Supabase's schedule, not on a click.
   */
  authStateChanged: "nova:auth:state-changed",
} as const;

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];
