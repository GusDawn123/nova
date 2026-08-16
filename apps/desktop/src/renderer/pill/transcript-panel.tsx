import { memo, useEffect, useRef, useState, type JSX } from "react";

import novaLogo from "../assets/nova-logo-transparent.png";
import {
  BackIcon,
  ChatIcon,
  PauseGlyph,
  PlayGlyph,
  ReturnIcon,
} from "../design/icons";
import type { AudioSession } from "./audio-session";
import { formatSeconds } from "./pill-bar";
import type { LiveSessionView, TranscriptRow } from "./use-live-session";

interface TranscriptPanelProps {
  readonly audio: AudioSession;
  readonly live: LiveSessionView;
  readonly onTogglePause: () => void;
  readonly onStopAudio: () => void;
  readonly onBack: () => void;
}

/** Call-relative `mm:ss` from the transcript event's audio-time offset. */
function formatTs(tsMs: number): string {
  return formatSeconds(Math.max(0, Math.floor(tsMs / 1000)));
}

/** Within this many pixels of the bottom, the user is following the call. */
const FOLLOW_STICK_PX = 48;

/** Smooth only for people who asked for motion. */
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

/** The panel's growth cap: half the screen tall, then it scrolls inside
 * itself instead of growing the window further. */
function transcriptMaxHeight(): number {
  return Math.max(320, Math.round(window.screen.height / 2));
}

/**
 * One transcript line, memoized on its (immutable) row object: an in-flight
 * partial re-rendering several times a second must not repaint the whole
 * call above it — with no retention limit, that history can be hours long.
 */
const TranscriptLine = memo(function TranscriptLine(props: {
  readonly row: TranscriptRow;
  /** Entrance animation — only for rows that ARRIVE while the panel is open.
   * Rows already present when it opens render still: replaying hundreds of
   * entrances in one frame on reopen is noise, not motion. */
  readonly animate: boolean;
}): JSX.Element {
  const { row } = props;
  return (
    <div
      className={
        props.animate ? "transcript__row transcript__row--in" : "transcript__row"
      }
    >
      <span className="transcript__ts">{formatTs(row.tsMs)}</span>
      <div className="transcript__turn">
        <span className="transcript__who">
          {row.speaker === "me" ? "ME" : row.speaker === "them" ? "THEM" : "—"}
        </span>
        <span
          className={
            row.final
              ? "transcript__text"
              : "transcript__text transcript__text--partial"
          }
        >
          {row.text}
        </span>
      </div>
    </div>
  );
});

/** What an empty transcript should say for each session state. */
function emptyText(live: LiveSessionView): string {
  switch (live.state) {
    case "connecting":
      return "Connecting…";
    case "live":
      return "Listening — say something.";
    case "error":
      return live.message ?? "The live session hit an error.";
    default:
      return "Start a session to see the live transcript.";
  }
}

/**
 * The live-transcript view of an audio session: real rows from main's
 * `liveEvent` push, labelled by stream (chunk 3 — the channels ARE the
 * speakers). Partial rows render dimmed until the vendor commits them.
 */
export function TranscriptPanel(props: TranscriptPanelProps): JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastScrollTop = useRef(0);
  const firstScroll = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const [maxHeight] = useState(transcriptMaxHeight);

  // Following is broken by any UPWARD move out of the stick zone — even a
  // short scroll-back to the previous line is deliberate reading. It cannot
  // be broken by the auto-scroll itself: programmatic scrolls only ever move
  // DOWN. Reaching the bottom again (or the button) restores it.
  const onScroll = (): void => {
    const body = bodyRef.current;
    if (body === null) {
      return;
    }
    const distance = body.scrollHeight - body.scrollTop - body.clientHeight;
    const movedUp = body.scrollTop < lastScrollTop.current;
    lastScrollTop.current = body.scrollTop;
    if (distance <= FOLLOW_STICK_PX) {
      following.current = true;
      setShowLatest(false);
    } else if (movedUp) {
      following.current = false;
      setShowLatest(true);
    }
  };

  const jumpToLatest = (): void => {
    const body = bodyRef.current;
    if (body === null) {
      return;
    }
    following.current = true;
    setShowLatest(false);
    body.scrollTo({ top: body.scrollHeight, behavior: scrollBehavior() });
  };

  // Follow the conversation: while the user is at the bottom, each new line
  // scrolls smoothly into view. A user who scrolled up is reading — partials
  // arrive several times a second, and yanking them back down every time
  // would make scrollback impossible. The first scroll after opening the
  // panel is instant: animating through an hour of history would be noise.
  useEffect(() => {
    const body = bodyRef.current;
    if (body === null || !following.current) {
      return;
    }
    body.scrollTo({
      top: body.scrollHeight,
      behavior: firstScroll.current ? "auto" : scrollBehavior(),
    });
    firstScroll.current = false;
  }, [props.live.rows]);

  // The rows already on screen when the panel opens: they render without the
  // entrance animation (see TranscriptLine). Snapshotted once so the class
  // set never flips on a mounted row — changing `animation` replays it.
  const initialKeys = useRef<ReadonlySet<string> | null>(null);
  initialKeys.current ??= new Set(props.live.rows.map((row) => row.key));

  return (
    <div className="panel">
      <div className="panel__head">
        <button
          type="button"
          className="panel__btn panel__btn--click nd"
          title="Back to pill"
          onClick={props.onBack}
        >
          <BackIcon />
        </button>
        <span className="pill__tab-hint">
          <span className="pill__tab-chip">Tab</span>
          <span className="pill__tab-label">to focus</span>
        </span>
        <span className="panel__spring" />
        <span className="panel__btn">
          <ReturnIcon />
        </span>
      </div>

      <div className="transcript__view">
        <div
          className="transcript__body nd"
          ref={bodyRef}
          onScroll={onScroll}
          style={{ maxHeight }}
        >
          {props.live.rows.length === 0 ? (
            <div className="transcript__row">
              <span className="transcript__text transcript__text--hint">
                {emptyText(props.live)}
              </span>
            </div>
          ) : (
            props.live.rows.map((row) => (
              <TranscriptLine
                key={row.key}
                row={row}
                animate={initialKeys.current?.has(row.key) !== true}
              />
            ))
          )}
        </div>
        {showLatest && (
          <button
            type="button"
            className="transcript__latest nd"
            onClick={jumpToLatest}
          >
            ↓ Latest
          </button>
        )}
      </div>

      <div className="transcript__foot">
        <button
          type="button"
          className="transcript__logo nd"
          title="Open Nova settings"
          onClick={() => {
            window.novaBridge.openSettings();
          }}
        >
          <img src={novaLogo} alt="Open Nova settings" />
        </button>
        <div className="transcript__controls">
          <button
            type="button"
            className="pill__pause nd"
            onClick={props.onTogglePause}
          >
            {props.audio.paused ? <PlayGlyph /> : <PauseGlyph />}
          </button>
          <button
            type="button"
            className="pill__stop nd"
            title="Stop session"
            onClick={props.onStopAudio}
          >
            <span className="pill__stop-square" />
          </button>
          <span className="pill__time">
            {formatSeconds(props.audio.seconds)}
          </span>
        </div>
        <button
          type="button"
          className="transcript__chat-link nd"
          onClick={props.onBack}
        >
          <ChatIcon />
          <span>View Chat</span>
        </button>
      </div>
    </div>
  );
}
