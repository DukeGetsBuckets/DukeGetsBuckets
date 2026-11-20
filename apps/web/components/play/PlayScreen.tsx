"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, Link2, Loader2, Swords, Users, X, Zap } from "lucide-react";
import { TIME_CONTROLS, type QueueStatus, type RatingCategory } from "@tempo/shared";
import { emitWithAck } from "@/lib/socket";
import { useSocket } from "@/components/providers/SocketProvider";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import type { RatingSummary } from "@/lib/queries/ratings";
import { cn } from "@/lib/cn";

const LAST_MODE_KEY = "tempo-last-mode";

export function PlayScreen({ ratings, activeGameId, initialMode, autoQuick }: { ratings: RatingSummary[]; activeGameId: string | null; initialMode: RatingCategory | null; autoQuick: boolean }) {
  const { socket, connected } = useSocket();
  const router = useRouter();
  const { toast } = useToast();
  const [rated, setRated] = React.useState(true);
  const [queue, setQueue] = React.useState<QueueStatus | null>(null);
  const [joining, setJoining] = React.useState<RatingCategory | null>(null);
  const [waitingMs, setWaitingMs] = React.useState(0);
  const [creatingLink, setCreatingLink] = React.useState(false);
  const [linkUrl, setLinkUrl] = React.useState<string | null>(null);
  const autoRan = React.useRef(false);

  // Queue status pushes + leave notifications.
  React.useEffect(() => {
    if (!socket) return;
    const onStatus = (s: QueueStatus) => setQueue(s);
    const onLeft = ({ reason }: { reason: string }) => {
      setQueue(null);
      if (reason === "disconnected") toast({ title: "Left the queue", description: "Your connection dropped.", tone: "danger" });
    };
    socket.on("queue:status", onStatus);
    socket.on("queue:left", onLeft);
    return () => {
      socket.off("queue:status", onStatus);
      socket.off("queue:left", onLeft);
    };
  }, [socket, toast]);

  // Smooth local timer between server status pushes.
  React.useEffect(() => {
    if (!queue) return;
    const tick = () => setWaitingMs(Date.now() - queue.joinedAt);
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [queue]);

  const join = React.useCallback(
    async (category: RatingCategory) => {
      if (!socket || !connected) {
        toast({ title: "Connecting…", description: "Please wait a moment and try again.", tone: "neutral" });
        return;
      }
      setJoining(category);
      const r = await emitWithAck(socket, "queue:join", { category, rated });
      setJoining(null);
      if (!r.ok) {
        if (r.error.code === "ALREADY_IN_GAME" && activeGameId) router.push(`/game/${activeGameId}`);
        else toast({ title: "Could not join queue", description: r.error.message, tone: "danger" });
        return;
      }
      try {
        localStorage.setItem(LAST_MODE_KEY, category);
      } catch {
        /* ignore */
      }
      setQueue(r.status);
    },
    [socket, connected, rated, toast, router, activeGameId],
  );

  const cancel = async () => {
    if (!socket) return;
    await emitWithAck(socket, "queue:cancel", undefined);
    setQueue(null);
  };

  // ?mode= or ?quick=1 deep links start the queue once connected.
  React.useEffect(() => {
    if (autoRan.current || !connected || activeGameId) return;
    if (initialMode) {
      autoRan.current = true;
      void join(initialMode);
    } else if (autoQuick) {
      autoRan.current = true;
      let last: RatingCategory = "BLITZ";
      try {
        const saved = localStorage.getItem(LAST_MODE_KEY) as RatingCategory | null;
        if (saved && TIME_CONTROLS[saved]) last = saved;
      } catch {
        /* ignore */
      }
      void join(last);
    }
  }, [connected, initialMode, autoQuick, join, activeGameId]);

  const quickPlay = () => {
    let last: RatingCategory = "BLITZ";
    try {
      const saved = localStorage.getItem(LAST_MODE_KEY) as RatingCategory | null;
      if (saved && TIME_CONTROLS[saved]) last = saved;
    } catch {
      /* ignore */
    }
    void join(last);
  };

  const createLink = async () => {
    if (!socket) return;
    setCreatingLink(true);
    const r = await emitWithAck(socket, "challenge:create", { category: "BLITZ", rated, color: "RANDOM" });
    setCreatingLink(false);
    if (!r.ok) {
      toast({ title: "Could not create challenge", description: r.error.message, tone: "danger" });
      return;
    }
    const url = `${window.location.origin}/challenge/${r.challenge.token}`;
    setLinkUrl(url);
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "Link copied", description: "Send it to a friend — the first person to open it plays you.", tone: "success" });
    } catch {
      /* clipboard may be unavailable */
    }
  };

  if (activeGameId) {
    return (
      <div className="card mx-auto max-w-lg p-8 text-center">
        <Swords className="mx-auto h-8 w-8 text-accent" />
        <h1 className="mt-3 text-xl font-semibold">You have a game in progress</h1>
        <p className="mt-1 text-sm text-fg-muted">Finish it before starting a new one.</p>
        <Button className="mt-5" size="lg" onClick={() => router.push(`/game/${activeGameId}`)}>
          Return to game
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Play</h1>
          <p className="text-sm text-fg-muted">{connected ? "Pick a time control to find an opponent." : "Connecting to the game server…"}</p>
        </div>
        <Segmented
          value={rated ? "rated" : "casual"}
          onChange={(v) => setRated(v === "rated")}
          options={[
            { value: "rated", label: "Rated" },
            { value: "casual", label: "Casual" },
          ]}
        />
      </div>

      {queue ? (
        <QueuePanel queue={queue} waitingMs={waitingMs} onCancel={cancel} />
      ) : (
        <>
          <button
            onClick={quickPlay}
            disabled={!connected || joining != null}
            className="card flex w-full items-center justify-between gap-4 p-5 text-left transition hover:border-accent/60 disabled:opacity-60"
          >
            <span className="flex items-center gap-4">
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-accent-fg">
                <Zap className="h-6 w-6" />
              </span>
              <span>
                <span className="block text-lg font-semibold">Quick Play</span>
                <span className="block text-sm text-fg-muted">Jump into your last time control instantly</span>
              </span>
            </span>
            {joining ? <Loader2 className="h-5 w-5 animate-spin text-fg-muted" /> : null}
          </button>

          <div className="grid gap-3 sm:grid-cols-3">
            {(["BULLET", "BLITZ", "RAPID"] as RatingCategory[]).map((category) => {
              const tc = TIME_CONTROLS[category];
              const r = ratings.find((x) => x.category === category)!;
              return (
                <button
                  key={category}
                  onClick={() => join(category)}
                  disabled={!connected || joining != null}
                  className={cn("card flex min-h-[132px] flex-col items-start justify-between p-5 text-left transition hover:border-accent/60 active:scale-[0.99] disabled:opacity-60", joining === category && "border-accent")}
                >
                  <span className="text-sm font-medium text-fg-muted">{tc.name}</span>
                  <span className="text-3xl font-bold tracking-tight">{tc.label}</span>
                  <span className="text-xs text-fg-faint">
                    Your rating {r.rating}
                    {r.provisional ? "?" : ""}
                  </span>
                </button>
              );
            })}
          </div>

          <Link href="/play/bot" className="card flex items-center gap-4 p-5 transition hover:border-accent/60">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-accent">
              <Bot className="h-5 w-5" />
            </span>
            <span>
              <span className="block font-semibold">Play the bot</span>
              <span className="block text-sm text-fg-muted">A 2000-rated Stockfish bot that shows its thinking on every move (unrated)</span>
            </span>
          </Link>

          <div className="grid gap-3 sm:grid-cols-2">
            <Link href="/friends" className="card flex items-center gap-4 p-5 transition hover:border-accent/60">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-accent">
                <Users className="h-5 w-5" />
              </span>
              <span>
                <span className="block font-semibold">Play a friend</span>
                <span className="block text-sm text-fg-muted">Challenge someone from your friends list</span>
              </span>
            </Link>
            <button onClick={createLink} disabled={!connected || creatingLink} className="card flex items-center gap-4 p-5 text-left transition hover:border-accent/60 disabled:opacity-60">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-accent">
                <Link2 className="h-5 w-5" />
              </span>
              <span>
                <span className="block font-semibold">Custom challenge link</span>
                <span className="block text-sm text-fg-muted">{linkUrl ? "Link copied — share it with anyone" : `Create a shareable ${rated ? "rated" : "casual"} 5+0 invite`}</span>
              </span>
            </button>
          </div>
          {linkUrl ? (
            <div className="card flex items-center gap-3 p-3 text-sm">
              <code className="min-w-0 flex-1 truncate text-fg-muted">{linkUrl}</code>
              <Button size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(linkUrl)}>
                Copy
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function QueuePanel({ queue, waitingMs, onCancel }: { queue: QueueStatus; waitingMs: number; onCancel: () => void }) {
  const tc = TIME_CONTROLS[queue.category];
  const seconds = Math.floor(waitingMs / 1000);
  return (
    <div className="card animate-fade-in p-6 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-accent-soft text-accent animate-pulse-ring">
        <Swords className="h-7 w-7" />
      </div>
      <h2 className="mt-4 text-xl font-semibold">Searching for an opponent…</h2>
      <p className="mt-1 text-sm text-fg-muted">
        {tc.name} {tc.label} · {queue.rated ? "Rated" : "Casual"}
      </p>
      <div className="mx-auto mt-5 grid max-w-xs grid-cols-3 gap-3 text-center">
        <Stat label="Waiting" value={`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`} />
        <Stat label="Rating range" value={`±${queue.range}`} />
        <Stat label="In queue" value={String(queue.waiting)} />
      </div>
      <p className="mt-4 text-xs text-fg-faint">The search window widens the longer you wait. Only real, online players are matched.</p>
      <Button variant="outline" size="lg" className="mt-5" onClick={onCancel}>
        <X className="h-4 w-4" /> Cancel
      </Button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface-2 px-2 py-3">
      <div className="clock-digits text-lg font-semibold">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-fg-faint">{label}</div>
    </div>
  );
}
