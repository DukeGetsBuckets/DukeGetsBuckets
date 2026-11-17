import type { Metadata } from "next";
import { requireSession } from "@/lib/session";
import { listTrainingPositions } from "@/lib/queries/analysis";
import { PracticeScreen } from "@/components/improve/PracticeScreen";

export const metadata: Metadata = { title: "Practice mistakes" };

export default async function MistakesPage() {
  const session = await requireSession("/improve/mistakes");
  const positions = await listTrainingPositions(session.id);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Practice your mistakes</h1>
        <p className="text-sm text-fg-muted">Real positions from your own games where the engine found a clearly better move. Find it.</p>
      </div>
      <PracticeScreen initial={positions} />
    </div>
  );
}
