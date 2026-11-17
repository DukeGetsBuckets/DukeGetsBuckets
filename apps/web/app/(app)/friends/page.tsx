import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { FriendsScreen } from "@/components/friends/FriendsScreen";

export const metadata: Metadata = { title: "Friends" };

export default async function FriendsPage() {
  const session = await requireSession("/friends");
  const [incoming, outgoing] = await Promise.all([
    prisma.friendRequest.findMany({ where: { receiverId: session.id, status: "PENDING" }, include: { sender: { select: { id: true, username: true, image: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.friendRequest.findMany({ where: { senderId: session.id, status: "PENDING" }, include: { receiver: { select: { id: true, username: true, image: true } } }, orderBy: { createdAt: "desc" } }),
  ]);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Friends</h1>
        <p className="text-sm text-fg-muted">Quick-add players, see who's online and challenge them to a game.</p>
      </div>
      <FriendsScreen
        meId={session.id}
        initialIncoming={incoming.map((r) => ({ id: r.id, user: { id: r.sender.id, username: r.sender.username ?? "player", image: r.sender.image }, createdAt: r.createdAt.toISOString() }))}
        initialOutgoing={outgoing.map((r) => ({ id: r.id, user: { id: r.receiver.id, username: r.receiver.username ?? "player", image: r.receiver.image }, createdAt: r.createdAt.toISOString() }))}
      />
    </div>
  );
}
