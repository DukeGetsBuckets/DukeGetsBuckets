import Link from "next/link";
import { ArrowRight, Swords, Users, Zap } from "lucide-react";
import { APP_NAME, APP_TAGLINE, TIME_CONTROLS } from "@tempo/shared";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { GameRow } from "@/components/play/GameRow";
import { OnlineFriends } from "@/components/play/OnlineFriends";
import { getSession } from "@/lib/session";
import { getRatings } from "@/lib/queries/ratings";
import { getActiveGameForUser, listGamesForUser } from "@/lib/queries/games";

export default async function HomePage() {
  const session = await getSession();
  if (!session) return <Landing />;
  const [ratings, recent, active] = await Promise.all([getRatings(session.id), listGamesForUser(session.id, {}, undefined, 6), getActiveGameForUser(session.id)]);

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Hi, {session.username}</h1>
          <p className="text-sm text-fg-muted">Ready for a game?</p>
        </div>
        {active ? (
          <Link href={`/game/${active.id}`} className="inline-flex h-11 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-fg">
            Return to your game <ArrowRight className="h-4 w-4" />
          </Link>
        ) : null}
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        {ratings.map((r) => {
          const tc = TIME_CONTROLS[r.category];
          return (
            <Link key={r.category} href={`/play?mode=${r.category.toLowerCase()}`} className="card group flex items-center justify-between p-4 transition hover:border-accent/60">
              <span>
                <span className="flex items-center gap-2 text-sm text-fg-muted">
                  <Zap className="h-4 w-4 text-accent" /> {tc.name} <span className="text-fg-faint">{tc.label}</span>
                </span>
                <span className="mt-1 flex items-baseline gap-1.5">
                  <span className="text-3xl font-bold tracking-tight">{r.rating}</span>
                  {r.provisional ? <span className="text-fg-faint" title="Provisional rating">?</span> : null}
                </span>
                <span className="text-xs text-fg-faint">
                  {r.gamesPlayed} games · {r.wins}W {r.losses}L {r.draws}D
                </span>
              </span>
              <span className="rounded-xl bg-accent-soft px-3 py-2 text-sm font-semibold text-accent group-hover:bg-accent group-hover:text-accent-fg">Play</span>
            </Link>
          );
        })}
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Recent games" action={<Link href="/history" className="text-sm font-medium text-accent hover:underline">All games</Link>} />
          <CardBody className="px-2">
            {recent.items.length ? (
              <div className="divide-y divide-border">
                {recent.items.map((g) => (
                  <GameRow key={g.id} game={g} viewerId={session.id} />
                ))}
              </div>
            ) : (
              <p className="px-3 py-8 text-center text-sm text-fg-muted">No games yet. Your first one is a click away.</p>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Friends" action={<Link href="/friends" className="text-sm font-medium text-accent hover:underline">Manage</Link>} />
          <CardBody>
            <OnlineFriends />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function Landing() {
  return (
    <div className="mx-auto max-w-3xl py-8 text-center sm:py-16">
      <Badge tone="accent" className="mb-4">Original · Open source · Stockfish-powered review</Badge>
      <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{APP_NAME}</h1>
      <p className="mx-auto mt-3 max-w-xl text-lg text-fg-muted">{APP_TAGLINE} Play rated bullet, blitz and rapid against real people, challenge friends and get engine-grounded coaching after every game.</p>
      <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
        <Link href="/register" className="inline-flex h-12 items-center justify-center rounded-xl bg-accent px-6 text-base font-semibold text-accent-fg hover:bg-accent-strong">
          Create a free account
        </Link>
        <Link href="/login" className="inline-flex h-12 items-center justify-center rounded-xl border border-border-strong px-6 text-base font-medium hover:bg-surface-2">
          Log in
        </Link>
      </div>
      <div className="mt-12 grid gap-4 text-left sm:grid-cols-3">
        {[
          { icon: Swords, title: "Real opponents, fair pairing", text: "Glicko-2 ratings per time control and an adaptive matchmaking window." },
          { icon: Users, title: "Friends & challenges", text: "Quick-add friends, send a challenge or share a link. Rematch in one tap." },
          { icon: Zap, title: "Built for iPad", text: "Tap or drag, premove, draw arrows and keep the whole board on screen in any orientation." },
        ].map((f) => (
          <div key={f.title} className="card p-5">
            <f.icon className="h-6 w-6 text-accent" />
            <h3 className="mt-3 font-semibold">{f.title}</h3>
            <p className="mt-1 text-sm text-fg-muted">{f.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
