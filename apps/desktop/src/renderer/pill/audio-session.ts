/**
 * The pill's local picture of an audio session. Purely presentational until
 * real capture lands (pivot chunk 2) — the timer exists so the design's
 * listening state can be seen and toggled during UI review.
 */
export interface AudioSession {
  readonly on: boolean;
  readonly paused: boolean;
  readonly seconds: number;
}

export const AUDIO_OFF: AudioSession = { on: false, paused: false, seconds: 0 };
