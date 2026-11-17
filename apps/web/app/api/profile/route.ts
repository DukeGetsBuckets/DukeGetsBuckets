import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";

const schema = z.object({
  bio: z.string().trim().max(280).optional(),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).or(z.literal("")).optional(),
  profileVisibility: z.enum(["PUBLIC", "FRIENDS", "PRIVATE"]).optional(),
  image: z.string().url().max(500).or(z.literal("")).optional(),
});

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "INVALID", issues: parsed.error.issues }, { status: 400 });
  const { bio, country, profileVisibility, image } = parsed.data;
  const user = await prisma.user.update({
    where: { id: session.id },
    data: {
      ...(bio !== undefined ? { bio: bio || null } : {}),
      ...(country !== undefined ? { country: country || null } : {}),
      ...(profileVisibility ? { profileVisibility } : {}),
      ...(image !== undefined ? { image: image || null } : {}),
    },
    select: { bio: true, country: true, profileVisibility: true, image: true },
  });
  return NextResponse.json(user);
}
