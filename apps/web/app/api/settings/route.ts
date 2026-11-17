import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { settingsPatchSchema, toSettingsDTO } from "@/lib/settings";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const row = await prisma.userSettings.findUnique({ where: { userId: session.id } });
  return NextResponse.json(toSettingsDTO(row as Record<string, unknown> | null));
}

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const parsed = settingsPatchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "INVALID", issues: parsed.error.issues }, { status: 400 });
  const { autoQueen: _autoQueen, ...data } = parsed.data;
  const row = await prisma.userSettings.upsert({ where: { userId: session.id }, create: { userId: session.id, ...data }, update: data });
  return NextResponse.json(toSettingsDTO(row as unknown as Record<string, unknown>));
}
