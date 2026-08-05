import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeLiveSocket, installFakeWebSocket } from '@/testing/live-socket-stub';

import { useLiveSession } from './use-live-session';

/**
 * The half of `useLiveSession` that can actually be wrong.
 *
 * MODE: the hook owns the pick (screens dumb, hooks smart), puts it on the
 * `session.start` frame, and refuses to change it once a call is in flight — the
 * server locks the mode at start, so a picker that still looked live mid-call would
 * be lying.
 *
 * Everything the hook reaches for is stubbed at its own seam: the auth session,
 * the supabase meeting insert, and the socket itself, which is where the
 * assertion lands — the actual bytes sent up the wire.
 */

const MEETING_ID = '11111111-1111-4111-8111-111111111111';

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

/** The parsed `session.start` frame this socket sent, if any. */
function startFrame(socket: FakeLiveSocket): Record<string, unknown> | undefined {
  return socket.frame('session.start');
}

beforeEach(() => {
  installFakeWebSocket();
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
    const socket = FakeLiveSocket.instances[0];
    expect(socket).toBeDefined();
    act(() => socket?.open());

    expect(startFrame(socket as FakeLiveSocket)).toMatchObject({
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
    const socket = FakeLiveSocket.instances[0];
    expect(socket).toBeDefined();
    act(() => socket?.open());

    expect(startFrame(socket as FakeLiveSocket)).toMatchObject({
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
