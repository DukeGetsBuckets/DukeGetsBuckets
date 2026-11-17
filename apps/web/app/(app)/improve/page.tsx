import type { Metadata } from "next";
import Link from "next/link";
import { Brain, Target, TrendingUp, Trophy } from "lucide-react";
import { TIME_CONTROLS } from "@tempo/shared";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { AccuracyTrend } from "@/components/improve/AccuracyTrend";
import { requireSession } from "@/lib/session";
import { getImproveData } from "@/lib/queries/improve";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Improve" };

export default async function ImprovePage() {
  const session = await requireSession("/improve");
  const data = await getImproveData(session.id);
  const enough = data.analyzedGames >= 3;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Your chess improvement</h1>
        <p className="text-sm text-fg-muted">Everything here is computed from your own analysed games. {data.analyzedGames < 3 ? "Review a few games to unlock personalised insights." : ""}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={<Trophy className="h-5 w-5" />} label="Blitz rating" value={String(data.ratings.find((r) => r.category === "BLITZ")?.rating ?? "—")} sub={deltaLabel(data.ratings.find((r) => r.category === "BLITZ")?.delta30d)} />
        <Stat icon={<Target className="h-5 w-5" />} label="Recent average accuracy" value={data.recentAverageAccuracy != null ? `${data.recentAverageAccuracy}%` : "—"} sub={data.analyzedGames ? `${data.analyzedGames} analysed game${data.analyzedGames === 1 ? "" : "s"}` : "No analysed games yet"} />
        <Stat icon={<Brain className="h-5 w-5" />} label="Most common weakness" value={enough ? (data.weakestArea ?? "None found") : "Not enough data"} sub={enough && data.mistakeThemes[0] ? `${data.mistakeThemes[0].count} occurrences` : "Needs 3+ reviewed games"} />
        <Stat icon={<TrendingUp className="h-5 w-5" />} label="Strongest area" value={enough ? (data.strongestArea ?? "—") : "Not enough data"} sub={enough ? `Current focus: ${data.weakestArea ?? "keep playing"}` : "Needs 3+ reviewed games"} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Accuracy trend" subtitle="Per analysed game, most recent on the right." />
          <CardBody>
            {data.accuracyTrend.length ? <AccuracyTrend points={data.accuracyTrend} /> : <p className="py-8 text-center text-sm text-fg-muted">Run Game Review on your games to see your accuracy over time.</p>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Practice your mistakes" action={<Link href="/improve/mistakes" className="text-sm font-medium text-accent hover:underline">Open</Link>} />
          <CardBody>
            {data.training.total ? (
              <>
                <p className="text-3xl font-bold tracking-tight">{data.training.pending}</p>
                <p className="text-sm text-fg-muted">positions waiting · {data.training.solved} solved ({data.training.solvedLast7Days} this week)</p>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-3">
                  <div className="h-full bg-success" style={{ width: `${Math.round((data.training.solved / Math.max(1, data.training.total)) * 100)}%` }} />
                </div>
                <Link href="/improve/mistakes" className="mt-4 inline-flex h-10 w-full items-center justify-center rounded-xl bg-accent text-sm font-semibold text-accent-fg hover:bg-accent-strong">
                  Start training
                </Link>
              </>
            ) : (
              <p className="text-sm text-fg-muted">No training positions yet. They are created automatically when Game Review finds a mistake or blunder in your games.</p>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Mistake types" subtitle="From the coaching reports of your analysed games." />
          <CardBody>
            {data.mistakeThemes.length ? (
              <ul className="space-y-2">
                {data.mistakeThemes.slice(0, 8).map((t) => {
                  const max = data.mistakeThemes[0]!.count;
                  return (
                    <li key={t.theme} className="text-sm">
                      <div className="flex justify-between">
                        <span>{t.label}</span>
                        <span className="text-fg-muted">{t.count}</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
                        <div className="h-full bg-danger/80" style={{ width: `${(t.count / max) * 100}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-fg-muted">No recurring mistakes identified yet.</p>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Your openings" subtitle="Win rates by opening family, from your games." />
          <CardBody className="px-0">
            {data.openings.length ? (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-fg-faint">
                  <tr>
                    <th className="px-5 py-1">Opening</th>
                    <th className="px-2 py-1 text-right">Games</th>
                    <th className="px-2 py-1 text-right">W / D / L</th>
                    <th className="px-5 py-1 text-right">Win %</th>
                  </tr>
                </thead>
                <tbody>
                  {data.openings.map((o) => (
                    <tr key={o.family} className="border-t border-border/60">
                      <td className="px-5 py-1.5">
                        <span className="font-medium">{o.family}</span>
                        <span className="block text-xs text-fg-faint">
                          {o.asWhite} as white · {o.asBlack} as black{o.avgAccuracy != null ? ` · ${o.avgAccuracy}% acc` : ""}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{o.games}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-fg-muted">
                        {o.wins}/{o.draws}/{o.losses}
                      </td>
                      <td className={cn("px-5 py-1.5 text-right font-semibold tabular-nums", o.wins / o.games >= 0.5 ? "text-success" : "text-danger")}>{Math.round((o.wins / o.games) * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="px-5 py-6 text-sm text-fg-muted">Play some games to see your opening repertoire.</p>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Rating development (last 30 days)" />
        <CardBody className="grid gap-3 sm:grid-cols-3">
          {data.ratings.map((r) => (
            <div key={r.category} className="rounded-xl bg-surface-2 p-3">
              <p className="text-xs uppercase tracking-wide text-fg-faint">{TIME_CONTROLS[r.category].name}</p>
              <p className="text-2xl font-bold">{r.rating}</p>
              <p className={cn("text-sm", r.delta30d == null ? "text-fg-faint" : r.delta30d >= 0 ? "text-success" : "text-danger")}>{deltaLabel(r.delta30d)}</p>
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}

function deltaLabel(d: number | null | undefined): string {
  if (d == null) return "No rated games in the last 30 days";
  return `${d >= 0 ? "+" : ""}${d} in the last 30 days`;
}

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 text-sm text-fg-muted">
        <span className="text-accent">{icon}</span> {label}
      </div>
      <p className="mt-1 truncate text-2xl font-bold tracking-tight">{value}</p>
      {sub ? <p className="truncate text-xs text-fg-faint">{sub}</p> : null}
    </div>
  );
}
