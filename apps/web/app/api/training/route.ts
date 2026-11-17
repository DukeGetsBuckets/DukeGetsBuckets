import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { listTrainingPositions } from "@/lib/queries/analysis";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  return NextResponse.json(await listTrainingPositions(session.id), { headers: { "Cache-Control": "no-store" } });
}
