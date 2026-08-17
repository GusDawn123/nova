import type { JSX } from "react";
import Markdown from "react-markdown";

/**
 * The answer body, rendered as real markdown instead of raw `**` noise
 * (Gustavo, 2026-08-17): code fences become darker translucent blocks, inline
 * syntax becomes chips, bold is bold. Styling lives entirely in pill.css under
 * `.md` — react-markdown emits standard elements and never raw HTML from the
 * model, so there is no sanitization surface here.
 *
 * While streaming, a caret character rides the end of the TEXT (not a sibling
 * element) so it flows inline with the last word — the classic chat-UI trick.
 */
export function AnswerMarkdown(props: {
  readonly text: string;
  readonly streaming: boolean;
}): JSX.Element {
  return (
    <div className={props.streaming ? "md md--streaming" : "md"}>
      <Markdown>{props.streaming ? `${props.text} ▍` : props.text}</Markdown>
    </div>
  );
}
