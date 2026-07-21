import { useEffect, useState, type FormEvent } from "react";

import { ApiError } from "../api/errors";
import type { AccountCreationResult, AuthService, AuthSession } from "../auth/auth-service";
import { LibraryPanel } from "./LibraryPanel";
import stingleLogo from "../assets/stingle-logo.png";

type AuthMode = "login" | "register";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

export function App({ auth }: { auth: AuthService }) {
  const [session, setSession] = useState<AuthSession | undefined>(auth.currentSession);
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [recoveryPhrase, setRecoveryPhrase] = useState<string>();

  useEffect(() => auth.subscribe(setSession), [auth]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(undefined);
    const cleanEmail = email.trim();
    if (mode === "register" && password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setPending(true);
    try {
      if (mode === "login") {
        await auth.login(cleanEmail, password);
      } else {
        const result: AccountCreationResult = await auth.createAccount(cleanEmail, password);
        setRecoveryPhrase(result.recoveryPhrase);
      }
      setPassword("");
      setConfirmation("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  if (session && recoveryPhrase) {
    return (
      <main className="shell recovery-shell">
        <section className="card recovery-card" aria-labelledby="recovery-title">
          <div className="auth-logo"><img src={stingleLogo} alt="" /><strong>Stingle Photos</strong></div>
          <p className="eyebrow">Account created</p>
          <h1 id="recovery-title">Save your recovery phrase</h1>
          <p>This is the only way to recover your photos if you forget your password.</p>
          <ol className="phrase" aria-label="Recovery phrase">
            {recoveryPhrase.split(" ").map((word, index) => (
              <li key={`${index}-${word}`}><span>{index + 1}</span>{word}</li>
            ))}
          </ol>
          <p className="warning">Keep it offline and private. Stingle cannot recover it for you.</p>
          <button className="primary" type="button" onClick={() => setRecoveryPhrase(undefined)}>
            I saved it securely
          </button>
        </section>
      </main>
    );
  }

  if (session) {
    return <LibraryPanel auth={auth} session={session} />;
  }

  return (
    <main className="shell auth-shell">
      <section className="card auth-card" aria-labelledby="auth-title">
        <div className="auth-logo"><img src={stingleLogo} alt="" /><strong>Stingle Photos</strong></div>
        <div className="tabs" role="tablist" aria-label="Account action">
          <button className={mode === "login" ? "active" : ""} type="button" role="tab" aria-selected={mode === "login"} onClick={() => { setMode("login"); setError(undefined); }}>
            Sign in
          </button>
          <button className={mode === "register" ? "active" : ""} type="button" role="tab" aria-selected={mode === "register"} onClick={() => { setMode("register"); setError(undefined); }}>
            Create account
          </button>
        </div>
        <h2 id="auth-title">{mode === "login" ? "Sign in" : "Create account"}</h2>
        <form onSubmit={(event) => void submit(event)}>
          <label>Email<input name="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Password<input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {mode === "register" ? (
            <label>Confirm password<input name="passwordConfirmation" type="password" autoComplete="new-password" minLength={8} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
          ) : null}
          {error ? <p className="error" role="alert">{error}</p> : null}
          <button className="primary" type="submit" disabled={pending}>
            {pending ? "Deriving secure keys…" : mode === "login" ? "Sign in" : "Create encrypted account"}
          </button>
        </form>
      </section>
    </main>
  );
}
