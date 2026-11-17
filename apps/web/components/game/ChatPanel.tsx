"use client";

import * as React from "react";
import { SendHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ChatLine } from "./useLiveGame";

export function ChatPanel({ lines, onSend, disabled, meId, className }: { lines: ChatLine[]; onSend: (text: string) => void; disabled?: boolean; meId: string | null; className?: string }) {
  const [text, setText] = React.useState("");
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines.length]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  };
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div ref={ref} className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2 text-sm">
        {lines.length === 0 ? <p className="text-xs text-fg-faint">Say hi — be kind. Messages are visible to your opponent only.</p> : null}
        {lines.map((l) =>
          l.system ? (
            <p key={l.id} className="text-center text-xs italic text-fg-faint">
              {l.text}
            </p>
          ) : (
            <p key={l.id} className="break-words">
              <span className={cn("font-semibold", l.userId === meId ? "text-accent" : "text-fg-muted")}>{l.username}: </span>
              {l.text}
            </p>
          ),
        )}
      </div>
      <form onSubmit={submit} className="flex items-center gap-2 border-t border-border p-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={300}
          disabled={disabled}
          placeholder={disabled ? "Chat unavailable" : "Message…"}
          className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-sm outline-none focus:border-accent"
        />
        <button type="submit" disabled={disabled || !text.trim()} className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-accent-fg disabled:opacity-40" aria-label="Send">
          <SendHorizontal className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
