import type { Metadata } from "next";
import { requireSession } from "@/lib/session";
import { getRatings } from "@/lib/queries/ratings";
import { getActiveGameForUser } from "@/lib/queries/games";
import { PlayScreen } from "@/components/play/PlayScreen";

export const metadata: Metadata = { title: "Play" };

export default async function PlayPage({ searchParams }: { searchParams: Promise<{ mode?: string; quick?: string }> }) {
  const session = await requireSession("/play");
  const params = await searchParams;
  const [ratings, active] = await Promise.all([getRatings(session.id), getActiveGameForUser(session.id)]);
  const mode = (params.mode ?? "").toUpperCase();
  const initialMode = mode === "BULLET" || mode === "BLITZ" || mode === "RAPID" ? mode : null;
  return <PlayScreen ratings={ratings} activeGameId={active?.id ?? null} initialMode={initialMode} autoQuick={params.quick === "1"} />;
}
