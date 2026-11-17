"use client";

import * as React from "react";
import Link from "next/link";
import type { FriendSummary } from "@tempo/shared";
import { emitWithAck } from "@/lib/socket";
import { useSocket } from "@/components/providers/SocketProvider";
import { Avatar } from "@/components/ui/Avatar";

export function OnlineFriends() {
  const { socket, connected } = useSocket();
  const [friends, setFriends] = React.useState<FriendSummary[] | null>(null);

  React.useEffect(() => {
    if (!socket || !connected) return;
    void emitWithAck(socket, "friend:list", undefined).then((r) => {
      if (r.ok) setFriends(r.friends);
    });
    const onPresence = ({ userId, status, gameId }: { userId: string; status: FriendSummary["status"]; gameId: string | null }) =>
      setFriends((list) => list?.map((f) => (f.id === userId ? { ...f, status, gameId } : f)) ?? null);
    socket.on("friend:presence", onPresence);
    return () => {
      socket.off("friend:presence", onPresence);
    };
  }, [socket, connected]);

  if (!friends) return <p className="text-sm text-fg-muted">Loading…</p>;
  if (!friends.length)
    return (
      <p className="text-sm text-fg-muted">
        No friends yet.{" "}
        <Link href="/friends" className="font-medium text-accent hover:underline">
          Quick-add someone
        </Link>
        .
      </p>
    );
  const online = friends.filter((f) => f.status !== "offline");
  return (
    <ul className="space-y-2">
      {(online.length ? online : friends.slice(0, 5)).map((f) => (
        <li key={f.id}>
          <Link href={`/profile/${f.username}`} className="flex items-center gap-3 rounded-lg px-1 py-1 hover:bg-surface-2">
            <Avatar name={f.username} src={f.image} size={32} status={f.status} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{f.username}</span>
              <span className="block text-xs text-fg-faint capitalize">{f.status}</span>
            </span>
          </Link>
        </li>
      ))}
      {!online.length ? <li className="text-xs text-fg-faint">Nobody online right now.</li> : null}
    </ul>
  );
}
