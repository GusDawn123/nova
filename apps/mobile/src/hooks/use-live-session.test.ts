import { LIVE_PROTOCOL_VERSION, type MeetingNotes } from '@nova/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLiveSession } from './use-live-session';

/**
 * The two halves of `useLiveSession` that can actually be wrong.
 *
 * MODE: the hook owns the pick (screens dumb, hooks smart), puts it on the
 * `session.start` frame, and refuses to change it once a call is in flight — the
 * server locks the mode at start, so a picker that still looked live mid-call would
 * be lying.
 *
 * NOTES VISIBILITY: whether an arriving `notes.update` counts as unseen depends on
 * which capture tab is open, read from a REF at apply time rather than closed over.
 * The rev rule itself is pure and tested in `notes-update.test.ts`; what is tested
 * here is the plumbing between the screen's prop and the socket handler.
 *
 * Everything the hook reaches for is stubbed at its own seam: the auth session,
 * the supabase meeting insert, and the socket itself, which is where the
 * assertion lands — the actual bytes sent up the wire.
 */

const MEETING_ID = '11111111-1111-4111-8111-111111111111';

/** A minimal notes object that really parses as `meetingNotesSchema` (v2). */
const NOTES: MeetingNotes = {
  version: 2,
  conversationType: 'sales',
  title: 'Northwind discovery',
  tldr: 'Budget ceiling near $40k.',
  overview: 'A discovery call about pricing.',
  decisions: [],
  actionItems: [],
  openQuestions: [],
  risks: [],
  typeInsights: { kind: 'sales', objections: [], buyingSignals: [] },
  source: 'live',
};

/** The wire frame the live-notes fold emits after a rev-bumping fold. */
function notesUpdate(rev: number): unknown {
  return {
    v: LIVE_PROTOCOL_VERSION,
    type: 'notes.update',
    notes: NOTES,
    rev,
  };
}

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    status: 'signed-in',
    session: { user: { id: 'user-1' }, access_token: 'token-1' },
  }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve({ data: { id: MEETING_ID }, error: null }),
        }),
      }),
    }),
  },
}));

/** A WebSocket that records what was sent instead of opening one. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;

  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  /** Drive the handshake the way a real server would. */
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  /** Push a server frame down the wire, as JSON, exactly as the gateway does. */
  receive(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

/** The parsed `session.start` frame this socket sent, if any. */
function startFrame(socket: FakeSocket): Record<string, unknown> | undefined {
  for (const raw of socket.sent) {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.type === 'session.start') return parsed;
  }
  return undefined;
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useLiveSession mode', () => {
  it('starts on general, with the picker unlocked', () => {
    const { result } = renderHook(() => useLiveSession());

    expect(result.current.mode).toBe('general');
    expect(result.current.canPickMode).toBe(true);
  });

  it('puts the picked mode on the session.start frame', async () => {
    const { result } = renderHook(() => useLiveSession());

    act(() => {
      result.current.setMode('technical');
    });
    await act(async () => {
      await result.current.start();
    });
    const socket = FakeSocket.instances[0];
    expect(socket).toBeDefined();
    act(() => socket?.open());

    expect(startFrame(socket as FakeSocket)).toMatchObject({
      type: 'session.start',
      meeting_id: MEETING_ID,
      mode: 'technical',
    });
  });

  it('says general explicitly when nothing was picked', async () => {
    // The wire treats an absent mode as general, but sending it explicitly keeps
    // the frame self-describing, which is what makes a captured session readable.
    const { result } = renderHook(() => useLiveSession());

    await act(async () => {
      await result.current.start();
    });
    const socket = FakeSocket.instances[0];
    expect(socket).toBeDefined();
    act(() => socket?.open());

    expect(startFrame(socket as FakeSocket)).toMatchObject({
      mode: 'general',
    });
  });

  it('locks the mode once a session is in flight', async () => {
    const { result } = renderHook(() => useLiveSession());

    act(() => {
      result.current.setMode('behavioral');
    });
    await act(async () => {
      await result.current.start();
    });

    await waitFor(() => {
      expect(result.current.status).toBe('connecting');
    });
    expect(result.current.canPickMode).toBe(false);

    act(() => {
      result.current.setMode('finance');
    });
    expect(result.current.mode).toBe('behavioral');
  });
});

describe('useLiveSession live notes', () => {
  it('flags an update that lands while the notes panel is hidden', async () => {
    const { result } = renderHook(() =>
      useLiveSession({ notesPanelVisible: false }),
    );

    await act(async () => {
      await result.current.start();
    });
    const socket = FakeSocket.instances[0];
    expect(socket).toBeDefined();
    act(() => socket?.open());

    act(() => {
      socket?.receive(notesUpdate(1));
    });

    expect(result.current.liveNotes.rev).toBe(1);
    expect(result.current.liveNotes.hasUnseen).toBe(true);
  });

  it('marks an update seen when the panel is already on screen', async () => {
    // The tab is switched AFTER the socket is up, which is the case a closure over
    // `notesPanelVisible` gets wrong: the handler was installed while the panel was
    // hidden, so only a ref read at apply time sees the change.
    const { result, rerender } = renderHook(
      (props: { notesPanelVisible: boolean }) => useLiveSession(props),
      { initialProps: { notesPanelVisible: false } },
    );

    await act(async () => {
      await result.current.start();
    });
    const socket = FakeSocket.instances[0];
    expect(socket).toBeDefined();
    act(() => socket?.open());

    rerender({ notesPanelVisible: true });
    act(() => {
      socket?.receive(notesUpdate(1));
    });

    expect(result.current.liveNotes.notes?.tldr).toBe(NOTES.tldr);
    expect(result.current.liveNotes.hasUnseen).toBe(false);
  });
});
