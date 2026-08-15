import type { JSX } from "react";

import novaLogo from "../assets/nova-logo-transparent.png";
import {
  BackIcon,
  CalendarIcon,
  DocIcon,
  NewChatIcon,
  RefreshIcon,
  ReturnIcon,
  SearchIcon,
} from "../design/icons";

interface HistoryPanelProps {
  readonly onBack: () => void;
}

/** A past or upcoming session row. Placeholder data until history is wired. */
const SESSIONS = [
  { title: "Weekend Crew Scheduling Call", duration: "4h 8m", time: "3:00 PM" },
  { title: "Untitled session", duration: "1m", time: "10:30 AM" },
  { title: "Untitled session", duration: "1m", time: "10:30 AM" },
];

/**
 * The pill unfolded into its history view — upcoming meetings and past
 * sessions, verbatim from the mockup. Every row is a dead end for now; the
 * back button and the footer chrome are the live parts.
 */
export function HistoryPanel({ onBack }: HistoryPanelProps): JSX.Element {
  return (
    <div className="history">
      <div className="history__head">
        <button
          type="button"
          className="history__back nd"
          title="Back to pill"
          onClick={onBack}
        >
          <BackIcon size={16} />
        </button>
        <span className="history__ask">Ask or search anything</span>
        <span className="history__search">
          <SearchIcon />
        </span>
      </div>

      <div className="history__body">
        <span className="history__label">
          UPCOMING
          <RefreshIcon />
        </span>
        <div className="history__row history__row--filled nd" role="button">
          <span className="history__row-icon">
            <CalendarIcon />
          </span>
          <span className="history__row-title">Connect your calendar</span>
        </div>

        <span className="history__label history__label--dated">
          FRI, AUG 14, 2026
        </span>
        {SESSIONS.map((session, index) => (
          <div
            key={`${session.title}-${String(index)}`}
            className={
              index === 0
                ? "history__row history__row--filled nd"
                : "history__row nd"
            }
            role="button"
          >
            <span className="history__row-icon">
              <DocIcon />
            </span>
            <span className="history__row-title">{session.title}</span>
            <span className="history__duration">{session.duration}</span>
            <span className="history__time">{session.time}</span>
          </div>
        ))}
        <div className="history__spacer" />
      </div>

      <div className="history__foot">
        <span className="pill__logo">
          <img src={novaLogo} alt="Nova" />
        </span>
        <span className="history__foot-spacer" />
        <span className="history__open">
          Open
          <span className="chip-28">
            <ReturnIcon size={14} />
          </span>
        </span>
        <span className="history__foot-divider" />
        <span className="history__new-chat">
          <NewChatIcon />
          New chat
          <span className="key-chip">Ctrl</span>
          <span className="key-chip">R</span>
        </span>
      </div>
    </div>
  );
}
