import type { Metadata } from "next";
import { getSession } from "@/lib/session";
import { AnalysisBoard } from "@/components/analysis/AnalysisBoard";

export const metadata: Metadata = { title: "Analysis board" };

export default async function AnalysisPage({ searchParams }: { searchParams: Promise<{ fen?: string }> }) {
  const [session, params] = await Promise.all([getSession(), searchParams]);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analysis board</h1>
        <p className="text-sm text-fg-muted">Set up any position, import a PGN, and ask Stockfish for its opinion. Engine evaluation is unavailable while you have a game in progress.</p>
      </div>
      <AnalysisBoard authenticated={Boolean(session)} initialFen={params.fen ?? null} />
    </div>
  );
}
