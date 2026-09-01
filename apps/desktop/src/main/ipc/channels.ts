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
  apiMeetingsList: "nova:api:meetings-list",
  apiMeetingNotes: "nova:api:meeting-notes",
  apiMeetingTranscript: "nova:api:meeting-transcript",
  apiNotesRegenerate: "nova:api:notes-regenerate",
  apiFollowUpDraft: "nova:api:follow-up-draft",
  liveStart: "nova:live:start",
  liveStop: "nova:live:stop",
  liveAsk: "nova:live:ask",
  privacyGetState: "nova:privacy:get-state",
  privacySetState: "nova:privacy:set-state",
  /**
   * main → renderer, push. The UI cannot poll for this: a token refresh or a
   * restored session happens on Supabase's schedule, not on a click.
   */
  authStateChanged: "nova:auth:state-changed",
  /**
   * main → renderer, push. Two windows show the same undetectability state
   * (the pill's eye, the settings toggle); a change made in one must land in
   * the other without either polling.
   */
  privacyStateChanged: "nova:privacy:state-changed",
  /**
   * main → renderer, push. Transcript lines and session states arrive on the
   * server's schedule, not on a click — the pill can only listen.
   */
  liveEvent: "nova:live:event",
  /**
   * renderer → main, one-way. No answer to give: the pill asks main to open
   * the settings window, to resize the pill window to its content, or to let
   * clicks fall through its invisible gutters — all fire-and-forget window
   * management.
   */
  settingsOpen: "nova:settings:open",
  pillResize: "nova:pill:resize",
  pillClickThrough: "nova:pill:click-through",
  liveSetPaused: "nova:live:set-paused",
} as const;

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];
