import { useEffect, useRef, useState, type JSX } from "react";

import {
  AudioBarsIcon,
  BackIcon,
  DownArrowIcon,
  EyeIcon,
  IncognitoIcon,
  ReturnIcon,
  ScreenIcon,
  SquaresIcon,
} from "../design/icons";
import type { LiveSessionView } from "./use-live-session";

/**
 * The pill's "answering" state (mockup `Nova Pill.dc.html`, state 3a): the pill
 * transforms into a panel — the user's question as a right-hand bubble, the
 * answer streaming below it, a scroll-down float when the reader leaves the
 * bottom, and a New Chat footer (Ctrl+R per the Keybinds tab). One Q/A at a
 * time: a new ask replaces the pane, mirroring the server's one-focal-pane law.
 */

/** What the user asked, captured by pill-app at the moment the ask fired. */
export interface AskContext {
  /** The typed question, or null for the empty-handed Answer press. */
  readonly question: string | null;
  /** Call-clock label of the last transcript line at ask time ("14:22"). */
  readonly heardLabel: string | null;
}

interface AnsweringPanelProps {
  readonly live: LiveSessionView;
  readonly ask: AskContext;
  readonly usesScreen: boolean;
  readonly onToggleScreen: () => void;
  readonly undetectable: boolean;
  readonly onToggleUndetectable: () => void;
  readonly onOpenModes: () => void;
  readonly onOpenTranscript: () => void;
  readonly onNewChat: () => void;
  readonly onBack: () => void;
}

/** Within this many pixels of the bottom, the reader is following the answer. */
const FOLLOW_STICK_PX = 48;
/** One Shift+Ctrl+arrow press moves the answer this far. */
const KEY_SCROLL_PX = 140;

/** Smooth only for people who asked for motion. */
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

/** The panel's growth cap — half the screen, like the transcript panel. */
function answerMaxHeight(): number {
  return Math.max(260, Math.round(window.screen.height / 2));
}

export function AnsweringPanel(props: AnsweringPanelProps): JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastScrollTop = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const [maxHeight] = useState(answerMaxHeight);
  const suggestion = props.live.suggestion;

  // Same follow contract as the transcript: only an UPWARD move breaks
  // following (programmatic scrolls only ever move down); the bottom restores it.
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
      setShowJump(false);
    } else if (movedUp) {
      following.current = false;
      setShowJump(true);
    }
  };

  const jumpToLatest = (): void => {
    const body = bodyRef.current;
    if (body === null) {
      return;
    }
    following.current = true;
    setShowJump(false);
    body.scrollTo({ top: body.scrollHeight, behavior: scrollBehavior() });
  };

  // Keep the streaming tail in view while the reader is following.
  useEffect(() => {
    const body = bodyRef.current;
    if (body === null || !following.current) {
      return;
    }
    body.scrollTo({ top: body.scrollHeight, behavior: "auto" });
  }, [suggestion?.text]);

  // Shift+Ctrl+↑/↓ — "Scroll the response window", exactly as the Keybinds tab
  // promises. Window-level so it works without the body being focused.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || !event.shiftKey) {
        return;
      }
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
        return;
      }
      event.preventDefault();
      bodyRef.current?.scrollBy({
        top: event.key === "ArrowDown" ? KEY_SCROLL_PX : -KEY_SCROLL_PX,
        behavior: scrollBehavior(),
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

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

      <div className="answer__view">
        <div
          className="answer__body nd"
          ref={bodyRef}
          onScroll={onScroll}
          style={{ maxHeight }}
        >
          {/* Announces state changes (thinking / ready) without narrating
              every streamed delta. */}
          <span className="visually-hidden" role="status">
            {suggestion === null
              ? "Nova is thinking"
              : suggestion.done
                ? "Nova answer ready"
                : "Nova is answering"}
          </span>
          {props.ask.question !== null && (
            <div className="answer__bubble">{props.ask.question}</div>
          )}
          <div className="answer__block">
            {props.ask.heardLabel !== null && (
              <span className="answer__caption">
                Heard on call · {props.ask.heardLabel}
              </span>
            )}
            {suggestion === null ? (
              <span className="answer__hint">Nova is thinking…</span>
            ) : (
              <div
                className={
                  suggestion.done
                    ? "answer__text"
                    : "answer__text answer__text--streaming"
                }
              >
                {suggestion.text === "" ? "…" : suggestion.text}
              </div>
            )}
          </div>
        </div>
        {showJump && (
          <button
            type="button"
            className="answer__scroll nd"
            title="Jump to latest"
            onClick={jumpToLatest}
          >
            <DownArrowIcon />
          </button>
        )}
      </div>

      <div className="answer__foot">
        <div className="answer__foot-cluster">
          <button
            type="button"
            className={
              props.usesScreen ? "icon-btn icon-btn--on nd" : "icon-btn nd"
            }
            title="Uses Screen"
            onClick={props.onToggleScreen}
          >
            <ScreenIcon />
          </button>
          <button
            type="button"
            className={
              props.undetectable ? "icon-btn icon-btn--on nd" : "icon-btn nd"
            }
            title={props.undetectable ? "Undetectable" : "Detectable"}
            onClick={props.onToggleUndetectable}
          >
            {props.undetectable ? <IncognitoIcon /> : <EyeIcon />}
          </button>
          <button
            type="button"
            className="icon-btn nd"
            title="Modes"
            onClick={props.onOpenModes}
          >
            <SquaresIcon />
          </button>
          <span className="pill__divider" />
          <button
            type="button"
            className="icon-btn nd"
            title="Live transcript"
            onClick={props.onOpenTranscript}
          >
            <AudioBarsIcon />
          </button>
        </div>
        <button
          type="button"
          className="answer__newchat nd"
          onClick={props.onNewChat}
        >
          <span>New Chat</span>
          <span className="answer__key">Ctrl</span>
          <span className="answer__key">R</span>
        </button>
      </div>
    </div>
  );
}
