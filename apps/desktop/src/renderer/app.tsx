import type { JSX, ReactNode } from "react";

import { SignInForm } from "./components/sign-in-form";
import { useAuthState } from "./hooks/use-auth-state";

/**
 * The whole surface, and one `switch` over the auth union.
 *
 * The four branches are why the state is a union at all. `loading` and
 * `unavailable` both LOOK like signed-out and neither one should put a sign-in
 * form on screen: the first because we do not know yet, the second because this
 * build has no Supabase configured and no password would ever work. Collapsing
 * them is how a user ends up typing their password into a form that cannot
 * submit and being told their credentials are wrong.
 *
 * Everything below the bridge is a view: no token, no vendor SDK and no HTTP
 * lives in this process.
 */
export function App(): JSX.Element {
  const state = useAuthState();

  switch (state.status) {
    case "loading":
      return (
        <Screen>
          <span className="eyebrow">Nova</span>
          <p className="status-line">
            <span className="status-line__dot status-line__dot--hollow" />
            Checking for a saved session
          </p>
        </Screen>
      );

    case "unavailable":
      return (
        <Screen>
          <span className="eyebrow">Nova</span>
          <h1 className="wordmark">Not configured</h1>
          <p className="lede">
            This build has no Supabase project to sign in against, so there is
            nothing a password could unlock. Set the variables below in{" "}
            <code>apps/desktop/.env</code> and start the app again.
          </p>
          <div className="notice" role="alert">
            <span className="eyebrow">Why</span>
            <p className="notice__body">{state.message}</p>
          </div>
        </Screen>
      );

    case "signed-out":
      return (
        <Screen>
          <span className="eyebrow">Nova desktop</span>
          <h1 className="wordmark">Sign in</h1>
          <p className="lede">
            Your account is the same one the mobile app uses. Signing in here
            proves this desktop client can reach the Nova server.
          </p>
          <SignInForm
            signIn={window.novaBridge.signIn}
            signUp={window.novaBridge.signUp}
          />
        </Screen>
      );

    // Shown for the moment between the session landing and main swapping this
    // window for the pill — main owns that swap, this just says it is coming.
    case "signed-in":
      return (
        <Screen>
          <span className="eyebrow">Nova</span>
          <p className="status-line">
            <span className="status-line__dot" />
            Signed in{state.user.email !== undefined && ` as ${state.user.email}`}
            {" — opening Nova"}
          </p>
        </Screen>
      );
  }
}

function Screen({
  children,
  wide = false,
}: {
  readonly children: ReactNode;
  readonly wide?: boolean;
}): JSX.Element {
  return (
    <>
      <div className="login__titlebar">
        <span className="login__title">Nova</span>
      </div>
      <main className="screen">
        <div className={wide ? "card card--wide" : "card"}>{children}</div>
      </main>
    </>
  );
}
