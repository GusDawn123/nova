import { useEffect, useRef, useState, type JSX } from "react";

import { useScreenPrivacy } from "../hooks/use-screen-privacy";
import { AUDIO_OFF, type AudioSession } from "./audio-session";
import { HistoryPanel } from "./history-panel";
import { PillBar } from "./pill-bar";
import { TranscriptPanel } from "./transcript-panel";

type PillView = "pill" | "history" | "transcript";

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
  const [audio, setAudio] = useState<AudioSession>(AUDIO_OFF);
  const { enabled: undetectable, request } = useScreenPrivacy();
  const stageRef = useRef<HTMLDivElement>(null);

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

  const togglePause = (): void => {
    setAudio((current) => ({ ...current, paused: !current.paused }));
  };
  const stopAudio = (): void => {
    setAudio(AUDIO_OFF);
    setView("pill");
  };

  return (
    <div
      ref={stageRef}
      className={modeMenu ? "pill-stage pill-stage--menu-open" : "pill-stage"}
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
            }}
            activeMode={activeMode}
            onPickMode={(id) => {
              setActiveMode(id);
              setModeMenu(false);
            }}
            audio={audio}
            onStartAudio={() => {
              setAudio({ on: true, paused: false, seconds: 0 });
            }}
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
        {view === "history" && (
          <HistoryPanel
            onBack={() => {
              setView("pill");
            }}
          />
        )}
        {view === "transcript" && (
          <TranscriptPanel
            audio={audio}
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
