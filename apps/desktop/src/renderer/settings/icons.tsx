import type { JSX } from "react";

import { Svg, type IconProps } from "../design/icons";

/**
 * Icons only the settings window uses, path data transcribed verbatim from
 * the ratified mockups ("Nova Settings.dc.html" + "NovaSettingsTabs.dc.html").
 */

/* ---- the nine tab glyphs ---- */

export function TabGeneralIcon({ size = 20 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.5v2.3M10 15.2v2.3M2.5 10h2.3M15.2 10h2.3M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M15.3 4.7l-1.6 1.6M6.3 13.7l-1.6 1.6" />
    </Svg>
  );
}

export function TabNotificationsIcon({ size = 20 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M6 8.2a4 4 0 0 1 8 0c0 3 1.1 3.9 1.6 4.5H4.4C4.9 12.1 6 11.2 6 8.2Z" />
      <path d="M8.5 15.2a1.6 1.6 0 0 0 3 0" />
    </Svg>
  );
}

export function TabModesIcon({ size = 20 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M3 6.3h5.4M12.6 6.3H17M3 13.7h3.4M10.6 13.7H17" />
      <circle cx="10.5" cy="6.3" r="1.9" />
      <circle cx="8.5" cy="13.7" r="1.9" />
    </Svg>
  );
}

export function TabKeybindsIcon({ size = 20 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <rect x="2.5" y="5" width="15" height="10.4" rx="2" />
      <path d="M5.3 8.2h1M9.5 8.2h1M13.7 8.2h1M6.5 12.2h7" />
    </Svg>
  );
}

export function TabProfileIcon({ size = 20 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <circle cx="10" cy="7" r="3" />
      <path d="M4.6 16.6a5.6 5.6 0 0 1 10.8 0" />
    </Svg>
  );
}

export function TabSecurityIcon({ size = 20 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <circle cx="6.8" cy="13.2" r="3" />
      <path d="M9 11l7-7M13.4 6.6l2 2" />
    </Svg>
  );
}

export function TabBillingIcon({ size = 20 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <rect x="2.5" y="4.8" width="15" height="10.6" rx="2" />
      <path d="M2.5 8.4h15M5.4 12.4h3.4" />
    </Svg>
  );
}

export function TabAboutIcon({ size = 20 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <circle cx="10" cy="10" r="7.4" />
      <path d="M10 9.2v4.4M10 6.2v.2" />
    </Svg>
  );
}

/* ---- row icons ---- */

export function DownloadIcon({ size = 22 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M10 3v8.5M6.2 8.3 10 12.1l3.8-3.8M4 16.5h12" />
    </Svg>
  );
}

export function PowerIcon({ size = 22 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M6.2 5.6a6.4 6.4 0 1 0 7.6 0M10 2.6v6.2" />
    </Svg>
  );
}

export function WavesIcon({ size = 22 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M3 10c1.2-4.5 2.3-4.5 3.5 0s2.3 4.5 3.5 0 2.3-4.5 3.5 0 2.3 4.5 3.5 0" />
    </Svg>
  );
}

export function TranslateIcon({ size = 22 }: IconProps): JSX.Element {
  return (
    <Svg size={size} strokeWidth={1.4}>
      <path d="M3.5 5h8M7.5 3v2M9.8 5c-.8 3-3.2 5.8-6.3 7.2M5.5 8.5c1.2 2 3.1 3.6 4.9 4.3M11 16.5l3.2-8 3.2 8M12.2 13.8h4" />
    </Svg>
  );
}

export function MicIcon({ size = 22 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <rect x="7.8" y="2.8" width="4.4" height="8" rx="2.2" />
      <path d="M5.4 9.4a4.6 4.6 0 0 0 9.2 0M10 14.6V17" />
    </Svg>
  );
}

export function LogoutIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M8 3H4.5v14H8M13 6.5 16.5 10 13 13.5M16.5 10h-9" />
    </Svg>
  );
}

export function QuitIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M6.2 5.6a6.4 6.4 0 1 0 7.6 0M10 2.6v6.2M3 17l1.5-1.5" />
    </Svg>
  );
}

/** The bell-on-calendar glyph from the notifications row. */
export function MeetingAlertIcon({ size = 22 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <rect x="2.6" y="4.2" width="12" height="12.8" rx="2" />
      <path d="M2.6 8.4h12M6.2 2.4v3M11 2.4v3" />
      <circle cx="14.6" cy="13.4" r="3.4" fill="#1b1b1f" />
      <path d="M14.6 11.9v1.5l1.1.9" />
    </Svg>
  );
}

export function HelpTargetIcon({ size = 22 }: IconProps): JSX.Element {
  return (
    <Svg size={size} strokeWidth={1.4}>
      <circle cx="10" cy="10" r="7.2" />
      <circle cx="10" cy="10" r="3" />
      <path d="M5 5l2.9 2.9M12.1 12.1 15 15M15 5l-2.9 2.9M7.9 12.1 5 15" />
    </Svg>
  );
}

export function MailIcon({ size = 22 }: IconProps): JSX.Element {
  return (
    <Svg size={size} strokeWidth={1.4}>
      <rect x="2.8" y="4.8" width="14.4" height="10.6" rx="2" />
      <path d="M3.4 6.4 10 11l6.6-4.6" />
    </Svg>
  );
}

export function QuestionIcon({ size = 22 }: IconProps): JSX.Element {
  return (
    <Svg size={size} strokeWidth={1.4}>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M8 8.1a2 2 0 1 1 2.9 1.8c-.6.3-.9.8-.9 1.5M10 14.2v.2" />
    </Svg>
  );
}

/** The release-notes document with text lines. */
export function ReleaseDocIcon({ size = 22 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M6 2.8h5.5L15 6v11.2H6Z" />
      <path d="M11.5 2.8V6H15M8.4 9.5h3.8M8.4 12.2h3.8" />
    </Svg>
  );
}

/* ---- modes sidebar ---- */

export function PlusIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <Svg size={size} strokeWidth={1.8}>
      <path d="M10 4v12M4 10h12" />
    </Svg>
  );
}

export function CompassIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M10 2.8a7.2 7.2 0 1 0 0 14.4 7.2 7.2 0 0 0 0-14.4Z" />
      <path d="M12.8 7.2 11 11l-3.8 1.8L9 9Z" />
    </Svg>
  );
}

export function DemoIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M3 4.5h14v9H3Z" />
      <path d="M8 17h4M10 13.5V17" />
      <path d="M8.4 7.2 12 9l-3.6 1.8Z" />
    </Svg>
  );
}

export function ScalesIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M10 3v14" />
      <path d="M4 6.5h12" />
      <path d="M4 6.5 2.2 11a2.6 2.6 0 0 0 3.6 0L4 6.5ZM16 6.5 14.2 11a2.6 2.6 0 0 0 3.6 0L16 6.5Z" />
    </Svg>
  );
}

/* ---- keybind rows ---- */

export function KeyVisibilityIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M3 5.5h14v9H3Z" />
    </Svg>
  );
}

export function KeyNewChatIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M3.5 4.5h13v9h-13Z" />
      <path d="M10 6.8v4.4M7.8 9h4.4" />
    </Svg>
  );
}

export function KeyGearIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M10 2.5v2.3M10 15.2v2.3M2.5 10h2.3M15.2 10h2.3M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M15.3 4.7l-1.6 1.6M6.3 13.7l-1.6 1.6" />
      <path d="M10 7.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2Z" />
    </Svg>
  );
}

export function KeyMicIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M7.8 2.8h4.4v8a2.2 2.2 0 1 1-4.4 0Z" />
      <path d="M5.4 9.4a4.6 4.6 0 0 0 9.2 0M10 14.6V17" />
    </Svg>
  );
}

const WINDOW_CHEVRONS = {
  up: "M7 11l3-3 3 3",
  down: "M7 9l3 3 3-3",
  left: "M11 7l-3 3 3 3",
  right: "M9 7l3 3-3 3",
} as const;

export function KeyWindowIcon({
  size = 18,
  direction,
}: IconProps & {
  readonly direction: keyof typeof WINDOW_CHEVRONS;
}): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M3.5 3.5h13v13h-13Z" />
      <path d={WINDOW_CHEVRONS[direction]} />
    </Svg>
  );
}

export function KeyScrollIcon({
  size = 18,
  direction,
}: IconProps & { readonly direction: "up" | "down" }): JSX.Element {
  return (
    <Svg size={size}>
      {direction === "up" ? (
        <>
          <path d="M10 16V5.5M6.5 9 10 5.5 13.5 9" />
          <path d="M5 3h10" />
        </>
      ) : (
        <>
          <path d="M10 4v10.5M6.5 11 10 14.5 13.5 11" />
          <path d="M5 17h10" />
        </>
      )}
    </Svg>
  );
}
