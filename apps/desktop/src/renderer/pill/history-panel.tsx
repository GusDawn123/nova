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
import { useMeetings } from "../hooks/use-meetings";
import { groupByDay, meetingDuration, meetingTime } from "./meeting-format";

interface HistoryPanelProps {
  readonly onBack: () => void;
  /** Open one meeting's notes. The panel only names the id; the app routes. */
  readonly onOpenMeeting: (meetingId: string, title: string) => void;
}

/**
 * The pill unfolded into its history view — the real meetings list, in the
 * mockup's exact geometry. Loading, failure and emptiness are all said in
 * words on the same rows the data would occupy; the calendar row and the
 * footer chrome keep their mockup role until their features land.
 */
export function HistoryPanel({
  onBack,
  onOpenMeeting,
}: HistoryPanelProps): JSX.Element {
  const { state, reload } = useMeetings();

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
          <button
            type="button"
            className="history__refresh nd"
            title="Refresh sessions"
            onClick={reload}
          >
            <RefreshIcon />
          </button>
        </span>
        <div className="history__row history__row--filled nd" role="button">
          <span className="history__row-icon">
            <CalendarIcon />
          </span>
          <span className="history__row-title">Connect your calendar</span>
        </div>

        {state.status === "loading" && (
          <span className="history__label history__label--dated">LOADING…</span>
        )}

        {state.status === "error" && (
          <>
            <span className="history__label history__label--dated">
              SESSIONS
            </span>
            <div className="history__row nd">
              <span className="history__row-title">{state.message}</span>
            </div>
            <button
              type="button"
              className="history__row history__row--filled nd"
              onClick={reload}
            >
              <span className="history__row-icon">
                <RefreshIcon />
              </span>
              <span className="history__row-title">Try again</span>
            </button>
          </>
        )}

        {state.status === "success" && state.meetings.length === 0 && (
          <>
            <span className="history__label history__label--dated">
              SESSIONS
            </span>
            <div className="history__row nd">
              <span className="history__row-title">
                No sessions yet — your first call's notes will land here.
              </span>
            </div>
          </>
        )}

        {state.status === "success" &&
          groupByDay(state.meetings).map((group) => (
            <div key={group.label} className="history__group">
              <span className="history__label history__label--dated">
                {group.label}
              </span>
              {group.items.map((meeting) => {
                const duration = meetingDuration(meeting);
                return (
                  <button
                    key={meeting.id}
                    type="button"
                    className="history__row nd"
                    onClick={() => {
                      onOpenMeeting(meeting.id, meeting.title);
                    }}
                  >
                    <span className="history__row-icon">
                      <DocIcon />
                    </span>
                    <span className="history__row-title">{meeting.title}</span>
                    {duration !== null && (
                      <span className="history__duration">{duration}</span>
                    )}
                    <span className="history__time">
                      {meetingTime(meeting)}
                    </span>
                  </button>
                );
              })}
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
