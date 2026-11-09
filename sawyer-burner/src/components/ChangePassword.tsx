import { useState, type FormEvent } from "react";
import { PASSWORD_MIN } from "../../shared/rules";
import type { Me } from "../../shared/types";
import { api, errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useToast } from "./Toast";

/** Change-password form. `forced` = shown after an admin reset, before anything else. */
export function ChangePasswordForm({ forced = false, onDone }: { forced?: boolean; onDone?: () => void }) {
  const { setMe } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && confirm !== next;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (next !== confirm) return setError("New passwords don't match.");
    setBusy(true);
    try {
      const { user } = await api.post<{ user: Me }>("/api/auth/change-password", {
        currentPassword: current,
        newPassword: next,
        confirmPassword: confirm,
      });
      setMe(user);
      setCurrent("");
      setNext("");
      setConfirm("");
      toast("Password changed. Other devices were signed out.");
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <label className="field">
        <span className="field-label">{forced ? "Temporary password" : "Current password"}</span>
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
      </label>
      <label className="field">
        <span className="field-label">New password</span>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={PASSWORD_MIN} maxLength={128} required />
        <span className="field-hint">At least {PASSWORD_MIN} characters.</span>
      </label>
      <label className="field">
        <span className="field-label">Confirm new password</span>
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required aria-invalid={mismatch} />
        {mismatch && <span className="field-hint bad">Passwords don't match.</span>}
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="btn btn-primary btn-block pw-submit" disabled={busy || !current || !next || mismatch}>
        {busy ? "Saving…" : forced ? "Set new password" : "Change password"}
      </button>
    </form>
  );
}

/** Full-screen gate shown when an admin has reset this account's password. */
export function ForcedPasswordChange() {
  const { me, logout } = useAuth();
  return (
    <main className="auth">
      <div className="card auth-card">
        <h1 className="auth-title">New password</h1>
        <p className="muted small">
          An admin reset the password for <strong>@{me?.username}</strong>. Enter the temporary password you were given, then choose your own.
        </p>
        <ChangePasswordForm forced />
        <p className="auth-switch small">
          <button className="link-btn" onClick={() => logout()}>Log out</button>
        </p>
      </div>
    </main>
  );
}
