"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Link2, X } from "lucide-react";
import { TIME_CONTROLS, type ChallengeDTO } from "@tempo/shared";
import { emitWithAck } from "@/lib/socket";
import { useSocket } from "@/components/providers/SocketProvider";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";

export function ChallengesScreen({ initialIncoming, initialOutgoing, meId }: { initialIncoming: ChallengeDTO[]; initialOutgoing: ChallengeDTO[]; meId: string }) {
  const { socket, connected } = useSocket();
  const { toast } = useToast();
  const router = useRouter();
  const [incoming, setIncoming] = React.useState(initialIncoming);
  const [outgoing, setOutgoing] = React.useState(initialOutgoing);
  const [busy, setBusy] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const res = await fetch("/api/challenges", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { incoming: ChallengeDTO[]; outgoing: ChallengeDTO[] };
    setIncoming(data.incoming);
    setOutgoing(data.outgoing);
  }, []);

  React.useEffect(() => {
    if (!socket || !connected) return;
    // Pushes can arrive before this page's listeners exist; re-read the server's list on connect.
    void refresh();
    const onNotification = (n: { type: string }) => {
      if (n.type.startsWith("CHALLENGE")) void refresh();
    };
    socket.on("notification:new", onNotification);
    const onReceived = (c: ChallengeDTO) => setIncoming((list) => [c, ...list.filter((x) => x.id !== c.id)]);
    const gone = ({ challengeId }: { challengeId: string }) => {
      setIncoming((list) => list.filter((c) => c.id !== challengeId));
      setOutgoing((list) => list.filter((c) => c.id !== challengeId));
    };
    socket.on("challenge:received", onReceived);
    socket.on("challenge:accepted", gone);
    socket.on("challenge:declined", gone);
    socket.on("challenge:canceled", gone);
    socket.on("challenge:expired", gone);
    return () => {
      socket.off("notification:new", onNotification);
      socket.off("challenge:received", onReceived);
      socket.off("challenge:accepted", gone);
      socket.off("challenge:declined", gone);
      socket.off("challenge:canceled", gone);
      socket.off("challenge:expired", gone);
    };
  }, [socket, connected, refresh]);

  const accept = async (c: ChallengeDTO) => {
    if (!socket) return;
    setBusy(c.id);
    const r = await emitWithAck(socket, "challenge:accept", { challengeId: c.id });
    setBusy(null);
    if (!r.ok) toast({ title: "Could not accept", description: r.error.message, tone: "danger" });
    else router.push(`/game/${r.gameId}`);
  };
  const decline = async (c: ChallengeDTO) => {
    if (!socket) return;
    await emitWithAck(socket, "challenge:decline", { challengeId: c.id });
    setIncoming((list) => list.filter((x) => x.id !== c.id));
  };
  const cancel = async (c: ChallengeDTO) => {
    if (!socket) return;
    await emitWithAck(socket, "challenge:cancel", { challengeId: c.id });
    setOutgoing((list) => list.filter((x) => x.id !== c.id));
  };

  const describe = (c: ChallengeDTO) => `${TIME_CONTROLS[c.category].name} ${TIME_CONTROLS[c.category].label} · ${c.rated ? "Rated" : "Casual"} · ${c.senderColor === "RANDOM" ? "Random colors" : `${c.sender.username} plays ${c.senderColor.toLowerCase()}`}`;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Incoming" subtitle="Challenges addressed to you." />
        <CardBody className="px-2">
          {!incoming.length ? <p className="px-3 py-6 text-center text-sm text-fg-muted">No incoming challenges.</p> : null}
          {incoming.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-3 py-3">
              <Avatar name={c.sender.username} src={c.sender.image} size={40} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">
                  {c.sender.username} <span className="text-sm font-normal text-fg-muted">({c.sender.rating})</span>
                </p>
                <p className="truncate text-xs text-fg-muted">{describe(c)}</p>
                <p className="text-xs text-fg-faint">Expires {new Date(c.expiresAt).toLocaleTimeString()}</p>
              </div>
              <Button size="sm" variant="success" onClick={() => accept(c)} loading={busy === c.id} disabled={!connected}>
                <Check className="h-4 w-4" /> Accept
              </Button>
              <Button size="sm" variant="secondary" onClick={() => decline(c)} aria-label="Decline" disabled={!connected}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Outgoing" subtitle="Waiting for a response." />
        <CardBody className="px-2">
          {!outgoing.length ? <p className="px-3 py-6 text-center text-sm text-fg-muted">You have no pending challenges.</p> : null}
          {outgoing.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">
                  {c.recipient ? `To ${c.recipient.username}` : "Open link challenge"} {!c.recipient ? <Badge tone="accent"><Link2 className="h-3 w-3" /> link</Badge> : null}
                </p>
                <p className="truncate text-xs text-fg-muted">{describe(c)}</p>
                {!c.recipient ? (
                  <button className="mt-1 text-xs text-accent hover:underline" onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/challenge/${c.token}`).then(() => toast({ title: "Link copied", tone: "success" }))}>
                    Copy invite link
                  </button>
                ) : null}
              </div>
              <Button size="sm" variant="ghost" onClick={() => cancel(c)}>
                Cancel
              </Button>
            </div>
          ))}
        </CardBody>
      </Card>
      <p className="text-xs text-fg-faint lg:col-span-2">
        Signed in as {meId.slice(0, 6)}… · Need a new opponent? <Link href="/play" className="text-accent hover:underline">Go to Play</Link>
      </p>
    </div>
  );
}
