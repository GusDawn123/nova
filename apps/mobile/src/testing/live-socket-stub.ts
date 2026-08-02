import { vi } from 'vitest';

/**
 * A WebSocket that records what was sent instead of opening one.
 *
 * Lifted out of `hooks/use-live-session.test.ts` at its second use (the cockpit
 * screen suite), the same way the Reanimated stub was — the live screen's behaviour
 * IS the socket conversation, so both suites have to drive the same fake.
 *
 * It is deliberately thin: the parts a client actually touches (`readyState`, the
 * four handlers, `send`, `close`) plus two drivers for the test to play server with.
 * Nothing here simulates the gateway's rules; a test that wants a policy close sends
 * one.
 */
export class FakeLiveSocket {
  static instances: FakeLiveSocket[] = [];
  static readonly OPEN = 1;

  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeLiveSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  /** Drive the handshake the way a real server would. */
  open(): void {
    this.readyState = FakeLiveSocket.OPEN;
    this.onopen?.();
  }

  /** Push a server frame down the wire, as JSON, exactly as the gateway does. */
  receive(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  /** Every frame this socket sent, parsed. */
  frames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  /** The first frame of a given `type` this socket sent, if any. */
  frame(type: string): Record<string, unknown> | undefined {
    return this.frames().find((parsed) => parsed.type === type);
  }
}

/** Replace the global `WebSocket` for one test file. Pair with `vi.unstubAllGlobals`. */
export function installFakeWebSocket(): void {
  FakeLiveSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeLiveSocket);
}
