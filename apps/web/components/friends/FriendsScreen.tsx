"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Search, Swords, UserMinus, UserPlus, X } from "lucide-react";
import type { FriendSummary } from "@tempo/shared";
import { emitWithAck } from "@/lib/socket";
import { useSocket } from "@/components/providers/SocketProvider";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { ChallengeDialog } from "./ChallengeDialog";

export interface PendingRequest {
  id: string;
  user: { id: string; username: string; image: string | null };
  createdAt: string;
}

type SearchResult = { id: string; username: string; image: string | null; relation: "none" | "friend" | "outgoing" | "incoming" | "blocked" | "self" };

export function FriendsScreen({ initialIncoming, initialOutgoing, meId }: { initialIncoming: PendingRequest[]; initialOutgoing: PendingRequest[]; meId: string }) {
  const { socket, connected } = useSocket();
  const { toast } = useToast();
  const [friends, setFriends] = React.useState<FriendSummary[] | null>(null);
  const [incoming, setIncoming] = React.useState(initialIncoming);
  const [outgoing, setOutgoing] = React.useState(initialOutgoing);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [challenging, setChallenging] = React.useState<{ id: string; username: string } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const loadFriends = React.useCallback(async () => {
    if (!socket) return;
    const r = await emitWithAck(socket, "friend:list", undefined);
    if (r.ok) setFriends(r.friends);
  }, [socket]);

  // Realtime pushes can arrive before this page's listeners exist (slow connections), so the server's
  // pending lists are re-read on every connect and whenever a related notification arrives.
  const refreshRequests = React.useCallback(async () => {
    const res = await fetch("/api/friends/requests", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { incoming: PendingRequest[]; outgoing: PendingRequest[] };
    setIncoming(data.incoming);
    setOutgoing(data.outgoing);
  }, []);

  React.useEffect(() => {
    if (!socket || !connected) return;
    void loadFriends();
    void refreshRequests();
    const onPresence = ({ userId, status, gameId }: { userId: string; status: FriendSummary["status"]; gameId: string | null }) =>
      setFriends((list) => list?.map((f) => (f.id === userId ? { ...f, status, gameId } : f)) ?? null);
    const onRequest = ({ requestId, from }: { requestId: string; from: { id: string; username: string; image: string | null } }) =>
      setIncoming((list) => [{ id: requestId, user: from, createdAt: new Date().toISOString() }, ...list.filter((r) => r.id !== requestId)]);
    const onResolved = ({ requestId }: { requestId: string }) => {
      setIncoming((list) => list.filter((r) => r.id !== requestId));
      setOutgoing((list) => list.filter((r) => r.id !== requestId));
      void loadFriends();
    };
    const onAccepted = ({ friend }: { friend: FriendSummary }) => {
      setOutgoing((list) => list.filter((r) => r.user.id !== friend.id));
      setFriends((list) => [friend, ...(list ?? []).filter((f) => f.id !== friend.id)]);
    };
    const onRemoved = ({ userId }: { userId: string }) => setFriends((list) => list?.filter((f) => f.id !== userId) ?? null);
    const onNotification = (n: { type: string }) => {
      if (n.type === "FRIEND_REQUEST" || n.type === "FRIEND_ACCEPTED") {
        void refreshRequests();
        void loadFriends();
      }
    };
    socket.on("notification:new", onNotification);
    socket.on("friend:presence", onPresence);
    socket.on("friend:request:received", onRequest);
    socket.on("friend:request:resolved", onResolved);
    socket.on("friend:accepted", onAccepted);
    socket.on("friend:removed", onRemoved);
    return () => {
      socket.off("notification:new", onNotification);
      socket.off("friend:presence", onPresence);
      socket.off("friend:request:received", onRequest);
      socket.off("friend:request:resolved", onResolved);
      socket.off("friend:accepted", onAccepted);
      socket.off("friend:removed", onRemoved);
    };
  }, [socket, connected, loadFriends, refreshRequests]);

  // Live search as you type (debounced).
  React.useEffect(() => {
    if (!socket) return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      const r = await emitWithAck(socket, "user:search", { query: q });
      setSearching(false);
      if (r.ok) setResults(r.users);
    }, 250);
    return () => clearTimeout(t);
  }, [query, socket]);

  const act = async (key: string, fn: () => Promise<{ ok: boolean; error?: { message: string } }>, success?: string) => {
    setBusy(key);
    const r = await fn();
    setBusy(null);
    if (!r.ok) toast({ title: r.error?.message ?? "Something went wrong", tone: "danger" });
    else if (success) toast({ title: success, tone: "success" });
    return r.ok;
  };

  const sendRequest = async (user: SearchResult) => {
    if (!socket) return;
    const ok = await act(`add-${user.id}`, () => emitWithAck(socket, "friend:request", { userId: user.id }), `Friend request sent to ${user.username}`);
    if (ok) {
      setResults((list) => list.map((u) => (u.id === user.id ? { ...u, relation: "outgoing" } : u)));
      setOutgoing((list) => [{ id: `tmp-${user.id}`, user: { id: user.id, username: user.username, image: user.image }, createdAt: new Date().toISOString() }, ...list]);
    }
  };

  const respond = async (req: PendingRequest, accept: boolean) => {
    if (!socket) return;
    const ok = await act(`req-${req.id}`, () => emitWithAck(socket, accept ? "friend:accept" : "friend:decline", { requestId: req.id }));
    if (ok) {
      setIncoming((list) => list.filter((r) => r.id !== req.id));
      if (accept) void loadFriends();
    }
  };

  const cancelOutgoing = async (req: PendingRequest) => {
    if (!socket) return;
    const ok = await act(`cancel-${req.id}`, () => emitWithAck(socket, "friend:cancel", { requestId: req.id }));
    if (ok) setOutgoing((list) => list.filter((r) => r.id !== req.id));
  };

  const remove = async (f: FriendSummary) => {
    if (!socket || !confirm(`Remove ${f.username} from your friends?`)) return;
    const ok = await act(`rm-${f.id}`, () => emitWithAck(socket, "friend:remove", { userId: f.id }));
    if (ok) setFriends((list) => list?.filter((x) => x.id !== f.id) ?? null);
  };

  const online = friends?.filter((f) => f.status !== "offline") ?? [];
  const offline = friends?.filter((f) => f.status === "offline") ?? [];

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="space-y-6 lg:col-span-3">
        <Card>
          <CardHeader title="Quick Add" subtitle="Type a username to find and add players instantly." />
          <CardBody>
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by username…"
                autoCapitalize="none"
                autoCorrect="off"
                className="h-12 w-full rounded-xl border border-border bg-surface pl-10 pr-3 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/40"
              />
            </label>
            {query.trim() ? (
              <ul className="mt-3 divide-y divide-border">
                {!results.length && !searching ? <li className="py-6 text-center text-sm text-fg-muted">No players match “{query}”.</li> : null}
                {results.map((u) => (
                  <li key={u.id} className="flex items-center gap-3 py-2.5">
                    <Avatar name={u.username} src={u.image} size={36} />
                    <Link href={`/profile/${u.username}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
                      {u.username}
                    </Link>
                    {u.relation === "none" ? (
                      <Button size="sm" onClick={() => sendRequest(u)} loading={busy === `add-${u.id}`} disabled={!connected}>
                        <UserPlus className="h-4 w-4" /> Add friend
                      </Button>
                    ) : u.relation === "friend" ? (
                      <Button size="sm" variant="secondary" onClick={() => setChallenging({ id: u.id, username: u.username })}>
                        <Swords className="h-4 w-4" /> Challenge
                      </Button>
                    ) : u.relation === "incoming" ? (
                      <span className="text-xs text-fg-muted">Sent you a request</span>
                    ) : (
                      <span className="text-xs text-fg-muted">{u.relation === "outgoing" ? "Request sent" : u.relation === "self" ? "That's you" : "Blocked"}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={`Friends${friends ? ` (${friends.length})` : ""}`} />
          <CardBody className="px-2">
            {!friends ? <p className="px-3 py-6 text-center text-sm text-fg-muted">{connected ? "Loading…" : "Connecting…"}</p> : null}
            {friends && !friends.length ? <EmptyState title="No friends yet" description="Use Quick Add above to find players by username." /> : null}
            {[...online, ...offline].map((f) => (
              <div key={f.id} className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-surface-2">
                <Avatar name={f.username} src={f.image} size={40} status={f.status} />
                <div className="min-w-0 flex-1">
                  <Link href={`/profile/${f.username}`} className="block truncate font-semibold hover:underline">
                    {f.username}
                  </Link>
                  <p className="truncate text-xs text-fg-muted">
                    {f.status === "playing" ? (
                      <Link href={`/game/${f.gameId}`} className="text-accent hover:underline">
                        Playing now — watch
                      </Link>
                    ) : f.status === "online" ? (
                      "Online"
                    ) : (
                      "Offline"
                    )}{" "}
                    · {f.ratings.BULLET} / {f.ratings.BLITZ} / {f.ratings.RAPID}
                  </p>
                </div>
                <Button size="sm" onClick={() => setChallenging({ id: f.id, username: f.username })} disabled={f.status === "playing" || !connected}>
                  <Swords className="h-4 w-4" /> Challenge
                </Button>
                <button onClick={() => remove(f)} className="rounded-lg p-2 text-fg-faint hover:bg-surface-3 hover:text-danger" aria-label={`Remove ${f.username}`}>
                  <UserMinus className="h-4 w-4" />
                </button>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>

      <div className="space-y-6 lg:col-span-2">
        <Card>
          <CardHeader title={`Friend requests${incoming.length ? ` (${incoming.length})` : ""}`} />
          <CardBody className="px-2">
            {!incoming.length ? <p className="px-3 py-4 text-sm text-fg-muted">No pending requests.</p> : null}
            {incoming.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-3 py-2">
                <Avatar name={r.user.username} src={r.user.image} size={36} />
                <Link href={`/profile/${r.user.username}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
                  {r.user.username}
                </Link>
                <Button size="sm" variant="success" onClick={() => respond(r, true)} loading={busy === `req-${r.id}`} aria-label="Accept" disabled={!connected}>
                  <Check className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="secondary" onClick={() => respond(r, false)} aria-label="Decline">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Sent requests" />
          <CardBody className="px-2">
            {!outgoing.length ? <p className="px-3 py-4 text-sm text-fg-muted">Nothing pending.</p> : null}
            {outgoing.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-3 py-2">
                <Avatar name={r.user.username} src={r.user.image} size={36} />
                <span className="min-w-0 flex-1 truncate text-sm">{r.user.username}</span>
                <Button size="sm" variant="ghost" onClick={() => cancelOutgoing(r)} disabled={r.id.startsWith("tmp-")}>
                  Cancel
                </Button>
              </div>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Challenges" subtitle="Incoming invitations appear as notifications and on the challenges page." action={<Link href="/challenges" className="text-sm font-medium text-accent hover:underline">Open</Link>} />
        </Card>
      </div>
      <ChallengeDialog open={Boolean(challenging)} onClose={() => setChallenging(null)} recipient={challenging} />
      <span className="hidden">{meId}</span>
    </div>
  );
}
