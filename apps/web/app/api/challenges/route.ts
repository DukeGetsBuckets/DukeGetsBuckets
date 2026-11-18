import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { listChallenges } from "@/lib/queries/challenges";

export const dynamic = "force-dynamic";

/** Pending challenges for the signed-in user; the Challenges page re-reads this on every socket connect. */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  return NextResponse.json(await listChallenges(session.id), { headers: { "Cache-Control": "no-store" } });
}
