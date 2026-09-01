import { useMemo, useState, type JSX, type ReactNode } from "react";

import {
  settingsZoom,
  SETTINGS_CONTENT_DESIGN_HEIGHT,
  SETTINGS_DESIGN_WIDTH,
} from "../../main/windows/settings-layout";
import { CalendarIcon, DocIcon } from "../design/icons";
import {
  TabAboutIcon,
  TabBillingIcon,
  TabGeneralIcon,
  TabKeybindsIcon,
  TabModesIcon,
  TabNotificationsIcon,
  TabProfileIcon,
  TabSecurityIcon,
} from "./icons";
import { AboutTab } from "./tabs/about";
import { BillingTab } from "./tabs/billing";
import { CalendarTab } from "./tabs/calendar";
import { GeneralTab } from "./tabs/general";
import { KeybindsTab } from "./tabs/keybinds";
import { KnowledgeTab } from "./tabs/knowledge";
import { ModesTab } from "./tabs/modes";
import { NotificationsTab } from "./tabs/notifications";
import { ProfileTab } from "./tabs/profile";
import { SecurityTab } from "./tabs/security";

type TabId =
  | "general"
  | "calendar"
  | "notifications"
  | "modes"
  | "keybinds"
  | "knowledge"
  | "profile"
  | "security"
  | "billing"
  | "about";

const TABS: readonly { id: TabId; name: string; icon: ReactNode }[] = [
  { id: "general", name: "General", icon: <TabGeneralIcon /> },
  { id: "calendar", name: "Calendar", icon: <CalendarIcon size={20} /> },
  {
    id: "notifications",
    name: "Notifications",
    icon: <TabNotificationsIcon />,
  },
  { id: "modes", name: "Modes", icon: <TabModesIcon /> },
  { id: "keybinds", name: "Keybinds", icon: <TabKeybindsIcon /> },
  { id: "knowledge", name: "Knowledge", icon: <DocIcon size={20} /> },
  { id: "profile", name: "Profile", icon: <TabProfileIcon /> },
  { id: "security", name: "Security", icon: <TabSecurityIcon /> },
  { id: "billing", name: "Billing", icon: <TabBillingIcon /> },
  { id: "about", name: "About", icon: <TabAboutIcon /> },
];

const PANES: Record<TabId, () => JSX.Element> = {
  general: GeneralTab,
  calendar: CalendarTab,
  notifications: NotificationsTab,
  modes: ModesTab,
  keybinds: KeybindsTab,
  knowledge: KnowledgeTab,
  profile: ProfileTab,
  security: SecurityTab,
  billing: BillingTab,
  about: AboutTab,
};

/**
 * The settings window: a centered title strip (the native Windows controls
 * ride its right edge via titleBarOverlay), the nine-tab bar, and one pane.
 * The Modes pane owns its own columns, so it opts out of the scroll padding.
 *
 * Everything below the title strip is the mockup at its fixed design size,
 * zoomed as one block to fill the window main sized to the screen
 * (settings-layout.ts owns the law for both sides). Chromium's standardized
 * `zoom` scales layout too, so design pixels inside stay honest. The window
 * is not resizable, so the zoom is computed once.
 */
export function SettingsApp(): JSX.Element {
  const [tab, setTab] = useState<TabId>("general");
  const Pane = PANES[tab];
  const zoom = useMemo(() => settingsZoom(window.innerWidth), []);

  return (
    <>
      <div className="settings__titlebar">
        <span className="settings__title">Nova Settings</span>
      </div>
      <div
        className="settings__zoom"
        style={{
          zoom,
          width: SETTINGS_DESIGN_WIDTH,
          height: SETTINGS_CONTENT_DESIGN_HEIGHT,
        }}
      >
        <div className="settings__tabs">
          {TABS.map((entry) => (
            <button
              type="button"
              key={entry.id}
              className={
                entry.id === tab
                  ? "settings__tab settings__tab--active"
                  : "settings__tab"
              }
              onClick={() => {
                setTab(entry.id);
              }}
            >
              {entry.icon}
              <span>{entry.name}</span>
            </button>
          ))}
        </div>
        <div
          className={
            tab === "modes"
              ? "settings__pane settings__pane--modes"
              : "settings__pane"
          }
        >
          <Pane />
        </div>
      </div>
    </>
  );
}
