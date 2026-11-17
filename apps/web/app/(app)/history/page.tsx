import type { Metadata } from "next";
import Link from "next/link";
import { requireSession } from "@/lib/session";
import { listGamesForUser, type GameFilters } from "@/lib/queries/games";
import { GameRow } from "@/components/play/GameRow";
import { Card, CardBody } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Game history" };

const CATEGORIES = [
  { key: "", label: "All" },
  { key: "BULLET", label: "Bullet" },
  { key: "BLITZ", label: "Blitz" },
  { key: "RAPID", label: "Rapid" },
] as const;
const OUTCOMES = [
  { key: "", label: "Any result" },
  { key: "win", label: "Wins" },
  { key: "loss", label: "Losses" },
  { key: "draw", label: "Draws" },
] as const;

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ category?: string; outcome?: string; cursor?: string; rated?: string }> }) {
  const session = await requireSession("/history");
  const params = await searchParams;
  const filters: GameFilters = {};
  if (params.category === "BULLET" || params.category === "BLITZ" || params.category === "RAPID") filters.category = params.category;
  if (params.outcome === "win" || params.outcome === "loss" || params.outcome === "draw") filters.outcome = params.outcome;
  if (params.rated === "1") filters.rated = true;
  if (params.rated === "0") filters.rated = false;
  const { items, nextCursor } = await listGamesForUser(session.id, filters, params.cursor, 25);

  const link = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const merged = { category: params.category, outcome: params.outcome, rated: params.rated, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, v);
    const s = q.toString();
    return `/history${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Game history</h1>
          <p className="text-sm text-fg-muted">Every game you've played, saved forever. Open one to replay and review it.</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Pills items={CATEGORIES} active={params.category ?? ""} hrefFor={(k) => link({ category: k || undefined, cursor: undefined })} />
        <Pills items={OUTCOMES} active={params.outcome ?? ""} hrefFor={(k) => link({ outcome: k || undefined, cursor: undefined })} />
        <Pills items={[{ key: "", label: "Rated + casual" }, { key: "1", label: "Rated" }, { key: "0", label: "Casual" }]} active={params.rated ?? ""} hrefFor={(k) => link({ rated: k || undefined, cursor: undefined })} />
      </div>
      <Card>
        <CardBody className="px-2">
          {items.length ? (
            <div className="divide-y divide-border">
              {items.map((g) => (
                <GameRow key={g.id} game={g} viewerId={session.id} />
              ))}
            </div>
          ) : (
            <EmptyState title="No games match" description="Play a game or loosen the filters." action={<Link href="/play" className="inline-flex h-10 items-center rounded-xl bg-accent px-4 text-sm font-semibold text-accent-fg">Play now</Link>} />
          )}
        </CardBody>
      </Card>
      {nextCursor ? (
        <div className="flex justify-center">
          <Link href={link({ cursor: nextCursor })} className="inline-flex h-11 items-center rounded-xl border border-border px-5 text-sm font-medium hover:bg-surface-2">
            Load more
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function Pills<T extends string>({ items, active, hrefFor }: { items: readonly { key: T; label: string }[]; active: string; hrefFor: (k: T) => string }) {
  return (
    <div className="inline-flex rounded-xl border border-border bg-surface-2 p-1">
      {items.map((i) => (
        <Link key={i.key} href={hrefFor(i.key)} className={cn("rounded-lg px-3 py-1.5 text-sm font-medium", active === i.key ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg")}>
          {i.label}
        </Link>
      ))}
    </div>
  );
}
