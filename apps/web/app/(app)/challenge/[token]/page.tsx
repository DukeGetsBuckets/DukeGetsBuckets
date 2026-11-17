import type { Metadata } from "next";
import { TIME_CONTROLS } from "@tempo/shared";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { Avatar } from "@/components/ui/Avatar";
import { AcceptLinkChallenge } from "./AcceptLinkChallenge";

export const metadata: Metadata = { title: "Challenge invitation" };

export default async function ChallengeLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await requireSession(`/challenge/${token}`);
  const challenge = await prisma.challenge.findUnique({ where: { token }, include: { sender: { select: { id: true, username: true, image: true } } } });
  if (!challenge) {
    return <div className="card mx-auto max-w-md p-8 text-center text-fg-muted">This invitation link is not valid.</div>;
  }
  const expired = challenge.status === "EXPIRED" || (challenge.status === "PENDING" && challenge.expiresAt < new Date());
  const tc = TIME_CONTROLS[challenge.category];
  return (
    <div className="card mx-auto max-w-md p-8 text-center">
      <Avatar name={challenge.sender.username ?? "?"} src={challenge.sender.image} size={64} className="mx-auto" />
      <h1 className="mt-4 text-xl font-semibold">{challenge.sender.username} invites you to play</h1>
      <p className="mt-1 text-fg-muted">
        {tc.name} {tc.label} · {challenge.rated ? "Rated" : "Casual"}
      </p>
      {challenge.senderId === session.id ? (
        <p className="mt-4 text-sm text-fg-muted">This is your own invitation — share the link with someone else.</p>
      ) : challenge.status !== "PENDING" || expired ? (
        <p className="mt-4 text-sm text-danger">This invitation is {expired ? "expired" : challenge.status.toLowerCase()}.</p>
      ) : (
        <AcceptLinkChallenge token={token} />
      )}
    </div>
  );
}
