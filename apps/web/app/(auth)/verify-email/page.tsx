"use client";

import * as React from "react";
import Link from "next/link";
import { authClient, useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/Button";

export default function VerifyEmailPage() {
  const { data } = useSession();
  const [sent, setSent] = React.useState(false);
  const email = data?.user.email;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Verify your email</h1>
      {data?.user.emailVerified ? (
        <p className="text-sm text-success">Your email is verified.</p>
      ) : (
        <>
          <p className="text-sm text-fg-muted">{email ? `We can send a new verification link to ${email}.` : "Log in to resend your verification email."}</p>
          {email ? (
            <Button
              size="lg"
              fullWidth
              disabled={sent}
              onClick={async () => {
                await authClient.sendVerificationEmail({ email, callbackURL: "/login?verified=1" });
                setSent(true);
              }}
            >
              {sent ? "Sent — check your inbox" : "Resend verification email"}
            </Button>
          ) : null}
        </>
      )}
      <Link href="/" className="block text-center text-sm text-fg-muted hover:text-fg">
        Back home
      </Link>
    </div>
  );
}
