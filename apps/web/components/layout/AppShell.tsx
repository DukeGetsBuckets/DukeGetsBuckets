"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, Clock3, History, Home, LogOut, Settings, Swords, Trophy, TrendingUp, Users, type LucideIcon } from "lucide-react";
import { APP_NAME } from "@tempo/shared";
import { cn } from "@/lib/cn";
import { signOut } from "@/lib/auth-client";
import { Avatar } from "@/components/ui/Avatar";
import { useSocket } from "@/components/providers/SocketProvider";
import { NotificationsPanel } from "./NotificationsPanel";

export interface ShellUser {
  id: string;
  username: string;
  image: string | null;
}

const NAV: { href: string; label: string; icon: LucideIcon; auth?: boolean }[] = [
  { href: "/", label: "Home", icon: Home },
  { href: "/play", label: "Play", icon: Swords },
  { href: "/friends", label: "Friends", icon: Users, auth: true },
  { href: "/history", label: "History", icon: History, auth: true },
  { href: "/improve", label: "Improve", icon: TrendingUp, auth: true },
  { href: "/leaderboards", label: "Leaders", icon: Trophy },
  { href: "/settings", label: "Settings", icon: Settings, auth: true },
];

export function AppShell({ user, children, fullBleed }: { user: ShellUser | null; children: React.ReactNode; fullBleed?: boolean }) {
  const pathname = usePathname();
  const { connected, unread } = useSocket();
  const [notifOpen, setNotifOpen] = React.useState(false);
  const inGame = pathname.startsWith("/game/");

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  const nav = NAV.filter((n) => !n.auth || user);

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      {/* Sidebar (iPad landscape / desktop) */}
      <aside className={cn("hidden w-60 shrink-0 flex-col border-r border-border bg-bg-elevated", !inGame && "lg:flex")}>
        <Link href="/" className="flex items-center gap-2.5 px-5 py-5">
          <Logo />
          <span className="text-lg font-bold tracking-tight">{APP_NAME}</span>
        </Link>
        <nav className="flex flex-1 flex-col gap-1 px-3">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition",
                isActive(item.href) ? "bg-accent-soft text-accent" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              <item.icon className="h-5 w-5" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-border p-3">
          {user ? (
            <div className="flex items-center gap-3 rounded-xl px-2 py-2">
              <Link href={`/profile/${user.username}`} className="flex min-w-0 flex-1 items-center gap-3">
                <Avatar name={user.username} src={user.image} size={36} status={connected ? "online" : "offline"} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{user.username}</span>
                  <span className="block text-xs text-fg-faint">{connected ? "Connected" : "Connecting…"}</span>
                </span>
              </Link>
              <button onClick={() => void signOut().then(() => (window.location.href = "/"))} className="rounded-lg p-2 text-fg-muted hover:bg-surface-2 hover:text-fg" aria-label="Log out" title="Log out">
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Link href="/login" className="flex h-10 flex-1 items-center justify-center rounded-xl border border-border text-sm font-medium hover:bg-surface-2">
                Log in
              </Link>
              <Link href="/register" className="flex h-10 flex-1 items-center justify-center rounded-xl bg-accent text-sm font-semibold text-accent-fg hover:bg-accent-strong">
                Sign up
              </Link>
            </div>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className={cn("sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-bg/85 px-3 backdrop-blur sm:px-5", inGame && "lg:hidden")}>
          <Link href="/" className="flex items-center gap-2 lg:hidden">
            <Logo />
            <span className="font-bold tracking-tight">{APP_NAME}</span>
          </Link>
          <div className="hidden text-sm text-fg-muted lg:block">{titleFor(pathname)}</div>
          <div className="flex items-center gap-1.5">
            {user ? (
              <>
                <button onClick={() => setNotifOpen(true)} className="relative rounded-xl p-2.5 text-fg-muted hover:bg-surface-2 hover:text-fg" aria-label="Notifications">
                  <Bell className="h-5 w-5" />
                  {unread > 0 ? <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-fg">{unread > 9 ? "9+" : unread}</span> : null}
                </button>
                <Link href={`/profile/${user.username}`} className="lg:hidden">
                  <Avatar name={user.username} src={user.image} size={32} />
                </Link>
              </>
            ) : (
              <Link href="/login" className="flex h-9 items-center rounded-lg bg-accent px-3 text-sm font-semibold text-accent-fg lg:hidden">
                Log in
              </Link>
            )}
          </div>
        </header>

        <main className={cn("flex-1", fullBleed || inGame ? "" : "mx-auto w-full max-w-6xl px-3 py-4 sm:px-5 sm:py-6", !inGame && "pb-24 lg:pb-6")}>{children}</main>

        {/* Bottom tab bar (phone / iPad portrait) */}
        {!inGame && (
          <nav className="safe-pb fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-bg-elevated/95 backdrop-blur lg:hidden">
            {nav.slice(0, 5).map((item) => (
              <Link key={item.href} href={item.href} className={cn("flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium", isActive(item.href) ? "text-accent" : "text-fg-muted")}>
                <item.icon className="h-5 w-5" />
                {item.label}
              </Link>
            ))}
          </nav>
        )}
      </div>
      {user ? <NotificationsPanel open={notifOpen} onClose={() => setNotifOpen(false)} /> : null}
    </div>
  );
}

function titleFor(pathname: string): string {
  if (pathname === "/") return "Dashboard";
  const seg = pathname.split("/")[1] ?? "";
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span className="inline-flex items-center justify-center rounded-lg bg-accent text-accent-fg" style={{ width: size, height: size }} aria-hidden>
      <Clock3 style={{ width: size * 0.62, height: size * 0.62 }} strokeWidth={2.5} />
    </span>
  );
}
