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
import { AnswerMarkdown } from "./answer-markdown";
import type { LiveSessionView } from "./use-live-session";

/**
 * The pill's "answering" state (mockup `Nova Pill.dc.html`, state 3a): the pill
 * transforms into a scrollable THREAD — completed Q/As stack oldest-first, the
 * current answer streams at the bottom as rendered markdown, a scroll-down
 * float appears when the reader leaves the bottom, and New Chat (Ctrl+R) wipes
 * the chat. The panel grows with content up to half the screen (measured, not
 * hard-coded), then scrolls inside itself. One GENERATION at a time still —
 * the thread is renderer memory; the server keeps its one-focal-pane law.
 */

/** What the user asked, captured by pill-app at the moment the ask fired. */
export interface AskContext {
  /** The typed question, or null for the empty-handed Answer press. */
  readonly question: string | null;
  /** Call-clock label of the last transcript line at ask time ("14:22"). */
  readonly heardLabel: string | null;
  /** The transport's refusal, when the ask never reached the server. */
  readonly error: string | null;
}

/** A finished Q/A the thread keeps above the current one (New Chat wipes it). */
export interface ThreadTurn {
  readonly question: string | null;
  readonly heardLabel: string | null;
  readonly answer: string;
}

interface AnsweringPanelProps {
  readonly live: LiveSessionView;
  readonly ask: AskContext;
  /** Completed Q/As from earlier asks in this chat, oldest first. */
  readonly thread: readonly ThreadTurn[];
  readonly usesScreen: boolean;
  readonly onToggleScreen: () => void;
  readonly undetectable: boolean;
  readonly onToggleUndetectable: () => void;
  readonly onOpenModes: () => void;
  readonly onOpenTranscript: () => void;
  readonly onNewChat: () => void;
  /** Tab (and the chip) hand the keyboard to the pill's ask field. */
  readonly onFocusAsk: () => void;
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

  // What stands in the answer's place while there is none. A failed ask and a
  // dead session must not look like a slow answer, forever.
  const emptyState: { text: string; failed: boolean } =
    props.ask.error !== null
      ? { text: props.ask.error, failed: true }
      : props.live.state === "error"
        ? {
            text: props.live.message ?? "The live session hit an error.",
            failed: true,
          }
        : props.live.state === "ended"
          ? {
              text: "The session ended before Nova could answer.",
              failed: true,
            }
          : { text: "Nova is thinking…", failed: false };

  // Screen readers ignore a live region's INITIAL content — only changes
  // announce. Mounting empty and setting the label post-mount makes the first
  // state a change too.
  const statusLabel =
    suggestion === null
      ? emptyState.failed
        ? "Nova could not answer"
        : "Nova is thinking"
      : suggestion.done
        ? "Nova answer ready"
        : "Nova is answering";
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    setAnnounced(statusLabel);
  }, [statusLabel]);

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

  // Keep the streaming tail in view while the reader is following — and jump
  // when a new turn joins the thread (an ask just fired).
  useEffect(() => {
    const body = bodyRef.current;
    if (body === null || !following.current) {
      return;
    }
    body.scrollTo({ top: body.scrollHeight, behavior: "auto" });
  }, [suggestion?.text, props.thread.length]);

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

  // The chip promises Tab. That outranks in-panel Tab cycling (the 2026-08-22
  // worry): every control here is mouse-reachable, the ask field is not.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") {
        return;
      }
      event.preventDefault();
      props.onFocusAsk();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [props.onFocusAsk]);

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
        <span
          className="pill__tab-hint nd"
          onClick={props.onFocusAsk}
          role="button"
          tabIndex={-1}
        >
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
          {/* Announces state changes (thinking / ready / failed) without
              narrating every streamed delta. */}
          <span className="visually-hidden" role="status">
            {announced}
          </span>
          {props.thread.map((turn, index) => (
            // Index keys are safe here: the thread is append-only and only
            // ever wiped whole (New Chat / a fresh call).
            <div className="answer__turn" key={index}>
              {turn.question !== null && (
                <div className="answer__bubble">{turn.question}</div>
              )}
              <div className="answer__block">
                {turn.heardLabel !== null && (
                  <span className="answer__caption">
                    Heard on call · {turn.heardLabel}
                  </span>
                )}
                <AnswerMarkdown text={turn.answer} streaming={false} />
              </div>
            </div>
          ))}
          <div className="answer__turn answer__turn--current">
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
                <span
                  className={
                    emptyState.failed
                      ? "answer__hint answer__hint--failed"
                      : "answer__hint"
                  }
                >
                  {emptyState.text}
                </span>
              ) : suggestion.text === "" ? (
                <span className="answer__hint">…</span>
              ) : (
                <AnswerMarkdown
                  text={suggestion.text}
                  streaming={!suggestion.done}
                />
              )}
            </div>
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
