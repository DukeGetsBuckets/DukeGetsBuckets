"use client";

import * as React from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export default function ForgotPasswordPage() {
  const [email, setEmail] = React.useState("");
  const [sent, setSent] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    await authClient.requestPasswordReset({ email: email.trim(), redirectTo: "/reset-password" });
    setLoading(false);
    setSent(true); // Always confirm, to avoid revealing whether the address exists.
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Reset your password</h1>
      {sent ? (
        <p className="text-sm text-fg-muted">If an account exists for {email}, a reset link is on its way.</p>
      ) : (
        <>
          <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          <Button type="submit" size="lg" fullWidth loading={loading}>
            Send reset link
          </Button>
        </>
      )}
      <Link href="/login" className="block text-center text-sm text-fg-muted hover:text-fg">
        Back to log in
      </Link>
    </form>
  );
}
