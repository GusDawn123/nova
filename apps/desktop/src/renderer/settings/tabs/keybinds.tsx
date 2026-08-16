import type { JSX, ReactNode } from "react";

import { ChatIcon } from "../../design/icons";
import {
  KeyGearIcon,
  KeyMicIcon,
  KeyNewChatIcon,
  KeyScrollIcon,
  KeyVisibilityIcon,
  KeyWindowIcon,
} from "../icons";

interface Bind {
  readonly icon: ReactNode;
  readonly label: string;
  readonly keys: readonly string[];
}

/**
 * Windows keys per WINDOWS-VARIANT.md: everywhere the macOS design says Cmd,
 * this build says Ctrl (and Shift for ⇧). Arrows and ↵ stay glyphs.
 */
const GENERAL_BINDS: readonly Bind[] = [
  {
    icon: <KeyVisibilityIcon />,
    label: "Toggle visibility of Nova",
    keys: ["Ctrl", "\\"],
  },
  {
    icon: <ChatIcon size={18} />,
    label: "Ask Nova about your screen or audio",
    keys: ["Ctrl", "↵"],
  },
  { icon: <KeyNewChatIcon />, label: "Start a new chat", keys: ["Ctrl", "R"] },
  { icon: <KeyGearIcon />, label: "Open Nova settings", keys: ["Ctrl", ","] },
  {
    icon: <KeyMicIcon />,
    label: "Start or stop a Nova session",
    keys: ["Shift", "Ctrl", "\\"],
  },
];

const WINDOW_BINDS: readonly Bind[] = [
  {
    icon: <KeyWindowIcon direction="up" />,
    label: "Move the window position up",
    keys: ["Ctrl", "↑"],
  },
  {
    icon: <KeyWindowIcon direction="down" />,
    label: "Move the window position down",
    keys: ["Ctrl", "↓"],
  },
  {
    icon: <KeyWindowIcon direction="left" />,
    label: "Move the window position left",
    keys: ["Ctrl", "←"],
  },
  {
    icon: <KeyWindowIcon direction="right" />,
    label: "Move the window position right",
    keys: ["Ctrl", "→"],
  },
];

const SCROLL_BINDS: readonly Bind[] = [
  {
    icon: <KeyScrollIcon direction="up" />,
    label: "Scroll the response window up",
    keys: ["Shift", "Ctrl", "↑"],
  },
  {
    icon: <KeyScrollIcon direction="down" />,
    label: "Scroll the response window down",
    keys: ["Shift", "Ctrl", "↓"],
  },
];

/** The Keybinds tab. Display-only — real global hotkeys are pivot chunk 5. */
export function KeybindsTab(): JSX.Element {
  return (
    <>
      <div className="section-head" style={{ marginBottom: 14 }}>
        <span className="section-title">Keyboard shortcuts</span>
        <span className="section-sub">
          Nova works with these easy to remember commands. Click any of the
          keybinds to edit.
        </span>
      </div>
      <BindGroup title="General" binds={GENERAL_BINDS} first />
      <BindGroup title="Window" binds={WINDOW_BINDS} />
      <BindGroup title="Scroll" binds={SCROLL_BINDS} />
    </>
  );
}

function BindGroup({
  title,
  binds,
  first = false,
}: {
  readonly title: string;
  readonly binds: readonly Bind[];
  readonly first?: boolean;
}): JSX.Element {
  return (
    <>
      <div className={first ? "keys__group keys__group--first" : "keys__group"}>
        {title}
      </div>
      {binds.map((bind) => (
        <div key={bind.label} className="keys__row">
          <span className="keys__row-icon">{bind.icon}</span>
          <span className="keys__row-label">{bind.label}</span>
          <span className="keys__chips">
            {bind.keys.map((key) => (
              <span key={key} className="keys__chip">
                {key}
              </span>
            ))}
          </span>
        </div>
      ))}
    </>
  );
}
