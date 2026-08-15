import type { JSX } from "react";

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

interface TranscriptPanelProps {
  readonly audio: AudioSession;
  readonly onTogglePause: () => void;
  readonly onStopAudio: () => void;
  readonly onBack: () => void;
}

/** Placeholder turns, verbatim from the mockup, until live STT is wired in. */
const TURNS = [
  { at: "7:21", text: "Mm-hmm." },
  { at: "7:23", text: "So walk me through the rollout timeline again?" },
  { at: "7:29", text: "and the three sites go live in Q1." },
  { at: "7:31", text: "Honestly it's more than we planned to spend." },
  { at: "7:46", text: "Oh, no." },
];

/**
 * The live-transcript view of an audio session. The session controls here are
 * the same presentational state the pill bar drives; the logo opens settings.
 */
export function TranscriptPanel(props: TranscriptPanelProps): JSX.Element {
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

      <div className="transcript__body">
        {TURNS.map((turn) => (
          <div key={turn.at} className="transcript__row">
            <span className="transcript__ts">{turn.at}</span>
            <div className="transcript__turn">
              <span className="transcript__who">ME</span>
              <span className="transcript__text">{turn.text}</span>
            </div>
          </div>
        ))}
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
