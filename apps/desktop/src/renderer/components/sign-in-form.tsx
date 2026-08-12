import { useState, type JSX } from "react";

import type { AuthActionResult } from "../../main/auth/errors";

/**
 * Email + password, and the two things you can do with them. Dumb by design
 * (RULES §10): it holds the two fields and the in-flight flag, and every
 * decision about what a failure MEANS was already made in the main process —
 * this only renders the sentence that came back.
 */

/** Which button was pressed. A union rather than two booleans. */
type Submission = "sign-in" | "sign-up";

export interface SignInFormProps {
  readonly signIn: (
    email: string,
    password: string,
  ) => Promise<AuthActionResult>;
  readonly signUp: (
    email: string,
    password: string,
  ) => Promise<AuthActionResult>;
}

export function SignInForm({ signIn, signUp }: SignInFormProps): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  /** `null` when idle; the action in flight otherwise. */
  const [pending, setPending] = useState<Submission | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(intent: Submission): Promise<void> {
    setPending(intent);
    setFailure(null);
    setNotice(null);
    const run = intent === "sign-in" ? signIn : signUp;
    const result = await run(email, password);
    setPending(null);
    if (!result.ok) {
      setFailure(result.message);
      return;
    }
    if (intent === "sign-up") {
      // A successful sign-up does NOT always sign you in: Supabase holds the
      // session back until the address is confirmed when confirmations are on.
      // Saying so beats a form that appears to do nothing.
      setNotice(
        "Account created. If this project requires email confirmation, confirm it and then sign in.",
      );
    }
  }

  const busy = pending !== null;

  return (
    // The handler is inline so React infers the event type from the prop:
    // `@types/react` 19 deprecates the `FormEvent` alias outright, and inferring
    // it beats picking whichever of its four suggested replacements is current.
    <form
      onSubmit={(event) => {
        // A form's own submit is the Enter key, which here means "sign in".
        event.preventDefault();
        void submit("sign-in");
      }}
      noValidate
    >
      <label className="field">
        <span className="field__label">Email</span>
        <input
          className="field__input"
          type="email"
          autoComplete="username"
          autoFocus
          value={email}
          disabled={busy}
          placeholder="you@example.com"
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
      </label>

      <label className="field">
        <span className="field__label">Password</span>
        <input
          className="field__input"
          type="password"
          autoComplete="current-password"
          value={password}
          disabled={busy}
          placeholder="••••••••"
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
      </label>

      <div className="actions">
        <button className="key" type="submit" disabled={busy}>
          {pending === "sign-in" ? "Signing in…" : "Sign in"}
        </button>
        <button
          className="key key--quiet"
          type="button"
          disabled={busy}
          onClick={() => {
            void submit("sign-up");
          }}
        >
          {pending === "sign-up" ? "Creating…" : "Create account"}
        </button>
      </div>

      {failure !== null && (
        <div className="notice" role="alert">
          <span className="eyebrow">Could not sign in</span>
          <p className="notice__body">{failure}</p>
        </div>
      )}

      {notice !== null && (
        <div className="notice" role="status">
          <span className="eyebrow">Account created</span>
          <p className="notice__body">{notice}</p>
        </div>
      )}
    </form>
  );
}
