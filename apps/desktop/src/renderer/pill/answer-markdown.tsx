import type { JSX } from "react";
import Markdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

/**
 * The answer body, rendered as real markdown instead of raw `**` noise
 * (Gustavo, 2026-08-17): code fences become darker translucent blocks, inline
 * syntax becomes chips, bold is bold, and `$...$` / `$$...$$` math renders as
 * real KaTeX (both authored brains demand LaTeX math — M2). Styling lives in
 * pill.css under `.md`; KaTeX ships its own stylesheet + local fonts, bundled
 * by Vite — no CDN. react-markdown emits standard elements and never raw HTML
 * from the model, so there is no sanitization surface here.
 *
 * While streaming, the caret is a CSS `::after` on the last element (pill.css
 * `.md--streaming`), NOT a character appended to the markdown source — an
 * appended caret can land on a closing ``` line and un-close the fence,
 * flashing the tail of the answer as code mid-stream.
 */
export function AnswerMarkdown(props: {
  readonly text: string;
  readonly streaming: boolean;
}): JSX.Element {
  return (
    <div className={props.streaming ? "md md--streaming" : "md"}>
      <Markdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
        {props.text}
      </Markdown>
    </div>
  );
}
