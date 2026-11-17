import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { APP_NAME, APP_TAGLINE } from "@tempo/shared";
import { ThemeProvider, type ThemePreference } from "@/components/providers/ThemeProvider";
import { themeInitScript } from "@/lib/theme-script";
import { SettingsProvider } from "@/components/providers/SettingsProvider";
import { SocketProvider } from "@/components/providers/SocketProvider";
import { ToastProvider } from "@/components/ui/Toast";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { toSettingsDTO } from "@/lib/settings";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: APP_TAGLINE,
  applicationName: APP_NAME,
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: APP_NAME },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0f1216" },
    { media: "(prefers-color-scheme: light)", color: "#f4f1ea" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [session, cookieStore] = await Promise.all([getSession(), cookies()]);
  const cookieTheme = cookieStore.get("tempo-theme")?.value as ThemePreference | undefined;
  const settingsRow = session ? await prisma.userSettings.findUnique({ where: { userId: session.id } }) : null;
  const settings = session ? toSettingsDTO(settingsRow as Record<string, unknown> | null) : null;
  const theme: ThemePreference = settings?.theme ?? cookieTheme ?? "system";

  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="antialiased">
        <ToastProvider>
          <ThemeProvider initial={theme}>
            <SettingsProvider initial={settings} authenticated={Boolean(session)}>
              <SocketProvider authenticated={Boolean(session)}>{children}</SocketProvider>
            </SettingsProvider>
          </ThemeProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
