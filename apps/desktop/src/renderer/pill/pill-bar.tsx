import { useEffect, useRef, type JSX } from "react";

import novaLogo from "../assets/nova-logo-transparent.png";
import {
  AudioBarsIcon,
  CheckIcon,
  DownArrowIcon,
  EyeIcon,
  FileIcon,
  IncognitoIcon,
  PauseGlyph,
  PlayGlyph,
  ReturnIcon,
  ScreenIcon,
  SquaresIcon,
} from "../design/icons";
import { NOVA_MODES } from "../design/modes";
import type { AudioSession } from "./audio-session";

interface PillBarProps {
  readonly focusMode: boolean;
  readonly onFocusAsk: () => void;
  readonly onBlurAsk: () => void;
  readonly usesScreen: boolean;
  readonly onToggleScreen: () => void;
  readonly undetectable: boolean;
  readonly onToggleUndetectable: () => void;
  readonly modeMenuOpen: boolean;
  readonly onToggleModeMenu: () => void;
  readonly activeMode: string;
  readonly onPickMode: (id: string) => void;
  readonly audio: AudioSession;
  readonly onStartAudio: () => void;
  readonly onTogglePause: () => void;
  readonly onStopAudio: () => void;
  readonly onOpenHistory: () => void;
  readonly onOpenTranscript: () => void;
}

/**
 * The pill's resting face: the ask row and the icon bar. Every visual value
 * comes from the interactive pill in the ratified mockup; the ONLY control
 * that reaches outside this window is the eye (undetectability) and the logo
 * (opens settings) — the rest is presentational state until later wiring.
 */
export function PillBar(props: PillBarProps): JSX.Element {
  const activeName =
    NOVA_MODES.find((mode) => mode.id === props.activeMode)?.name ?? "General";
  const askLabel = props.audio.on
    ? "Ask anything about the meeting"
    : props.usesScreen
      ? "Ask anything about your screen"
      : "Ask anything about your call";

  return (
    <>
      <div className="pill">
        <div className="pill__ask">
          {props.focusMode ? (
            <AskInput placeholder={askLabel} onBlur={props.onBlurAsk} />
          ) : (
            <span
              className="pill__tab-hint nd"
              onClick={props.onFocusAsk}
              role="button"
              tabIndex={-1}
            >
              <span className="pill__tab-chip">Tab</span>
              <span className="pill__tab-label">to focus</span>
            </span>
          )}
          <span className="corner-box">
            <ReturnIcon />
          </span>
        </div>

        <div className="pill__bar">
          <button
            type="button"
            className="pill__logo nd"
            title="Open Nova settings"
            onClick={() => {
              window.novaBridge.openSettings();
            }}
          >
            <img src={novaLogo} alt="Open Nova settings" />
          </button>

          <div className="pill__cluster">
            <span className="tipwrap">
              <span className="tip">Uses Screen</span>
              <button
                type="button"
                className={iconButton(props.usesScreen)}
                onClick={props.onToggleScreen}
              >
                <ScreenIcon />
              </button>
            </span>

            <span className="tipwrap">
              <span className="tip">
                {props.undetectable ? "Undetectable" : "Detectable"}
              </span>
              <button
                type="button"
                className={iconButton(props.undetectable)}
                onClick={props.onToggleUndetectable}
              >
                {props.undetectable ? <IncognitoIcon /> : <EyeIcon />}
              </button>
            </span>

            <span className="tipwrap">
              <span
                className={props.modeMenuOpen ? "tip tip--suppressed" : "tip"}
              >
                {activeName}
              </span>
              <button
                type="button"
                className={iconButton(props.modeMenuOpen)}
                onClick={props.onToggleModeMenu}
              >
                <SquaresIcon
                  filled={props.modeMenuOpen || props.activeMode !== "general"}
                />
              </button>
            </span>

            <span className="pill__divider" />

            <span className="tipwrap">
              <span className="tip">
                {props.audio.on ? "Stop Audio Session" : "Start Audio Session"}
              </span>
              <span
                className="audio-cluster"
                style={{ width: props.audio.on ? "140px" : "36px" }}
              >
                {props.audio.on ? (
                  <>
                    <button
                      type="button"
                      className="pill__pause nd"
                      title="Pause"
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
                  </>
                ) : (
                  <button
                    type="button"
                    className={iconButton(false)}
                    onClick={props.onStartAudio}
                  >
                    <AudioBarsIcon />
                  </button>
                )}
              </span>
            </span>
          </div>

          {props.audio.on ? (
            <button
              type="button"
              className="pill__transcript-link nd"
              onClick={props.onOpenTranscript}
            >
              <FileIcon />
              <span>Transcript</span>
            </button>
          ) : (
            <button
              type="button"
              className="pill__history-link nd"
              onClick={props.onOpenHistory}
            >
              <span className="pill__history-label">History</span>
              <span className="chip-24">
                <DownArrowIcon />
              </span>
            </button>
          )}
        </div>
      </div>

      {props.modeMenuOpen && (
        <div className="mode-menu nd">
          {NOVA_MODES.map((mode) => (
            <button
              type="button"
              key={mode.id}
              className="mode-menu__item"
              onClick={() => {
                props.onPickMode(mode.id);
              }}
            >
              <span className="mode-menu__name">{mode.name}</span>
              {mode.id === props.activeMode && <CheckIcon />}
            </button>
          ))}
          <div className="mode-menu__divider" />
          <button
            type="button"
            className="mode-menu__item"
            onClick={() => {
              window.novaBridge.openSettings();
            }}
          >
            <SquaresIcon size={16} />
            <span>Manage</span>
          </button>
        </div>
      )}
    </>
  );
}

function iconButton(on: boolean): string {
  return on ? "icon-btn icon-btn--on nd" : "icon-btn nd";
}

export function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${String(minutes)}:${seconds}`;
}

/** The focused ask field. Split out so mounting it is what focuses it. */
function AskInput({
  placeholder,
  onBlur,
}: {
  readonly placeholder: string;
  readonly onBlur: () => void;
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <input
      ref={ref}
      className="pill__input nd"
      placeholder={placeholder}
      onBlur={onBlur}
    />
  );
}
