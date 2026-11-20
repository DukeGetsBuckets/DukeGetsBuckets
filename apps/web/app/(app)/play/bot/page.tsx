import type { Metadata } from "next";
import { requireSession } from "@/lib/session";
import { getActiveGameForUser } from "@/lib/queries/games";
import { BotGame } from "@/components/bot/BotGame";

export const metadata: Metadata = { title: "Play the bot" };

export default async function BotPage() {
  const session = await requireSession("/play/bot");
  // Engine help is never available while the player has a live game (same rule as the analysis board).
  const active = await getActiveGameForUser(session.id);
  return <BotGame activeGameId={active?.id ?? null} />;
}
