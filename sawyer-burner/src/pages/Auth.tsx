import { useState, type FormEvent } from "react";
import { PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN } from "../../shared/rules";
import type { Me } from "../../shared/types";
import { Wordmark } from "../components/Nav";
import { useToast } from "../components/Toast";
import { api, errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Link, navigate } from "../lib/router";

export function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const { setMe } = useAuth();
  const toast = useToast();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [agree, setAgree] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const signup = mode === "signup";

  const usernameHint =
    signup && username && !/^[a-zA-Z0-9_]*$/.test(username) ? "Letters, numbers and underscores only." : "";
  const mismatch = signup && confirm.length > 0 && confirm !== password;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (signup && password !== confirm) return setError("Passwords don't match.");
    setBusy(true);
    try {
      const { user } = signup
        ? await api.post<{ user: Me }>("/api/auth/signup", { username, password, confirmPassword: confirm, agree })
        : await api.post<{ user: Me }>("/api/auth/login", { username, password });
      setMe(user);
      toast(signup ? `Welcome to the pit, @${user.username}.` : `Back for more, @${user.username}.`);
      navigate("/", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <Link to="/" className="auth-brand" aria-label="Sawyer Burner home">
        <Wordmark />
      </Link>
      <form className="card auth-card" onSubmit={submit} noValidate>
        <h1 className="auth-title">{signup ? "Create account" : "Log in"}</h1>
        <p className="muted small">{signup ? "No email, no phone number. Just a name and a password." : "Welcome back. The burns missed you."}</p>

        <label className="field">
          <span className="field-label">Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            minLength={USERNAME_MIN}
            maxLength={USERNAME_MAX}
            required
            aria-invalid={!!usernameHint}
          />
          {signup && <span className={`field-hint${usernameHint ? " bad" : ""}`}>{usernameHint || `${USERNAME_MIN}–${USERNAME_MAX} characters: letters, numbers, underscores.`}</span>}
        </label>

        <label className="field">
          <span className="field-label">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={signup ? "new-password" : "current-password"}
            minLength={signup ? PASSWORD_MIN : undefined}
            maxLength={128}
            required
          />
          {signup && <span className="field-hint">At least {PASSWORD_MIN} characters.</span>}
        </label>

        {signup && (
          <>
            <label className="field">
              <span className="field-label">Confirm password</span>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required aria-invalid={mismatch} />
              {mismatch && <span className="field-hint bad">Passwords don't match.</span>}
            </label>
            <label className="check">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              <span>
                I agree to the <a href="/rules" target="_blank" rel="noopener">Community Rules</a>: roasts stay joking, no threats, no private info, no posting people without permission.
              </span>
            </label>
          </>
        )}

        {error && <p className="form-error" role="alert">{error}</p>}

        <button className="btn btn-primary btn-lg btn-block" disabled={busy || (signup && (!agree || mismatch))}>
          {busy ? "One sec…" : signup ? "Create account" : "Log in"}
        </button>

        <p className="auth-switch small">
          {signup ? (
            <>Already have an account? <Link to="/login">Log in</Link></>
          ) : (
            <>New here? <Link to="/signup">Create an account</Link></>
          )}
        </p>
      </form>
    </main>
  );
}
