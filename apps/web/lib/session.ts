import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";

export interface SessionUser {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  name: string;
}

/** Validated session for the current request (memoized per request). */
export const getSession = cache(async (): Promise<SessionUser | null> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;
  const u = session.user as typeof session.user & { username?: string | null };
  return {
    id: u.id,
    username: u.username ?? u.name,
    email: u.email,
    emailVerified: u.emailVerified,
    image: u.image ?? null,
    name: u.name,
  };
});

export async function requireSession(next?: string): Promise<SessionUser> {
  const session = await getSession();
  if (!session) redirect(`/login${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  return session;
}
