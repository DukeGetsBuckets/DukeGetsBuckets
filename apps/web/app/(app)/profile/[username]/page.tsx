import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarDays, Clock3, Trophy } from "lucide-react";
import { RATING_DEFAULTS, TIME_CONTROLS } from "@tempo/shared";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { GameRow } from "@/components/play/GameRow";
import { RatingChart } from "@/components/charts/RatingChart";
import { ProfileActions } from "@/components/profile/ProfileActions";
import { getSession } from "@/lib/session";
import { getProfileByUsername, getProfileStats, getRatingHistory, getRelation, ratingSummaryFromRows } from "@/lib/queries/profile";
import { listGamesForUser } from "@/lib/queries/games";

export async function generateMetadata({ params }: { params: Promise<{ username: string }> }): Promise<Metadata> {
  const { username } = await params;
  return { title: username };
}

export default async function ProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const [session, user] = await Promise.all([getSession(), getProfileByUsername(username)]);
  if (!user || user.banned) notFound();
  const relation = await getRelation(session?.id ?? null, user.id);
  const visible = user.profileVisibility === "PUBLIC" || relation === "self" || (user.profileVisibility === "FRIENDS" && relation === "friend");
  const ratings = ratingSummaryFromRows(user.ratings);
  const [stats, history, recent] = visible ? await Promise.all([getProfileStats(user.id), getRatingHistory(user.id), listGamesForUser(user.id, {}, undefined, 10)]) : [null, [], { items: [] }];
  const online = user.lastSeenAt ? Date.now() - user.lastSeenAt.getTime() < 2 * 60_000 : false;

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <Avatar name={user.username ?? "?"} src={user.image} size={72} status={visible ? (online ? "online" : "offline") : null} />
          <div className="min-w-0 flex-1">
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold tracking-tight">
              {user.username}
              {relation === "self" ? <Badge>You</Badge> : null}
              {relation === "friend" ? <Badge tone="success">Friend</Badge> : null}
            </h1>
            {user.bio ? <p className="mt-1 text-sm text-fg-muted">{user.bio}</p> : null}
            <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-faint">
              <span className="inline-flex items-center gap-1">
                <CalendarDays className="h-3.5 w-3.5" /> Joined {user.createdAt.toLocaleDateString(undefined, { month: "short", year: "numeric" })}
              </span>
              {user.country ? <span>{user.country}</span> : null}
              {visible && user.lastSeenAt ? <span>{online ? "Online now" : `Last seen ${user.lastSeenAt.toLocaleDateString()}`}</span> : null}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:items-end">
            {relation === "self" ? (
              <Link href="/settings" className="inline-flex h-11 items-center rounded-xl border border-border px-4 text-sm font-medium hover:bg-surface-2">
                Edit profile
              </Link>
            ) : null}
            <ProfileActions target={{ id: user.id, username: user.username ?? "" }} initialRelation={relation} authenticated={Boolean(session)} />
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-3 sm:grid-cols-3">
        {ratings.map((r) => (
          <Card key={r.category} className="p-4">
            <p className="text-sm text-fg-muted">
              {TIME_CONTROLS[r.category].name} <span className="text-fg-faint">{TIME_CONTROLS[r.category].label}</span>
            </p>
            <p className="mt-1 text-3xl font-bold tracking-tight">
              {r.rating}
              {r.provisional ? <span className="ml-1 text-base text-fg-faint" title="Provisional">?</span> : null}
            </p>
            <p className="text-xs text-fg-faint">
              {r.gamesPlayed} games · {r.wins}W {r.losses}L {r.draws}D · peak {r.peakRating}
            </p>
          </Card>
        ))}
      </div>

      {!visible ? (
        <Card>
          <CardBody className="py-10 text-center text-fg-muted">This profile is private.</CardBody>
        </Card>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title="Rating progression" />
              <CardBody>
                <RatingChart points={history} startRating={RATING_DEFAULTS.startRating} />
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Statistics" />
              <CardBody>
                {stats && stats.totalGames > 0 ? (
                  <dl className="space-y-2 text-sm">
                    <Stat label="Games" value={String(stats.totalGames)} icon={<Trophy className="h-4 w-4" />} />
                    <Stat label="Record" value={`${stats.wins}W · ${stats.losses}L · ${stats.draws}D`} />
                    <Stat label="Win rate" value={stats.winRate != null ? `${stats.winRate}%` : "—"} />
                    <Stat label="Average accuracy" value={stats.averageAccuracy != null ? `${stats.averageAccuracy}% (${stats.analyzedGames} analyzed)` : "No analyzed games yet"} />
                    <Stat label="Average game length" value={stats.averageDurationSec != null ? `${Math.floor(stats.averageDurationSec / 60)}m ${stats.averageDurationSec % 60}s` : "—"} icon={<Clock3 className="h-4 w-4" />} />
                    <Stat label="Most played" value={stats.mostPlayed ? TIME_CONTROLS[stats.mostPlayed].name : "—"} />
                  </dl>
                ) : (
                  <p className="text-sm text-fg-muted">No completed games yet.</p>
                )}
              </CardBody>
            </Card>
          </div>
          <Card>
            <CardHeader title="Recent games" action={relation === "self" ? <Link href="/history" className="text-sm font-medium text-accent hover:underline">All games</Link> : null} />
            <CardBody className="px-2">
              {recent.items.length ? (
                <div className="divide-y divide-border">
                  {recent.items.map((g) => (
                    <GameRow key={g.id} game={g} viewerId={user.id} />
                  ))}
                </div>
              ) : (
                <p className="px-3 py-6 text-center text-sm text-fg-muted">No games played yet.</p>
              )}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="flex items-center gap-1.5 text-fg-muted">
        {icon}
        {label}
      </dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}
