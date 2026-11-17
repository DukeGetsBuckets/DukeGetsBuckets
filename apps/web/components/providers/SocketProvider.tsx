"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import type { ChallengeDTO, ServerToClientEvents } from "@tempo/shared";
import { TIME_CONTROLS } from "@tempo/shared";
import { disposeSocket, emitWithAck, getSocket, type AppSocket } from "@/lib/socket";
import { useToast } from "@/components/ui/Toast";

interface SocketContextValue {
  socket: AppSocket | null;
  connected: boolean;
  unread: number;
  setUnread: (n: number) => void;
  pendingChallenges: ChallengeDTO[];
  dismissChallenge: (id: string) => void;
}
const SocketContext = React.createContext<SocketContextValue>({ socket: null, connected: false, unread: 0, setUnread: () => undefined, pendingChallenges: [], dismissChallenge: () => undefined });

export function SocketProvider({ authenticated, children }: { authenticated: boolean; children: React.ReactNode }) {
  const [socket, setSocket] = React.useState<AppSocket | null>(null);
  const [connected, setConnected] = React.useState(false);
  const [unread, setUnread] = React.useState(0);
  const [pendingChallenges, setPending] = React.useState<ChallengeDTO[]>([]);
  const router = useRouter();
  const pathname = usePathname();
  const { toast, dismiss } = useToast();
  const pathRef = React.useRef(pathname);
  pathRef.current = pathname;

  React.useEffect(() => {
    if (!authenticated) {
      disposeSocket();
      setSocket(null);
      setConnected(false);
      return;
    }
    let cancelled = false;
    getSocket()
      .then((s) => {
        if (cancelled) return;
        setSocket(s);
        setConnected(s.connected);
        const onConnect = () => setConnected(true);
        const onDisconnect = () => setConnected(false);
        const onCount: ServerToClientEvents["notification:count"] = ({ unread }) => setUnread(unread);
        const onMatch: ServerToClientEvents["match:found"] = (m) => {
          const tc = TIME_CONTROLS[m.category];
          toast({ title: m.source === "REMATCH" ? "Rematch on!" : "Match found", description: `${tc.name} vs ${m.opponent.username} (${m.opponent.rating}) — you play ${m.color}.`, tone: "accent", durationMs: 3000 });
          router.push(`/game/${m.gameId}`);
        };
        const onChallenge: ServerToClientEvents["challenge:received"] = (c) => {
          setPending((list) => [...list.filter((x) => x.id !== c.id), c]);
          const tc = TIME_CONTROLS[c.category];
          toast({
            id: `challenge-${c.id}`,
            title: `${c.sender.username} challenges you`,
            description: `${tc.name} ${tc.label} · ${c.rated ? "Rated" : "Casual"}`,
            tone: "accent",
            durationMs: 60_000,
            actions: [
              {
                label: "Accept",
                onClick: () => {
                  void emitWithAck(s, "challenge:accept", { challengeId: c.id }).then((r) => {
                    if (!r.ok) toast({ title: "Could not accept", description: r.error.message, tone: "danger" });
                  });
                },
              },
              { label: "Decline", variant: "secondary", onClick: () => void emitWithAck(s, "challenge:decline", { challengeId: c.id }) },
            ],
          });
        };
        const onChallengeGone = ({ challengeId }: { challengeId: string }) => {
          setPending((list) => list.filter((x) => x.id !== challengeId));
          dismiss(`challenge-${challengeId}`);
        };
        const onFriendRequest: ServerToClientEvents["friend:request:received"] = ({ from, requestId }) => {
          toast({
            id: `friend-${requestId}`,
            title: `${from.username} wants to be friends`,
            tone: "accent",
            durationMs: 20_000,
            actions: [
              { label: "Accept", onClick: () => void emitWithAck(s, "friend:accept", { requestId }) },
              { label: "Later", variant: "secondary", onClick: () => router.push("/friends") },
            ],
          });
        };
        const onFriendAccepted: ServerToClientEvents["friend:accepted"] = ({ friend }) => toast({ title: `${friend.username} accepted your friend request`, tone: "success" });
        const onFriendResolved: ServerToClientEvents["friend:request:resolved"] = ({ requestId }) => dismiss(`friend-${requestId}`);
        const onServerError: ServerToClientEvents["server:error"] = (e) => toast({ title: "Error", description: e.message, tone: "danger" });
        s.on("connect", onConnect);
        s.on("disconnect", onDisconnect);
        s.on("notification:count", onCount);
        s.on("match:found", onMatch);
        s.on("challenge:received", onChallenge);
        s.on("challenge:accepted", onChallengeGone);
        s.on("challenge:declined", onChallengeGone);
        s.on("challenge:canceled", onChallengeGone);
        s.on("challenge:expired", onChallengeGone);
        s.on("friend:request:received", onFriendRequest);
        s.on("friend:accepted", onFriendAccepted);
        s.on("friend:request:resolved", onFriendResolved);
        s.on("server:error", onServerError);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [authenticated, router, toast, dismiss]);

  const dismissChallenge = React.useCallback((id: string) => setPending((l) => l.filter((c) => c.id !== id)), []);
  const value = React.useMemo(() => ({ socket, connected, unread, setUnread, pendingChallenges, dismissChallenge }), [socket, connected, unread, pendingChallenges, dismissChallenge]);
  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketContextValue {
  return React.useContext(SocketContext);
}
