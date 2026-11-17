"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SOCIAL_RULES } from "@tempo/shared";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export function RegisterForm({ next }: { next: string }) {
  const router = useRouter();
  const [username, setUsername] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [usernameHint, setUsernameHint] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [done, setDone] = React.useState(false);

  const usernameValid = SOCIAL_RULES.usernameRegex.test(username) && username.length >= SOCIAL_RULES.usernameMin && username.length <= SOCIAL_RULES.usernameMax;

  React.useEffect(() => {
    if (!usernameValid) {
      setUsernameHint(null);
      return;
    }
    const t = setTimeout(async () => {
      const r = await authClient.isUsernameAvailable({ username });
      setUsernameHint(r.data?.available === false ? "That username is taken" : null);
    }, 350);
    return () => clearTimeout(t);
  }, [username, usernameValid]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!usernameValid) {
      setError(`Usernames are ${SOCIAL_RULES.usernameMin}–${SOCIAL_RULES.usernameMax} characters: letters, numbers and underscores.`);
      return;
    }
    setLoading(true);
    const result = await authClient.signUp.email({ email: email.trim(), password, name: username, username, displayUsername: username });
    setLoading(false);
    if (result.error) {
      setError(result.error.message ?? "Could not create account");
      return;
    }
    // When verification is required the session is not created until the email is confirmed.
    const session = await authClient.getSession();
    if (session.data?.session) {
      router.push(next.startsWith("/") ? next : "/play");
      router.refresh();
    } else {
      setDone(true);
    }
  };

  if (done) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold tracking-tight">Check your inbox</h1>
        <p className="text-sm text-fg-muted">We sent a verification link to {email}. Click it to activate your account, then log in.</p>
        <Link href="/login" className="inline-block text-sm font-medium text-accent hover:underline">
          Back to log in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Create your account</h1>
        <p className="mt-1 text-sm text-fg-muted">Pick a username other players will see. It's free.</p>
      </div>
      <Input
        label="Username"
        autoComplete="username"
        value={username}
        onChange={(e) => setUsername(e.target.value.replace(/\s+/g, ""))}
        required
        autoFocus
        minLength={SOCIAL_RULES.usernameMin}
        maxLength={SOCIAL_RULES.usernameMax}
        error={usernameHint}
        hint="3–20 characters: letters, numbers, underscores"
      />
      <Input label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <Input label="Password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} hint="At least 8 characters" />
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Button type="submit" size="lg" fullWidth loading={loading}>
        Create account
      </Button>
      <p className="text-center text-sm text-fg-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-accent hover:underline">
          Log in
        </Link>
      </p>
    </form>
  );
}
