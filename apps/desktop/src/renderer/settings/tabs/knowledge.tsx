import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
} from "react";
import { CONTEXT_DOC_MAX_CHARS, type ContextDocItem } from "@nova/shared";

import { SectionHead } from "../rows";

/**
 * The Knowledge tab — the user's reference documents, uploaded so RAG memory
 * can ground answers in their material. Plain text in (`.txt`/`.md` picked or
 * pasted); every row shows whether it is actually searchable, because a doc
 * that saved but never indexed must not read as one that did.
 */

type DocsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; docs: readonly ContextDocItem[] };

/** `12.4k chars` — enough to tell a note from a manual at a glance. */
function charsLabel(chars: number): string {
  return chars >= 1000
    ? `${(chars / 1000).toFixed(1)}k chars`
    : `${String(chars)} chars`;
}

export function KnowledgeTab(): JSX.Element {
  const [state, setState] = useState<DocsState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const result = await window.novaBridge.listContextDocs();
    setState(
      result.ok
        ? { status: "success", docs: result.data.docs }
        : { status: "error", message: result.message },
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = useCallback(async () => {
    if (title.trim() === "" || content.trim() === "") {
      setNote("A document needs both a title and some text.");
      return;
    }
    setBusy(true);
    setNote(null);
    const result = await window.novaBridge.createContextDoc(
      title.trim(),
      content,
    );
    setBusy(false);
    if (result.ok) {
      setTitle("");
      setContent("");
      setNote(result.data.note);
      void load();
    } else {
      setNote(result.message);
    }
  }, [title, content, load]);

  const remove = useCallback(
    async (docId: string) => {
      const result = await window.novaBridge.deleteContextDoc(docId);
      if (result.ok) {
        void load();
      } else {
        setNote(result.message);
      }
    },
    [load],
  );

  const pickFile = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset so choosing the same file twice still fires a change event.
    event.target.value = "";
    if (file === undefined) {
      return;
    }
    if (file.size > CONTEXT_DOC_MAX_CHARS) {
      setNote(
        `That file is too large — the knowledge base takes up to ${String(
          CONTEXT_DOC_MAX_CHARS / 1000,
        )}k characters per document.`,
      );
      return;
    }
    void file.text().then((text) => {
      setContent(text);
      setTitle((current) =>
        current.trim() === "" ? file.name.replace(/\.(txt|md)$/i, "") : current,
      );
    });
  }, []);

  return (
    <>
      <SectionHead
        title="Knowledge"
        sub="Documents Nova can draw on when answering — yours only, searchable in your calls"
      />

      <div className="kb__composer">
        <input
          className="kb__title"
          value={title}
          placeholder="Document title"
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
        <textarea
          className="kb__content"
          value={content}
          placeholder="Paste text here, or pick a .txt / .md file below"
          onChange={(event) => {
            setContent(event.target.value);
          }}
        />
        <div className="kb__composer-row">
          <input
            ref={fileInput}
            type="file"
            accept=".txt,.md,text/plain,text/markdown"
            className="visually-hidden-input"
            onChange={pickFile}
          />
          <button
            type="button"
            className="btn-outline"
            onClick={() => {
              fileInput.current?.click();
            }}
          >
            Pick a file
          </button>
          <button
            type="button"
            className="kb__upload"
            disabled={busy}
            onClick={() => {
              void upload();
            }}
          >
            {busy ? "Uploading…" : "Add to knowledge base"}
          </button>
        </div>
        {note !== null && <p className="kb__note">{note}</p>}
      </div>

      <SectionHead title="Your documents" spaced />
      {state.status === "loading" && <p className="kb__note">LOADING…</p>}
      {state.status === "error" && (
        <>
          <p className="kb__note">{state.message}</p>
          <button
            type="button"
            className="btn-outline"
            onClick={() => {
              setState({ status: "loading" });
              void load();
            }}
          >
            Try again
          </button>
        </>
      )}
      {state.status === "success" && state.docs.length === 0 && (
        <p className="kb__note">
          Nothing here yet — the first document you add becomes part of Nova's
          memory of you.
        </p>
      )}
      {state.status === "success" &&
        state.docs.map((doc) => (
          <div key={doc.id} className="kb__row">
            <div className="kb__row-text">
              <span className="kb__row-title">{doc.title}</span>
              <span className="kb__row-meta">
                {charsLabel(doc.chars)} ·{" "}
                {doc.indexed ? "SEARCHABLE" : "NOT INDEXED YET"}
              </span>
            </div>
            <button
              type="button"
              className="kb__delete"
              onClick={() => {
                void remove(doc.id);
              }}
            >
              Delete
            </button>
          </div>
        ))}
    </>
  );
}
