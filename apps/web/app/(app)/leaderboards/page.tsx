import type { Metadata } from "next";
import Link from "next/link";
import { LEADERBOARD_RULES, TIME_CONTROLS, type RatingCategory } from "@tempo/shared";
import { Avatar } from "@/components/ui/Avatar";
import { Card, CardBody } from "@/components/ui/Card";
import { getSession } from "@/lib/session";
import { getLeaderboard, getRank } from "@/lib/queries/leaderboard";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Leaderboards" };

export default async function LeaderboardsPage({ searchParams }: { searchParams: Promise<{ category?: string; scope?: string; q?: string }> }) {
  const params = await searchParams;
  const session = await getSession();
  const category: RatingCategory = params.category === "BULLET" || params.category === "RAPID" ? params.category : "BLITZ";
  const scope = params.scope === "friends" && session ? "friends" : "global";
  const search = (params.q ?? "").trim().slice(0, 20);
  const [rows, myRank] = await Promise.all([
    getLeaderboard(category, { friendsOf: scope === "friends" ? session!.id : undefined, search: search || undefined }),
    session ? getRank(session.id, category) : Promise.resolve(null),
  ]);
  const href = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ category, scope, q: search, ...patch })) if (v && v !== "global") q.set(k, v);
    const s = q.toString();
    return `/leaderboards${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Leaderboards</h1>
        <p className="text-sm text-fg-muted">Top rated players. Qualify by playing at least {LEADERBOARD_RULES.minGames} rated games in a time control.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-xl border border-border bg-surface-2 p-1">
          {(["BULLET", "BLITZ", "RAPID"] as RatingCategory[]).map((c) => (
            <Link key={c} href={href({ category: c })} className={cn("rounded-lg px-3 py-1.5 text-sm font-medium", category === c ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg")}>
              {TIME_CONTROLS[c].name}
            </Link>
          ))}
        </div>
        {session ? (
          <div className="inline-flex rounded-xl border border-border bg-surface-2 p-1">
            <Link href={href({ scope: "global" })} className={cn("rounded-lg px-3 py-1.5 text-sm font-medium", scope === "global" ? "bg-surface text-fg shadow-sm" : "text-fg-muted")}>
              Global
            </Link>
            <Link href={href({ scope: "friends" })} className={cn("rounded-lg px-3 py-1.5 text-sm font-medium", scope === "friends" ? "bg-surface text-fg shadow-sm" : "text-fg-muted")}>
              Friends
            </Link>
          </div>
        ) : null}
        <form className="ml-auto" action="/leaderboards" method="get">
          <input type="hidden" name="category" value={category} />
          {scope === "friends" ? <input type="hidden" name="scope" value="friends" /> : null}
          <input name="q" defaultValue={search} placeholder="Find a player" className="h-10 rounded-xl border border-border bg-surface px-3 text-sm outline-none focus:border-accent" />
        </form>
      </div>
      {session && myRank ? (
        <p className="text-sm text-fg-muted">
          Your {TIME_CONTROLS[category].name} rank: <span className="font-semibold text-fg">#{myRank}</span>
        </p>
      ) : session ? (
        <p className="text-sm text-fg-muted">Play {LEADERBOARD_RULES.minGames} rated {TIME_CONTROLS[category].name} games to appear on this board.</p>
      ) : null}
      <Card>
        <CardBody className="px-0 py-0">
          {rows.length ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-fg-faint">
                <tr className="border-b border-border">
                  <th className="px-4 py-3">Rank</th>
                  <th className="px-2 py-3">Player</th>
                  <th className="px-2 py-3 text-right">Rating</th>
                  <th className="px-4 py-3 text-right">Games</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.userId} className={cn("border-b border-border last:border-0", session?.id === r.userId && "bg-accent-soft")}>
                    <td className="px-4 py-2.5 font-semibold text-fg-muted">{r.rank}</td>
                    <td className="px-2 py-2.5">
                      <Link href={`/profile/${r.username}`} className="flex items-center gap-2.5 hover:underline">
                        <Avatar name={r.username} src={r.image} size={28} />
                        <span className="font-medium">{r.username}</span>
                      </Link>
                    </td>
                    <td className="px-2 py-2.5 text-right font-semibold tabular-nums">
                      {r.rating}
                      {r.provisional ? <span className="text-fg-faint">?</span> : null}
                    </td>
                    <td className="px-4 py-2.5 text-right text-fg-muted tabular-nums">{r.gamesPlayed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="px-4 py-10 text-center text-sm text-fg-muted">{search ? `No qualified players named “${search}”.` : "Nobody has qualified yet — be the first."}</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
