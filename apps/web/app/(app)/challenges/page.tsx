import type { Metadata } from "next";
import { requireSession } from "@/lib/session";
import { listChallenges } from "@/lib/queries/challenges";
import { ChallengesScreen } from "@/components/friends/ChallengesScreen";

export const metadata: Metadata = { title: "Challenges" };

export default async function ChallengesPage() {
  const session = await requireSession("/challenges");
  const { incoming, outgoing } = await listChallenges(session.id);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Challenges</h1>
        <p className="text-sm text-fg-muted">Accept an invitation to start a game immediately.</p>
      </div>
      <ChallengesScreen initialIncoming={incoming} initialOutgoing={outgoing} meId={session.id} />
    </div>
  );
}
