import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type {
  FollowUpDraft,
  FollowUpTone,
  MeetingTranscriptTurn,
  NotesReadResponse,
} from "@nova/shared";

import { BackIcon, RefreshIcon } from "../design/icons";

interface NotesViewProps {
  readonly meetingId: string;
  /** The list row's title — shown immediately, before the read lands. */
  readonly title: string;
  readonly onBack: () => void;
}

type NotesTab = "notes" | "transcript" | "follow-up";

type ReadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; read: NotesReadResponse };

type TranscriptState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; turns: readonly MeetingTranscriptTurn[] };

/** While the server is still folding a call, re-read on this cadence. */
const GENERATING_POLL_MS = 4000;

const TONES: readonly FollowUpTone[] = ["professional", "warm", "brief"];

/** `07:03` from a call-relative offset; an em dash when the vendor gave none. */
function turnStamp(turn: MeetingTranscriptTurn): string {
  if (turn.ts_ms === null) {
    return "—";
  }
  const total = Math.floor(turn.ts_ms / 1000);
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

/**
 * One meeting unfolded: the post-call notes, the transcript, and the follow-up
 * draft, in the pill's own geometry. The notes tab polls while the server is
 * still generating — "GENERATING" with a live caret is a state, not a spinner —
 * and every failure arrives as main's own sentence plus a retry.
 */
export function NotesView({
  meetingId,
  title,
  onBack,
}: NotesViewProps): JSX.Element {
  const [tab, setTab] = useState<NotesTab>("notes");
  const [read, setRead] = useState<ReadState>({ status: "loading" });
  const [transcript, setTranscript] = useState<TranscriptState>({
    status: "idle",
  });
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenNote, setRegenNote] = useState<string | null>(null);
  const [tone, setTone] = useState<FollowUpTone>("professional");
  const [followBusy, setFollowBusy] = useState(false);
  const [followNote, setFollowNote] = useState<string | null>(null);
  const [draft, setDraft] = useState<FollowUpDraft | null>(null);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadRead = useCallback(async () => {
    const result = await window.novaBridge.meetingNotes(meetingId);
    if (!alive.current) {
      return;
    }
    setRead(
      result.ok
        ? { status: "success", read: result.data }
        : { status: "error", message: result.message },
    );
  }, [meetingId]);

  useEffect(() => {
    setRead({ status: "loading" });
    void loadRead();
  }, [loadRead]);

  // The poll: only while the server says it is still working, and never
  // stacking — one timer, re-armed after each read that still says so.
  useEffect(() => {
    if (read.status !== "success") {
      return;
    }
    const status = read.read.notes_status;
    if (status !== "queued" && status !== "processing") {
      return;
    }
    const timer = setTimeout(() => {
      void loadRead();
    }, GENERATING_POLL_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [read, loadRead]);

  // The transcript is opened on demand and can be long, so it loads lazily
  // the first time its tab is chosen — the same posture the wire model states.
  useEffect(() => {
    if (tab !== "transcript" || transcript.status !== "idle") {
      return;
    }
    setTranscript({ status: "loading" });
    void (async () => {
      const result = await window.novaBridge.meetingTranscript(meetingId);
      if (!alive.current) {
        return;
      }
      setTranscript(
        result.ok
          ? { status: "success", turns: result.data.turns }
          : { status: "error", message: result.message },
      );
    })();
  }, [tab, transcript.status, meetingId]);

  const regenerate = useCallback(async () => {
    setRegenBusy(true);
    setRegenNote(null);
    const result = await window.novaBridge.regenerateNotes(meetingId);
    if (!alive.current) {
      return;
    }
    setRegenBusy(false);
    if (result.ok) {
      // Queued: flip the read into its generating state so the poll takes over.
      void loadRead();
    } else {
      setRegenNote(result.message);
    }
  }, [meetingId, loadRead]);

  const draftFollowUp = useCallback(async () => {
    setFollowBusy(true);
    setFollowNote(null);
    const result = await window.novaBridge.followUpDraft(meetingId, tone);
    if (!alive.current) {
      return;
    }
    setFollowBusy(false);
    if (result.ok) {
      setDraft(result.data);
    } else {
      setFollowNote(result.message);
    }
  }, [meetingId, tone]);

  const notes = read.status === "success" ? read.read.notes : null;
  const generating =
    read.status === "success" &&
    (read.read.notes_status === "queued" ||
      read.read.notes_status === "processing");
  const followUp =
    draft ?? (read.status === "success" ? read.read.follow_up : null);

  const copyFollowUp = useCallback(() => {
    if (followUp === null) {
      return;
    }
    void navigator.clipboard
      .writeText(`${followUp.subject}\n\n${followUp.body}`)
      .then(() => {
        if (alive.current) {
          setCopied(true);
          setTimeout(() => {
            if (alive.current) {
              setCopied(false);
            }
          }, 1600);
        }
      })
      .catch(() => {
        /* clipboard denied → the control simply doesn't confirm */
      });
  }, [followUp]);

  return (
    <div className="history">
      <div className="history__head">
        <button
          type="button"
          className="history__back nd"
          title="Back to sessions"
          onClick={onBack}
        >
          <BackIcon size={16} />
        </button>
        <span className="notesv__title">{notes?.title ?? title}</span>
      </div>

      <div className="notesv__tabs nd">
        {(["notes", "transcript", "follow-up"] as const).map((name) => (
          <button
            key={name}
            type="button"
            className={
              tab === name ? "notesv__tab notesv__tab--on" : "notesv__tab"
            }
            onClick={() => {
              setTab(name);
            }}
          >
            {name.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="notesv__body nd">
        {tab === "notes" && (
          <>
            {read.status === "loading" && (
              <span className="notesv__state">LOADING…</span>
            )}
            {read.status === "error" && (
              <>
                <p className="notesv__words">{read.message}</p>
                <button
                  type="button"
                  className="notesv__key"
                  onClick={() => {
                    setRead({ status: "loading" });
                    void loadRead();
                  }}
                >
                  Try again
                </button>
              </>
            )}
            {generating && (
              <span className="notesv__state">
                GENERATING
                <span className="nova-caret" aria-hidden="true" />
              </span>
            )}
            {read.status === "success" && !generating && notes === null && (
              <>
                <p className="notesv__words">
                  {read.read.notes_status === "failed"
                    ? "Notes generation failed for this call."
                    : "No notes for this call yet."}
                </p>
                <button
                  type="button"
                  className="notesv__key"
                  disabled={regenBusy}
                  onClick={() => {
                    void regenerate();
                  }}
                >
                  <RefreshIcon />
                  Generate notes
                </button>
                {regenNote !== null && (
                  <p className="notesv__words">{regenNote}</p>
                )}
              </>
            )}
            {notes !== null && !generating && (
              <>
                <p className="notesv__tldr">{notes.tldr}</p>
                <p className="notesv__words">{notes.overview}</p>
                {(
                  [
                    ["DECISIONS", notes.decisions],
                    ["ACTION ITEMS", notes.actionItems],
                    ["OPEN QUESTIONS", notes.openQuestions],
                    ["RISKS", notes.risks],
                  ] as const
                ).map(([label, items]) =>
                  items.length === 0 ? null : (
                    <section key={label} className="notesv__section">
                      <span className="notesv__label">{label}</span>
                      <ul className="notesv__list">
                        {items.map((item) => (
                          <li key={item.id} className="notesv__item">
                            {item.text}
                            {"quote" in item && item.quote !== null && (
                              <span className="notesv__quote">
                                “{item.quote}”
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ),
                )}
                <div className="notesv__foot-actions">
                  <button
                    type="button"
                    className="notesv__key"
                    disabled={regenBusy}
                    onClick={() => {
                      void regenerate();
                    }}
                  >
                    <RefreshIcon />
                    Regenerate
                  </button>
                  {regenNote !== null && (
                    <span className="notesv__words">{regenNote}</span>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {tab === "transcript" && (
          <>
            {(transcript.status === "loading" ||
              transcript.status === "idle") && (
              <span className="notesv__state">LOADING…</span>
            )}
            {transcript.status === "error" && (
              <p className="notesv__words">{transcript.message}</p>
            )}
            {transcript.status === "success" &&
              (transcript.turns.length === 0 ? (
                <p className="notesv__words">
                  This call left no transcript.
                </p>
              ) : (
                transcript.turns.map((turn, index) => (
                  <div
                    key={`${String(turn.ts_ms)}-${String(index)}`}
                    className="transcript__row"
                  >
                    <span className="transcript__ts">{turnStamp(turn)}</span>
                    <span className="transcript__turn">
                      <span className="transcript__who">
                        {(turn.speaker ?? "UNKNOWN").toUpperCase()}
                      </span>
                      <span className="transcript__text">{turn.content}</span>
                    </span>
                  </div>
                ))
              ))}
          </>
        )}

        {tab === "follow-up" && (
          <>
            <div className="notesv__tones">
              {TONES.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={
                    tone === name
                      ? "notesv__tab notesv__tab--on"
                      : "notesv__tab"
                  }
                  onClick={() => {
                    setTone(name);
                  }}
                >
                  {name.toUpperCase()}
                </button>
              ))}
              <button
                type="button"
                className="notesv__key"
                disabled={followBusy}
                onClick={() => {
                  void draftFollowUp();
                }}
              >
                {followBusy ? "Drafting…" : "Draft follow-up"}
              </button>
            </div>
            {followNote !== null && (
              <p className="notesv__words">{followNote}</p>
            )}
            {followUp !== null && (
              <div className="notesv__draft">
                <span className="notesv__label">
                  SUBJECT · {followUp.tone.toUpperCase()}
                </span>
                <p className="notesv__subject">{followUp.subject}</p>
                <p className="notesv__draft-body">{followUp.body}</p>
                <button
                  type="button"
                  className="notesv__key"
                  onClick={copyFollowUp}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            )}
            {followUp === null && followNote === null && !followBusy && (
              <p className="notesv__words">
                Pick a tone and draft a follow-up from this call's notes.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
