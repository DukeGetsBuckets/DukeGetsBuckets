import { AppShell } from "@/components/layout/AppShell";
import { getSession } from "@/lib/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  return <AppShell user={session ? { id: session.id, username: session.username, image: session.image } : null}>{children}</AppShell>;
}
