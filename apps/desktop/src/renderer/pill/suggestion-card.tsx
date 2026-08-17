import type { JSX } from "react";

import type { SuggestionView } from "./use-live-session";

/**
 * The focal suggestion pane — the conductor's voice made visible (chunk M1).
 * One card, ever: the server discards the old suggestion before starting a
 * new one, so this just renders whatever `use-live-session` holds as current.
 * Mount it with `key={suggestion.id}` so a superseding suggestion remounts
 * (and replays the entrance) instead of morphing mid-sentence.
 *
 *   floating — under the pill bar, on the bare desktop: full glass treatment.
 *   inset    — inside the transcript panel, which is already glass: subtle.
 */
export function SuggestionCard(props: {
  readonly suggestion: SuggestionView;
  readonly variant: "floating" | "inset";
}): JSX.Element {
  const { suggestion } = props;
  return (
    <div className={`suggestion suggestion--${props.variant}`}>
      {/* Announces the two state CHANGES (started, ready) to screen readers.
          The visible text below is deliberately NOT live — announcing every
          streamed delta would be noise, not access. */}
      <span className="visually-hidden" role="status">
        {suggestion.done ? "Nova suggestion ready" : "Nova is suggesting"}
      </span>
      <div className="suggestion__head">
        <span className="suggestion__who">NOVA</span>
        {!suggestion.done && <span className="suggestion__live-dot" />}
      </div>
      <div className="suggestion__body nd">
        <span
          className={
            suggestion.done
              ? "suggestion__text"
              : "suggestion__text suggestion__text--streaming"
          }
        >
          {suggestion.text === "" ? "…" : suggestion.text}
        </span>
      </div>
    </div>
  );
}
