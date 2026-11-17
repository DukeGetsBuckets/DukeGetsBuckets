import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const rows = await prisma.notification.findMany({ where: { userId: session.id }, orderBy: { createdAt: "desc" }, take: 50 });
  return NextResponse.json(
    rows.map((n) => ({ id: n.id, type: n.type, payload: n.payload, resourceId: n.resourceId, readAt: n.readAt?.toISOString() ?? null, createdAt: n.createdAt.toISOString() })),
  );
}
