import type { JSX, ReactNode } from "react";

/**
 * The pill's icon set plus everything both windows share, path data transcribed
 * verbatim from the ratified mockups
 * (docs/superpowers/mockups/2026-08-14-app-design/). Stroke icons inherit
 * `currentColor`, so state (active / muted) is the parent's colour decision.
 */

export interface IconProps {
  readonly size?: number;
}

interface SvgProps {
  readonly size: number;
  readonly viewBox?: number;
  readonly strokeWidth?: number;
  readonly fill?: string;
  readonly children: ReactNode;
}

/** One wrapper so every icon carries the mockups' shared SVG attributes. */
export function Svg({
  size,
  viewBox = 20,
  strokeWidth = 1.5,
  fill = "none",
  children,
}: SvgProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${String(viewBox)} ${String(viewBox)}`}
      fill={fill}
      stroke={fill === "none" ? "currentColor" : "none"}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** Two stacked rounded squares — copy to clipboard. */
export function CopyIcon({ size = 14 }: IconProps): JSX.Element {
  return (
    <Svg size={size} strokeWidth={1.5}>
      <rect x="7" y="7" width="9.5" height="9.5" rx="2" />
      <path d="M13 3.5H5.5A2 2 0 0 0 3.5 5.5V13" />
    </Svg>
  );
}

/** The screen/camera glyph — "Uses Screen". */
export function ScreenIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <Svg size={size} strokeWidth={1.4}>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
      <circle cx="7.5" cy="8" r="1.4" />
      <path d="M3 14l4.2-4 3.3 3.1 2.6-2.4L17 14" />
    </Svg>
  );
}

/** The eye — the undetectability toggle's face. */
export function EyeIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <Svg size={size} strokeWidth={1.4}>
      <path d="M1.8 10S4.7 4.8 10 4.8 18.2 10 18.2 10 15.3 15.2 10 15.2 1.8 10 1.8 10Z" />
      <circle cx="10" cy="10" r="2.4" />
    </Svg>
  );
}

/**
 * Hat and glasses — the undetectability toggle's face while Nova is HIDDEN
 * from screen capture (the eye shows while detectable). Drawn in-house in the
 * mockups' stroke style; not from the bundle, which predates this state swap.
 */
export function IncognitoIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <Svg size={size} strokeWidth={1.4}>
      <path d="M2.8 9.4h14.4" />
      <path d="M5.4 9.4 6.6 5a1.7 1.7 0 0 1 2.2-1.1l.6.22a1.7 1.7 0 0 0 1.2 0l.6-.22A1.7 1.7 0 0 1 13.4 5l1.2 4.4" />
      <circle cx="6.6" cy="14.2" r="2.2" />
      <circle cx="13.4" cy="14.2" r="2.2" />
      <path d="M8.8 13.8c.8-.5 1.6-.5 2.4 0" />
    </Svg>
  );
}

/** The 2×2 squares — the mode picker. Filled while a mode is engaged. */
export function SquaresIcon({
  size = 18,
  filled = false,
}: IconProps & { readonly filled?: boolean }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinejoin="round"
    >
      <rect x="2.6" y="2.6" width="6" height="6" rx="1.4" />
      <rect x="11.4" y="2.6" width="6" height="6" rx="1.4" />
      <rect x="2.6" y="11.4" width="6" height="6" rx="1.4" />
      <rect x="11.4" y="11.4" width="6" height="6" rx="1.4" />
    </svg>
  );
}

/** Five vertical bars — the audio session. */
export function AudioBarsIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M4 8v4M7 5.5v9M10 7v6M13 4.5v11M16 8.5v3" />
    </Svg>
  );
}

/** The return/enter arrow in its corner box. */
export function ReturnIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <Svg size={size} viewBox={16} strokeWidth={1.4}>
      <path d="M13 3v4.5a2 2 0 0 1-2 2H3.5" />
      <path d="M6 7 3.2 9.6 6 12.2" />
    </Svg>
  );
}

export function BackIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <Svg size={size} viewBox={16}>
      <path d="M12.5 8h-9M7 3.5 2.5 8 7 12.5" />
    </Svg>
  );
}

export function DownArrowIcon({ size = 13 }: IconProps): JSX.Element {
  return (
    <Svg size={size} viewBox={16}>
      <path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" />
    </Svg>
  );
}

/** The transcript file. */
export function FileIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <Svg size={size} strokeWidth={1.4}>
      <path d="M5 2.5h7L15.5 6v11.5h-10.5Z" />
      <path d="M12 2.5V6h3.5" />
    </Svg>
  );
}

/** The plain document used by history rows and the modes sidebar. */
export function DocIcon({ size = 17 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M6 2.8h5.5L15 6v11.2H6Z" />
      <path d="M11.5 2.8V6H15" />
    </Svg>
  );
}

export function ChatIcon({ size = 17 }: IconProps): JSX.Element {
  return (
    <Svg size={size} strokeWidth={1.4}>
      <path d="M17 9.5a7 6.5 0 0 1-7 6.5c-1 0-2-.2-2.8-.55L3 17l1.3-3.4A6.3 6.3 0 0 1 3 9.5 7 6.5 0 0 1 10 3a7 6.5 0 0 1 7 6.5Z" />
    </Svg>
  );
}

export function SearchIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <circle cx="9" cy="9" r="5.5" />
      <path d="M13.2 13.2 17 17" />
    </Svg>
  );
}

export function RefreshIcon({ size = 13 }: IconProps): JSX.Element {
  return (
    <Svg size={size} strokeWidth={1.6}>
      <path d="M4.5 8a6 6 0 1 1-.6 4M4.5 8V4.5M4.5 8H8" />
    </Svg>
  );
}

export function CalendarIcon({ size = 17 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <rect x="3" y="4.2" width="14" height="12.8" rx="2" />
      <path d="M3 8.4h14M7 2.4v3M13 2.4v3" />
    </Svg>
  );
}

export function CheckIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <Svg size={size} strokeWidth={2}>
      <path d="M4 10.5 8.2 14.5 16 5.5" />
    </Svg>
  );
}

/** The new-chat box with a plus. */
export function NewChatIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <rect x="3.5" y="4.5" width="13" height="11" rx="2" />
      <path d="M10 7.2v4.6M7.7 9.5h4.6" />
    </Svg>
  );
}

export function PauseGlyph({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="rgba(255,255,255,.9)"
    >
      <rect x="3.4" y="2.5" width="3" height="11" rx="1" />
      <rect x="9.6" y="2.5" width="3" height="11" rx="1" />
    </svg>
  );
}

export function PlayGlyph({ size = 14 }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="rgba(255,255,255,.9)"
    >
      <path d="M4 2.8v10.4L13 8Z" />
    </svg>
  );
}

/** Google's multicolour G, from the mockup's connect buttons. */
export function GoogleIcon({ size = 17 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48">
      <path
        fill="#EA4335"
        d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.5 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.7 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.9 7.2l7.6 5.9c4.4-4.1 7.1-10.1 7.1-17.6z"
      />
      <path
        fill="#FBBC05"
        d="M10.4 28.7a14.5 14.5 0 0 1 0-9.4l-7.8-6.1a24 24 0 0 0 0 21.6l7.8-6.1z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.2 0 11.4-2 15.4-5.9l-7.6-5.9c-2.1 1.4-4.8 2.3-7.8 2.3-6.3 0-11.7-3.7-13.6-9.8l-7.8 6.1C6.5 42.6 14.6 48 24 48z"
      />
    </svg>
  );
}

/** The outward arrow on upgrade/open-external rows. */
export function ExternalIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <Svg size={size} strokeWidth={1.6}>
      <path d="M6 14 14 6M8 6h6v6" />
    </Svg>
  );
}
