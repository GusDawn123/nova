import { LIVE_PROTOCOL_VERSION, type ServerLiveEvent } from '@nova/shared';

import type { LiveReplayStep } from '@/hooks/use-live-session';

/**
 * A mic-less REPLAY fixture so the streaming pane can be exercised in the iOS
 * simulator without audio or a live server (Phase 8/9 add real mic capture). It
 * drives the SAME reducer the socket feeds, so it proves the pane behaviors 1:1:
 * deltas append as they arrive, `start` replaces in place, and `discard` clears
 * instantly (the mid-fixture speculation miss).
 */

const V = LIVE_PROTOCOL_VERSION;
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';

/** Split a body into ~word-group deltas to mimic coalesced token batches. */
function deltas(id: string, body: string): LiveReplayStep[] {
  const parts = body.match(/\S+\s*/g) ?? [body];
  const steps: LiveReplayStep[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts.slice(i, i + 2).join('');
    steps.push({
      delayMs: 60,
      event: { v: V, type: 'suggestion.delta', suggestion_id: id, text },
    });
  }
  return steps;
}

function final(text: string, speaker: string | null): ServerLiveEvent {
  return { v: V, type: 'transcript.final', text, speaker, ts_ms: 0, is_final: true };
}

const ANSWER_1 =
  'Event-sourced writes with idempotent consumers.\n\n- Version each record; readers reconcile on conflict.\n- Prefer append-only logs over in-place updates.';
const ANSWER_2 =
  'Kubernetes is a container orchestrator.\n\n- Schedules pods across a cluster.\n- Handles service discovery, scaling, and self-healing.';

export const LIVE_DEMO_FIXTURE: readonly LiveReplayStep[] = [
  { delayMs: 200, event: { v: V, type: 'session.ready', session_id: S1 } },
  {
    delayMs: 400,
    event: final("So what's your approach to handling data consistency?", 'them'),
  },
  {
    delayMs: 300,
    event: { v: V, type: 'suggestion.start', suggestion_id: S1, kind: 'answer' },
  },
  ...deltas(S1, ANSWER_1),
  {
    delayMs: 100,
    event: { v: V, type: 'suggestion.done', suggestion_id: S1, text: ANSWER_1 },
  },
  // A speculation that reconciles as a miss → discard clears the pane instantly.
  {
    delayMs: 900,
    event: { v: V, type: 'suggestion.start', suggestion_id: S2, kind: 'answer' },
  },
  ...deltas(S2, 'Well, it depends on the specific'),
  {
    delayMs: 200,
    event: {
      v: V,
      type: 'suggestion.discard',
      suggestion_id: S2,
      reason: 'speculation_reconcile_miss',
    },
  },
  {
    delayMs: 300,
    event: final('Actually — how does Kubernetes networking work?', 'them'),
  },
  {
    delayMs: 300,
    event: { v: V, type: 'suggestion.start', suggestion_id: S3, kind: 'answer' },
  },
  ...deltas(S3, ANSWER_2),
  {
    delayMs: 100,
    event: { v: V, type: 'suggestion.done', suggestion_id: S3, text: ANSWER_2 },
  },
];
