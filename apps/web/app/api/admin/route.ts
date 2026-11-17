import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("resolveReport"), reportId: z.string(), status: z.enum(["REVIEWED", "DISMISSED", "ACTIONED"]) }),
  z.object({ action: z.literal("ban"), userId: z.string(), reason: z.string().max(300), days: z.number().int().min(0).max(3650).optional() }),
  z.object({ action: z.literal("unban"), userId: z.string() }),
]);

async function requireModerator() {
  const session = await getSession();
  if (!session) return null;
  const user = await prisma.user.findUnique({ where: { id: session.id }, select: { role: true } });
  return user && (user.role === "MODERATOR" || user.role === "ADMIN") ? session : null;
}

export async function POST(request: Request) {
  const session = await requireModerator();
  if (!session) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "INVALID" }, { status: 400 });
  const data = parsed.data;
  if (data.action === "resolveReport") {
    await prisma.report.update({ where: { id: data.reportId }, data: { status: data.status, resolvedAt: new Date() } });
  } else if (data.action === "ban") {
    await prisma.user.update({ where: { id: data.userId }, data: { banned: true, banReason: data.reason, banExpiresAt: data.days ? new Date(Date.now() + data.days * 86_400_000) : null } });
    await prisma.session.deleteMany({ where: { userId: data.userId } });
  } else if (data.action === "unban") {
    await prisma.user.update({ where: { id: data.userId }, data: { banned: false, banReason: null, banExpiresAt: null } });
  }
  await prisma.auditLog.create({ data: { actorId: session.id, action: `admin.${data.action}`, targetType: "report" in data ? "report" : "user", targetId: "reportId" in data ? data.reportId : data.userId, meta: data } });
  return NextResponse.json({ ok: true });
}
