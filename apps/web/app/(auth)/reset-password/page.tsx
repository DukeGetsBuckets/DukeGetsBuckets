"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export default function ResetPasswordPage() {
  return (
    <React.Suspense fallback={null}>
      <ResetPasswordForm />
    </React.Suspense>
  );
}

function ResetPasswordForm() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(params.get("error") ? "This reset link is invalid or expired." : null);
  const [loading, setLoading] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setLoading(true);
    const r = await authClient.resetPassword({ newPassword: password, token });
    setLoading(false);
    if (r.error) {
      setError(r.error.message ?? "Could not reset password");
      return;
    }
    router.push("/login");
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Choose a new password</h1>
      {!token ? <p className="text-sm text-danger">Missing reset token. Request a new link.</p> : null}
      <Input label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Button type="submit" size="lg" fullWidth loading={loading} disabled={!token}>
        Update password
      </Button>
      <Link href="/forgot-password" className="block text-center text-sm text-fg-muted hover:text-fg">
        Request a new link
      </Link>
    </form>
  );
}
