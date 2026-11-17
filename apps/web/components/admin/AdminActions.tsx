"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

export function AdminActions({ reportId, userId, banned }: { reportId?: string; userId: string; banned: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const call = async (body: Record<string, unknown>) => {
    setBusy(true);
    await fetch("/api/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setBusy(false);
    router.refresh();
  };
  return (
    <span className="inline-flex flex-wrap justify-end gap-1">
      {reportId ? (
        <>
          <Button size="sm" variant="ghost" loading={busy} onClick={() => call({ action: "resolveReport", reportId, status: "DISMISSED" })}>
            Dismiss
          </Button>
          <Button size="sm" variant="ghost" loading={busy} onClick={() => call({ action: "resolveReport", reportId, status: "REVIEWED" })}>
            Mark reviewed
          </Button>
        </>
      ) : null}
      {banned ? (
        <Button size="sm" variant="secondary" loading={busy} onClick={() => call({ action: "unban", userId })}>
          Unban
        </Button>
      ) : (
        <Button
          size="sm"
          variant="danger"
          loading={busy}
          onClick={() => {
            const reason = prompt("Ban reason?");
            if (reason == null) return;
            const days = Number(prompt("Days (0 = permanent)?", "7") ?? "0");
            void call({ action: "ban", userId, reason, days: Number.isFinite(days) ? days : 0 });
          }}
        >
          Ban
        </Button>
      )}
    </span>
  );
}
