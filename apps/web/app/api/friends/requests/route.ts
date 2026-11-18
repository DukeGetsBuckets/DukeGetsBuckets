import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Pending friend requests for the signed-in user; the Friends page re-reads this on every socket connect. */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const [incoming, outgoing] = await Promise.all([
    prisma.friendRequest.findMany({ where: { receiverId: session.id, status: "PENDING" }, include: { sender: { select: { id: true, username: true, image: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.friendRequest.findMany({ where: { senderId: session.id, status: "PENDING" }, include: { receiver: { select: { id: true, username: true, image: true } } }, orderBy: { createdAt: "desc" } }),
  ]);
  return NextResponse.json(
    {
      incoming: incoming.map((r) => ({ id: r.id, user: { id: r.sender.id, username: r.sender.username ?? "player", image: r.sender.image }, createdAt: r.createdAt.toISOString() })),
      outgoing: outgoing.map((r) => ({ id: r.id, user: { id: r.receiver.id, username: r.receiver.username ?? "player", image: r.receiver.image }, createdAt: r.createdAt.toISOString() })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
