"use client";

import * as React from "react";
import Link from "next/link";
import { Check, X } from "lucide-react";
import type { NotificationDTO } from "@tempo/shared";
import { emitWithAck } from "@/lib/socket";
import { useSocket } from "@/components/providers/SocketProvider";
import { Button } from "@/components/ui/Button";

export function NotificationsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { socket, setUnread } = useSocket();
  const [items, setItems] = React.useState<NotificationDTO[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch("/api/notifications")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: NotificationDTO[]) => setItems(list))
      .finally(() => setLoading(false));
  }, [open]);

  React.useEffect(() => {
    if (!socket) return;
    const onNew = (n: NotificationDTO) => setItems((list) => [n, ...list].slice(0, 50));
    socket.on("notification:new", onNew);
    return () => {
      socket.off("notification:new", onNew);
    };
  }, [socket]);

  const markAll = async () => {
    if (!socket) return;
    const r = await emitWithAck(socket, "notification:read", { all: true });
    if (r.ok) {
      setUnread(r.unread);
      setItems((list) => list.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    }
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose} role="presentation">
      <div className="flex h-full w-full max-w-sm flex-col border-l border-border bg-bg-elevated shadow-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Notifications">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="font-semibold">Notifications</h2>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={markAll}>
              <Check className="h-4 w-4" /> Mark all read
            </Button>
            <button onClick={onClose} className="rounded-lg p-2 text-fg-muted hover:bg-surface-2" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading && !items.length ? <p className="p-6 text-center text-sm text-fg-muted">Loading…</p> : null}
          {!loading && !items.length ? <p className="p-6 text-center text-sm text-fg-muted">You're all caught up.</p> : null}
          {items.map((n) => (
            <NotificationRow key={n.id} n={n} onClose={onClose} />
          ))}
        </div>
      </div>
    </div>
  );
}

function describe(n: NotificationDTO): { text: string; href: string | null } {
  const p = n.payload as Record<string, string | undefined>;
  switch (n.type) {
    case "FRIEND_REQUEST":
      return { text: `${p.fromUsername ?? "Someone"} sent you a friend request`, href: "/friends" };
    case "FRIEND_ACCEPTED":
      return { text: `${p.username ?? "Someone"} accepted your friend request`, href: "/friends" };
    case "CHALLENGE":
      return { text: `${p.from ?? "Someone"} challenged you to ${String(p.category ?? "").toLowerCase()} chess`, href: "/challenges" };
    case "CHALLENGE_ACCEPTED":
      return { text: "Your challenge was accepted", href: p.gameId ? `/game/${p.gameId}` : "/challenges" };
    case "CHALLENGE_DECLINED":
      return { text: "Your challenge was declined", href: "/challenges" };
    case "REMATCH":
      return { text: `${p.from ?? "Your opponent"} wants a rematch`, href: p.gameId ? `/game/${p.gameId}` : null };
    case "ANALYSIS_READY":
      return { text: "Your game review is ready", href: p.gameId ? `/review/${p.gameId}` : "/history" };
    case "GAME_FINISHED":
      return { text: "A game finished", href: p.gameId ? `/game/${p.gameId}` : null };
    default:
      return { text: String(p.message ?? "Notification"), href: null };
  }
}

function NotificationRow({ n, onClose }: { n: NotificationDTO; onClose: () => void }) {
  const { text, href } = describe(n);
  const body = (
    <div className={`flex items-start gap-3 px-4 py-3 ${n.readAt ? "opacity-60" : ""}`}>
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.readAt ? "bg-transparent" : "bg-accent"}`} />
      <div className="min-w-0">
        <p className="text-sm">{text}</p>
        <p className="text-xs text-fg-faint">{new Date(n.createdAt).toLocaleString()}</p>
      </div>
    </div>
  );
  return href ? (
    <Link href={href} onClick={onClose} className="block border-b border-border hover:bg-surface-2">
      {body}
    </Link>
  ) : (
    <div className="border-b border-border">{body}</div>
  );
}
