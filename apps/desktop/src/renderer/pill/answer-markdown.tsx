import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type JSX,
} from "react";
import Markdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

import { CheckIcon, CopyIcon } from "../design/icons";

/**
 * The answer body, rendered as real markdown instead of raw `**` noise
 * (Gustavo, 2026-08-17): code fences become darker translucent blocks with
 * syntax coloring (rehype-highlight; palette in pill.css) and a copy control
 * on the WHOLE fence (never on inline chips), inline syntax becomes chips,
 * bold is bold, and `$...$` / `$$...$$` math renders as real KaTeX (both
 * authored brains demand LaTeX math). Styling lives in pill.css under `.md`;
 * KaTeX ships its own stylesheet + local fonts, bundled by Vite — no CDN.
 * react-markdown emits standard elements and never raw HTML from the model,
 * so there is no sanitization surface here.
 *
 * While streaming, the caret is a CSS `::after` on the last element (pill.css
 * `.md--streaming`), NOT a character appended to the markdown source — an
 * appended caret can land on a closing ``` line and un-close the fence,
 * flashing the tail of the answer as code mid-stream.
 */

/** How long the copy control shows its "copied" confirmation. */
const COPIED_FLASH_MS = 1600;

/**
 * A fenced block with its copy control. The button reads the FULL code text
 * off the DOM at click time (streaming may still be appending), so it always
 * copies exactly what the user sees.
 */
function CodeBlock(props: ComponentPropsWithoutRef<"pre">): JSX.Element {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  // The latest confirmation timer — a re-click clears it first, so a rapid
  // double-copy can't have the FIRST timer cut the second confirmation short.
  const flashTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  const copy = (): void => {
    const text = preRef.current?.textContent ?? "";
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (flashTimer.current !== null) {
          window.clearTimeout(flashTimer.current);
        }
        flashTimer.current = window.setTimeout(() => {
          setCopied(false);
          flashTimer.current = null;
        }, COPIED_FLASH_MS);
      })
      .catch(() => {
        /* clipboard denied → the control simply doesn't confirm */
      });
  };

  return (
    <div className="codebox">
      <pre ref={preRef} {...props} />
      <button
        type="button"
        className="codebox__copy nd"
        title={copied ? "Copied" : "Copy code"}
        onClick={copy}
      >
        {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      </button>
    </div>
  );
}

export function AnswerMarkdown(props: {
  readonly text: string;
  readonly streaming: boolean;
}): JSX.Element {
  return (
    <div className={props.streaming ? "md md--streaming" : "md"}>
      <Markdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        components={{ pre: CodeBlock }}
      >
        {props.text}
      </Markdown>
    </div>
  );
}
