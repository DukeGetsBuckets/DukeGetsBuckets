import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { SettingsScreen } from "@/components/settings/SettingsScreen";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const session = await requireSession("/settings");
  const user = await prisma.user.findUniqueOrThrow({ where: { id: session.id }, select: { username: true, bio: true, country: true, profileVisibility: true, image: true, emailVerified: true, email: true } });
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-fg-muted">Board, gameplay, appearance and account preferences. Saved to your account.</p>
      </div>
      <SettingsScreen profile={{ username: user.username ?? "", bio: user.bio, country: user.country, profileVisibility: user.profileVisibility, image: user.image, emailVerified: user.emailVerified }} email={user.email} />
    </div>
  );
}
