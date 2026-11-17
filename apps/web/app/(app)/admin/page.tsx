import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { AdminActions } from "@/components/admin/AdminActions";

export const metadata: Metadata = { title: "Moderation" };

export default async function AdminPage() {
  const session = await requireSession("/admin");
  const me = await prisma.user.findUnique({ where: { id: session.id }, select: { role: true } });
  if (!me || (me.role !== "MODERATOR" && me.role !== "ADMIN")) notFound();
  const [reports, flags, banned] = await Promise.all([
    prisma.report.findMany({ where: { status: "OPEN" }, orderBy: { createdAt: "desc" }, take: 50, include: { reporter: { select: { username: true } }, reported: { select: { id: true, username: true, banned: true } } } }),
    prisma.fairPlayFlag.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { user: { select: { id: true, username: true, banned: true } } } }),
    prisma.user.findMany({ where: { banned: true }, select: { id: true, username: true, banReason: true, banExpiresAt: true }, take: 50 }),
  ]);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Moderation</h1>
        <p className="text-sm text-fg-muted">Reports and fair-play signals for human review. Signals are never acted on automatically.</p>
      </div>
      <Card>
        <CardHeader title={`Open reports (${reports.length})`} />
        <CardBody className="px-0">
          {reports.length ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-fg-faint">
                <tr>
                  <th className="px-5 py-1">Reported</th>
                  <th className="px-2 py-1">By</th>
                  <th className="px-2 py-1">Reason</th>
                  <th className="px-2 py-1">Game</th>
                  <th className="px-5 py-1 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id} className="border-t border-border/60 align-top">
                    <td className="px-5 py-2">
                      <Link href={`/profile/${r.reported.username}`} className="font-medium hover:underline">{r.reported.username}</Link>
                      {r.reported.banned ? <span className="ml-1 text-xs text-danger">(banned)</span> : null}
                    </td>
                    <td className="px-2 py-2 text-fg-muted">{r.reporter.username}</td>
                    <td className="px-2 py-2">
                      <span className="font-medium">{r.reason}</span>
                      {r.details ? <p className="text-xs text-fg-muted">{r.details}</p> : null}
                    </td>
                    <td className="px-2 py-2">{r.gameId ? <Link href={`/review/${r.gameId}`} className="text-accent hover:underline">review</Link> : "—"}</td>
                    <td className="px-5 py-2 text-right">
                      <AdminActions reportId={r.id} userId={r.reported.id} banned={r.reported.banned} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="px-5 py-6 text-sm text-fg-muted">No open reports.</p>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={`Fair-play signals (${flags.length})`} subtitle="Statistical signals from analysed games — unusually high engine agreement is not proof of anything on its own." />
        <CardBody className="px-0">
          {flags.length ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-fg-faint">
                <tr>
                  <th className="px-5 py-1">Player</th>
                  <th className="px-2 py-1">Signal</th>
                  <th className="px-2 py-1">Score</th>
                  <th className="px-2 py-1">Game</th>
                  <th className="px-5 py-1 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {flags.map((f) => (
                  <tr key={f.id} className="border-t border-border/60">
                    <td className="px-5 py-2"><Link href={`/profile/${f.user.username}`} className="font-medium hover:underline">{f.user.username}</Link></td>
                    <td className="px-2 py-2">{f.kind} <span className="text-xs text-fg-muted">{JSON.stringify(f.details)}</span></td>
                    <td className="px-2 py-2 tabular-nums">{f.score.toFixed(2)}</td>
                    <td className="px-2 py-2"><Link href={`/review/${f.gameId}`} className="text-accent hover:underline">review</Link></td>
                    <td className="px-5 py-2 text-right"><AdminActions userId={f.user.id} banned={f.user.banned} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="px-5 py-6 text-sm text-fg-muted">No signals recorded.</p>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={`Banned accounts (${banned.length})`} />
        <CardBody className="px-0">
          {banned.map((u) => (
            <div key={u.id} className="flex items-center justify-between border-t border-border/60 px-5 py-2 text-sm first:border-0">
              <span>
                <span className="font-medium">{u.username}</span> <span className="text-fg-muted">— {u.banReason ?? "no reason"} {u.banExpiresAt ? `· until ${u.banExpiresAt.toLocaleDateString()}` : "· permanent"}</span>
              </span>
              <AdminActions userId={u.id} banned />
            </div>
          ))}
          {!banned.length ? <p className="px-5 py-6 text-sm text-fg-muted">Nobody is banned.</p> : null}
        </CardBody>
      </Card>
    </div>
  );
}
