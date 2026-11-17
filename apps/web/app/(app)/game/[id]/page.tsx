import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { LiveGame } from "@/components/game/LiveGame";

export const metadata: Metadata = { title: "Live game" };

export default async function GamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [session, game] = await Promise.all([getSession(), prisma.game.findUnique({ where: { id }, select: { id: true } })]);
  if (!game) notFound();
  return <LiveGame gameId={id} meId={session?.id ?? null} />;
}
