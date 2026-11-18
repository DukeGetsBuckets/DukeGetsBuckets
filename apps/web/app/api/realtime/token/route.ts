import { SignJWT } from "jose";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Mints a short-lived HS256 token that authenticates the logged-in user to the realtime service.
 * The realtime tier never sees the auth cookie; it only verifies this signed token.
 */
export async function GET(): Promise<NextResponse> {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const secret = process.env.REALTIME_JWT_SECRET;
  if (!secret) return NextResponse.json({ error: "REALTIME_JWT_SECRET not configured" }, { status: 500 });
  const expiresAt = Date.now() + 60 * 60 * 1000;
  const token = await new SignJWT({ username: session.username })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.id)
    .setAudience("tempo-realtime")
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .sign(new TextEncoder().encode(secret));
  return NextResponse.json({ token, expiresAt, realtimeUrl: process.env.REALTIME_PUBLIC_URL ?? process.env.NEXT_PUBLIC_REALTIME_URL ?? "http://localhost:4000" }, { headers: { "Cache-Control": "no-store" } });
}
