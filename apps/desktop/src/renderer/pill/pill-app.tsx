import { useEffect, useRef, useState, type JSX } from "react";

import {
  isNovaModelId,
  MODEL_STORAGE_KEY,
  type NovaModelId,
} from "../design/models";
import { useScreenPrivacy } from "../hooks/use-screen-privacy";
import {
  AnsweringPanel,
  type AskContext,
  type ThreadTurn,
} from "./answering-panel";
import { AUDIO_OFF, type AudioSession } from "./audio-session";
import { HistoryPanel } from "./history-panel";
import { NotesView } from "./notes-view";
import { formatSeconds, PillBar } from "./pill-bar";
import { TranscriptPanel } from "./transcript-panel";
import { useLiveSession } from "./use-live-session";

type PillView = "pill" | "history" | "notes" | "transcript" | "answering";

/**
 * The pill window's whole surface and its local state machine, mirroring the
 * interactive mockup: one view enum, a Tab-focused ask field, a presentational
 * audio session, and the mode menu. The eye is the one control wired past this
 * window — it asks main to flip screen-capture exclusion and shows only what
 * main reports back.
 */
export function PillApp(): JSX.Element {
  const [view, setView] = useState<PillView>("pill");
  const [focusMode, setFocusMode] = useState(false);
  const [usesScreen, setUsesScreen] = useState(true);
  const [modeMenu, setModeMenu] = useState(false);
  const [activeMode, setActiveMode] = useState("general");
  const [modelMenu, setModelMenu] = useState(false);
  // The model pick survives restarts — it's a taste, not a session fact.
  const [activeModel, setActiveModel] = useState<NovaModelId>(() => {
    const saved = window.localStorage.getItem(MODEL_STORAGE_KEY);
    return isNovaModelId(saved) ? saved : "gpt";
  });
  const [audio, setAudio] = useState<AudioSession>(AUDIO_OFF);
  const [ask, setAsk] = useState<AskContext | null>(null);
  const [thread, setThread] = useState<readonly ThreadTurn[]>([]);
  // Which meeting the notes view is unfolded on; null whenever it is closed.
  const [openMeeting, setOpenMeeting] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const { enabled: undetectable, request } = useScreenPrivacy();
  const live = useLiveSession();
  const stageRef = useRef<HTMLDivElement>(null);
  // Latest-value refs so the archive read inside askNova stays fresh without
  // the Ctrl+Enter listener rebinding on every streamed token.
  const askRef = useRef<AskContext | null>(null);
  askRef.current = ask;
  const suggestionRef = useRef(live.suggestion);
  suggestionRef.current = live.suggestion;

  // Main owns the session; when it terminates out from under us — an error,
  // or a clean server-side end the user never clicked — the pill's controls
  // must fall back to "stopped" instead of ticking a clock over a dead call.
  useEffect(() => {
    if (live.state === "error" || live.state === "ended") {
      setAudio(AUDIO_OFF);
    }
    // A fresh call is a fresh chat: nothing from the previous call may leak
    // into it (Gustavo, 2026-08-17) — same boundary the transcript keeps.
    if (live.state === "connecting") {
      setThread([]);
      setAsk(null);
    }
  }, [live.state]);

  // Tab summons the ask field, exactly like the mockup — while this window has
  // OS focus. A global hotkey that works with the meeting app frontmost is
  // pivot chunk 5, not this pass.
  useEffect(() => {
    if (view !== "pill" || focusMode) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Tab") {
        event.preventDefault();
        setFocusMode(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [view, focusMode]);

  // The session clock, ticking only while a session runs unpaused.
  useEffect(() => {
    if (!audio.on || audio.paused) {
      return;
    }
    const timer = setInterval(() => {
      setAudio((current) => ({ ...current, seconds: current.seconds + 1 }));
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [audio.on, audio.paused]);

  // The frameless window hugs this element: every layout change (a panel
  // opening, the menu unfolding) reports its height and main resizes the
  // window to match, so the transparent dead zone around the pill stays small.
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) {
      return;
    }
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(stage.getBoundingClientRect().height);
      window.novaBridge.resizePill(Math.min(1200, Math.max(60, height)));
    });
    observer.observe(stage);
    return () => {
      observer.disconnect();
    };
  }, []);

  // The window is bigger than the pill (shadow/tooltip/menu gutters), and a
  // transparent window still eats every click inside its rectangle — so the
  // invisible border would block whatever sits under it. Pointer over bare
  // stage → let clicks fall through; pointer over real content → take them.
  // Main sets `forward: true` while ignoring, so mouse-move keeps arriving and
  // re-entry is seen. Drag regions swallow real moves, but by the time the
  // pointer is on one the last message was already "take clicks" — the gutter
  // (or a forwarded move over content) always fires first on the way in.
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) {
      return;
    }
    let clickThrough = false;
    // A reloaded renderer (HMR, dev full-reload) resets this variable while
    // main may still be ignoring clicks from before the reload. From that
    // mismatch the toggle below is unreachable — over content, `overContent`
    // never equals a stale `false` — and every click falls through the window
    // forever (live repro 2026-08-17). Re-asserting "take clicks" on mount
    // makes both sides start agreed on every load.
    window.novaBridge.setPillClickThrough(false);
    const onMouseMove = (event: MouseEvent): void => {
      const overContent =
        event.target instanceof Node &&
        event.target !== stage &&
        stage.contains(event.target);
      if (overContent === clickThrough) {
        clickThrough = !overContent;
        window.novaBridge.setPillClickThrough(clickThrough);
      }
    };
    window.addEventListener("mousemove", onMouseMove);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
    };
  }, []);

  // The ask (no-auto-response posture): the ONLY way a suggestion ever fires.
  // Clears the pane first so the panel never opens on a stale answer, captures
  // the "heard at" clock from the newest transcript line, and transforms the
  // pill into the answering panel while the stream arrives.
  const askNova = (text: string | null): void => {
    if (live.state !== "live") {
      return; // asks only mean something mid-call (pre-call asks are M5)
    }
    const lastTs = live.rows.at(-1)?.tsMs;
    // The finished Q/A joins the thread before the pane is cleared for the
    // new one; a half-streamed answer was superseded — not archived. Read
    // through the latest-refs: this closure may be the keydown listener's.
    const priorAsk = askRef.current;
    const priorAnswer = suggestionRef.current;
    if (priorAsk !== null && priorAnswer !== null && priorAnswer.done) {
      const finished: ThreadTurn = {
        question: priorAsk.question,
        heardLabel: priorAsk.heardLabel,
        answer: priorAnswer.text,
      };
      setThread((current) => [...current, finished]);
    }
    live.clearSuggestion();
    const context: AskContext = {
      question: text,
      heardLabel:
        lastTs !== undefined
          ? formatSeconds(Math.max(0, Math.floor(lastTs / 1000)))
          : null,
      error: null,
    };
    setAsk(context);
    setFocusMode(false);
    setModeMenu(false);
    setView("answering");
    // Identity-guarded either way: a newer ask owns the panel by now; a
    // stale failure must not stamp its message onto someone else's question.
    const failWith = (message: string): void => {
      setAsk((current) =>
        current === context ? { ...context, error: message } : current,
      );
    };
    void (async (): Promise<void> => {
      try {
        const result = await window.novaBridge.askLive(text);
        if (!result.ok) {
          failWith(result.message ?? "The ask could not be sent.");
        }
      } catch (error: unknown) {
        // The bridge is written to resolve typed, but the panel must not
        // think forever if that promise is ever broken.
        const reason = error instanceof Error ? error.message : String(error);
        failWith(`The ask could not be sent (${reason}).`);
      }
    })();
  };

  const newChat = (): void => {
    live.clearSuggestion();
    setThread([]);
    setAsk(null);
    setView("pill");
    setFocusMode(true);
  };

  // Ctrl+↵ = the Answer key ("Ask Nova about your screen or audio", Keybinds
  // tab) — anywhere in the pill window except inside the ask input, which owns
  // its own Enter handling. Ctrl+R = New Chat, from the answering panel.
  // (Main sets no application menu, so no `reload` accelerator shadows Ctrl+R.)
  // Deps are the state the handlers read — askNova/newChat close over it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement) {
        return;
      }
      if (event.ctrlKey && event.key === "Enter") {
        event.preventDefault();
        askNova(null);
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === "r") {
        if (view === "answering") {
          event.preventDefault();
          newChat();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [view, live.state, live.rows]);

  // Escape leaves the answering panel for the pill with the ask field open.
  // NOT Tab: the panel has focusable controls (Back, footer, New Chat), and
  // stealing Tab would make every one of them unreachable by keyboard.
  useEffect(() => {
    if (view !== "answering") {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setView("pill");
        setFocusMode(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [view]);

  const togglePause = (): void => {
    const paused = !audio.paused;
    window.novaBridge.setLiveSessionPaused(paused);
    setAudio((current) => ({ ...current, paused }));
  };
  const stopAudio = (): void => {
    void window.novaBridge.stopLiveSession();
    setAudio(AUDIO_OFF);
    setView("pill");
  };
  const startAudio = (): void => {
    setAudio({ on: true, paused: false, seconds: 0 });
    void (async (): Promise<void> => {
      try {
        const result = await window.novaBridge.startLiveSession(
          activeMode,
          activeModel,
        );
        if (!result.ok) {
          // The typed reason lands in the transcript panel via the status push;
          // here the controls just refuse to pretend a session is running.
          setAudio(AUDIO_OFF);
        }
      } catch (error: unknown) {
        // A rejected invoke pushes no status event, so nothing else would ever
        // clear the optimistic clock.
        console.error("[pill] live start failed:", error);
        setAudio(AUDIO_OFF);
      }
    })();
  };

  return (
    <div
      ref={stageRef}
      className={
        // ANY open dropdown needs the stage to grow — the window is sized to
        // this element, so a menu outside the min-height renders past the
        // window's bottom edge and gets cut (the 2026-08-20 model-menu bug).
        modeMenu || modelMenu
          ? "pill-stage pill-stage--menu-open"
          : "pill-stage"
      }
    >
      <div className="pill-shell">
        {view === "pill" && (
          <PillBar
            focusMode={focusMode}
            onFocusAsk={() => {
              setFocusMode(true);
            }}
            onBlurAsk={() => {
              setFocusMode(false);
            }}
            onAsk={askNova}
            canAsk={live.state === "live"}
            usesScreen={usesScreen}
            onToggleScreen={() => {
              setUsesScreen((current) => !current);
            }}
            undetectable={undetectable}
            onToggleUndetectable={() => {
              request(!undetectable);
            }}
            modeMenuOpen={modeMenu}
            onToggleModeMenu={() => {
              setModeMenu((current) => !current);
              setModelMenu(false);
            }}
            activeMode={activeMode}
            onPickMode={(id) => {
              setActiveMode(id);
              setModeMenu(false);
            }}
            modelMenuOpen={modelMenu}
            onToggleModelMenu={() => {
              setModelMenu((current) => !current);
              setModeMenu(false);
            }}
            activeModel={activeModel}
            onPickModel={(id) => {
              setActiveModel(id);
              window.localStorage.setItem(MODEL_STORAGE_KEY, id);
              setModelMenu(false);
            }}
            audio={audio}
            onStartAudio={startAudio}
            onTogglePause={togglePause}
            onStopAudio={stopAudio}
            onOpenHistory={() => {
              setView("history");
              setModeMenu(false);
            }}
            onOpenTranscript={() => {
              setView("transcript");
            }}
          />
        )}
        {view === "answering" && ask !== null && (
          <AnsweringPanel
            live={live}
            ask={ask}
            thread={thread}
            usesScreen={usesScreen}
            onToggleScreen={() => {
              setUsesScreen((current) => !current);
            }}
            undetectable={undetectable}
            onToggleUndetectable={() => {
              request(!undetectable);
            }}
            onOpenModes={() => {
              setView("pill");
              setModeMenu(true);
            }}
            onOpenTranscript={() => {
              setView("transcript");
            }}
            onNewChat={newChat}
            onBack={() => {
              setView("pill");
            }}
          />
        )}
        {view === "history" && (
          <HistoryPanel
            onBack={() => {
              setView("pill");
            }}
            onOpenMeeting={(meetingId, title) => {
              setOpenMeeting({ id: meetingId, title });
              setView("notes");
            }}
          />
        )}
        {view === "notes" && openMeeting !== null && (
          <NotesView
            meetingId={openMeeting.id}
            title={openMeeting.title}
            onBack={() => {
              setOpenMeeting(null);
              setView("history");
            }}
          />
        )}
        {view === "transcript" && (
          <TranscriptPanel
            audio={audio}
            live={live}
            onTogglePause={togglePause}
            onStopAudio={stopAudio}
            onBack={() => {
              setView("pill");
            }}
          />
        )}
      </div>
    </div>
  );
}
