"use client";

import * as React from "react";
import { TIME_CONTROLS, type RatingCategory } from "@tempo/shared";
import { emitWithAck } from "@/lib/socket";
import { useSocket } from "@/components/providers/SocketProvider";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";

export function ChallengeDialog({ open, onClose, recipient }: { open: boolean; onClose: () => void; recipient: { id: string; username: string } | null }) {
  const { socket } = useSocket();
  const { toast } = useToast();
  const [category, setCategory] = React.useState<RatingCategory>("BLITZ");
  const [rated, setRated] = React.useState(true);
  const [color, setColor] = React.useState<"RANDOM" | "WHITE" | "BLACK">("RANDOM");
  const [busy, setBusy] = React.useState(false);

  const send = async () => {
    if (!socket || !recipient) return;
    setBusy(true);
    const r = await emitWithAck(socket, "challenge:create", { recipientId: recipient.id, category, rated, color });
    setBusy(false);
    if (!r.ok) {
      toast({ title: "Could not send challenge", description: r.error.message, tone: "danger" });
      return;
    }
    const note = (r as { note?: string }).note;
    toast({ title: `Challenge sent to ${recipient.username}`, description: note ?? "You'll be taken to the board when they accept.", tone: "success" });
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={recipient ? `Challenge ${recipient.username}` : "Challenge"}>
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-sm font-medium text-fg-muted">Time control</p>
          <div className="grid grid-cols-3 gap-2">
            {(["BULLET", "BLITZ", "RAPID"] as RatingCategory[]).map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={cn("rounded-xl border px-3 py-3 text-center transition", category === c ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2")}
              >
                <span className="block text-lg font-semibold">{TIME_CONTROLS[c].label}</span>
                <span className="block text-xs text-fg-muted">{TIME_CONTROLS[c].name}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented value={rated ? "rated" : "casual"} onChange={(v) => setRated(v === "rated")} options={[{ value: "rated", label: "Rated" }, { value: "casual", label: "Casual" }]} size="sm" />
          <Segmented value={color} onChange={setColor} options={[{ value: "RANDOM", label: "Random" }, { value: "WHITE", label: "White" }, { value: "BLACK", label: "Black" }]} size="sm" />
        </div>
        <Button size="lg" fullWidth onClick={send} loading={busy}>
          Send challenge
        </Button>
      </div>
    </Modal>
  );
}
