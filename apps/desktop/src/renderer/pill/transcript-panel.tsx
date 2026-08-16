import { useEffect, useRef, type JSX } from "react";

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
import type { LiveSessionView } from "./use-live-session";

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

/** Within this many pixels of the bottom, the user is following, not reading. */
const STICK_TO_BOTTOM_PX = 48;

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

  // Follow the conversation: a transcript that doesn't keep the newest line
  // in view is a transcript the user has to chase mid-call. But a user who has
  // scrolled up is reading — partials arrive several times a second, and
  // yanking them back down every time makes scrollback impossible.
  useEffect(() => {
    const body = bodyRef.current;
    if (body === null) {
      return;
    }
    const distanceFromBottom =
      body.scrollHeight - body.scrollTop - body.clientHeight;
    if (distanceFromBottom <= STICK_TO_BOTTOM_PX) {
      body.scrollTop = body.scrollHeight;
    }
  }, [props.live.rows]);

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

      <div className="transcript__body" ref={bodyRef}>
        {props.live.rows.length === 0 ? (
          <div className="transcript__row">
            <span className="transcript__text transcript__text--hint">
              {emptyText(props.live)}
            </span>
          </div>
        ) : (
          props.live.rows.map((row) => (
            <div key={row.key} className="transcript__row">
              <span className="transcript__ts">{formatTs(row.tsMs)}</span>
              <div className="transcript__turn">
                <span className="transcript__who">
                  {row.speaker === "me"
                    ? "ME"
                    : row.speaker === "them"
                      ? "THEM"
                      : "—"}
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
          ))
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
