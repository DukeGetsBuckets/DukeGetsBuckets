"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export function LoginForm({ next, verified }: { next: string; verified: boolean }) {
  const router = useRouter();
  const [identifier, setIdentifier] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const isEmail = identifier.includes("@");
    const result = isEmail
      ? await authClient.signIn.email({ email: identifier.trim(), password })
      : await authClient.signIn.username({ username: identifier.trim(), password });
    setLoading(false);
    if (result.error) {
      setError(result.error.message ?? "Could not log in");
      return;
    }
    router.push(next.startsWith("/") ? next : "/");
    router.refresh();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Welcome back</h1>
        <p className="mt-1 text-sm text-fg-muted">Log in to play rated games, challenge friends and review your games.</p>
      </div>
      {verified ? <p className="rounded-xl bg-success-soft px-3 py-2 text-sm text-success">Email verified — you can log in now.</p> : null}
      <Input label="Username or email" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required autoFocus />
      <Input label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Button type="submit" size="lg" fullWidth loading={loading}>
        Log in
      </Button>
      <div className="flex items-center justify-between text-sm text-fg-muted">
        <Link href="/forgot-password" className="hover:text-fg">
          Forgot password?
        </Link>
        <Link href="/register" className="font-medium text-accent hover:underline">
          Create account
        </Link>
      </div>
    </form>
  );
}
