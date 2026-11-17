"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { emitWithAck } from "@/lib/socket";
import { useSocket } from "@/components/providers/SocketProvider";
import { Button } from "@/components/ui/Button";

export function AcceptLinkChallenge({ token }: { token: string }) {
  const { socket, connected } = useSocket();
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const accept = async () => {
    if (!socket) return;
    setBusy(true);
    const r = await emitWithAck(socket, "challenge:accept", { token });
    setBusy(false);
    if (!r.ok) setError(r.error.message);
    else router.push(`/game/${r.gameId}`);
  };
  return (
    <div className="mt-6">
      <Button size="lg" fullWidth onClick={accept} loading={busy} disabled={!connected}>
        Accept and play
      </Button>
      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
    </div>
  );
}
