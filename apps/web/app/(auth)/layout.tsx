import Link from "next/link";
import { APP_NAME, APP_TAGLINE } from "@tempo/shared";
import { Logo } from "@/components/layout/AppShell";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <Link href="/" className="mb-8 flex items-center gap-3">
        <Logo size={40} />
        <span>
          <span className="block text-2xl font-bold tracking-tight">{APP_NAME}</span>
          <span className="block text-sm text-fg-muted">{APP_TAGLINE}</span>
        </span>
      </Link>
      <div className="card w-full max-w-md bg-bg-elevated p-6 shadow-card sm:p-8">{children}</div>
    </div>
  );
}
