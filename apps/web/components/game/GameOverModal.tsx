"use client";

import Link from "next/link";
import { TIME_CONTROLS, type GameEndReason, type GameResult, type PlayerColor, type RatingCategory } from "@tempo/shared";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { endReasonLabel } from "@/components/play/GameRow";

export function GameOverModal({
  open,
  onClose,
  gameId,
  result,
  reason,
  yourColor,
  category,
  rated,
  ratingBefore,
  ratingAfter,
  rematch,
  onRematch,
  onRespondRematch,
  rematchBusy,
}: {
  open: boolean;
  onClose: () => void;
  gameId: string;
  result: GameResult | null;
  reason: GameEndReason | null;
  yourColor: PlayerColor | null;
  category: RatingCategory;
  rated: boolean;
  ratingBefore: number | null;
  ratingAfter: number | null;
  rematch: { offeredBy: PlayerColor | null; gameId: string | null };
  onRematch: () => void;
  onRespondRematch: (accept: boolean) => void;
  rematchBusy: boolean;
}) {
  const aborted = reason === "ABORTED";
  let headline = "Draw";
  let tone = "text-fg";
  if (aborted) headline = "Game aborted";
  else if (result && result !== "DRAW" && yourColor) {
    const won = (result === "WHITE_WINS") === (yourColor === "white");
    headline = won ? "Victory" : "Defeat";
    tone = won ? "text-success" : "text-danger";
  } else if (result && result !== "DRAW") {
    headline = result === "WHITE_WINS" ? "White wins" : "Black wins";
  }
  const delta = ratingBefore != null && ratingAfter != null ? Math.round(ratingAfter) - Math.round(ratingBefore) : null;
  const incomingRematch = rematch.offeredBy && rematch.offeredBy !== yourColor && !rematch.gameId;
  const outgoingRematch = rematch.offeredBy && rematch.offeredBy === yourColor && !rematch.gameId;

  return (
    <Modal open={open} onClose={onClose} className="text-center">
      <p className={`text-3xl font-bold tracking-tight ${tone}`}>{headline}</p>
      <p className="mt-1 text-fg-muted">{aborted ? "Nobody made their first move in time — nothing was rated." : `by ${endReasonLabel(reason).toLowerCase()}`}</p>
      {rated && !aborted && yourColor && ratingBefore != null && ratingAfter != null ? (
        <div className="mt-4 rounded-xl bg-surface-2 p-3">
          <p className="text-xs uppercase tracking-wide text-fg-faint">{TIME_CONTROLS[category].name} rating</p>
          <p className="mt-1 text-lg font-semibold">
            {Math.round(ratingBefore)} → {Math.round(ratingAfter)}
          </p>
          {delta != null ? <p className={`text-sm font-semibold ${delta >= 0 ? "text-success" : "text-danger"}`}>{delta >= 0 ? "+" : ""}{delta} rating</p> : null}
        </div>
      ) : rated && !aborted && yourColor ? (
        <p className="mt-3 text-sm text-fg-muted">Rating update pending…</p>
      ) : null}

      {yourColor ? (
        <div className="mt-5 space-y-2">
          {incomingRematch ? (
            <div className="flex gap-2">
              <Button fullWidth onClick={() => onRespondRematch(true)} loading={rematchBusy}>
                Accept rematch
              </Button>
              <Button fullWidth variant="secondary" onClick={() => onRespondRematch(false)}>
                Decline
              </Button>
            </div>
          ) : (
            <Button fullWidth size="lg" variant="secondary" onClick={onRematch} loading={rematchBusy} disabled={Boolean(outgoingRematch)}>
              {outgoingRematch ? "Rematch offered…" : "Rematch"}
            </Button>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Link href={`/review/${gameId}`} className="flex h-11 items-center justify-center rounded-xl bg-accent text-sm font-semibold text-accent-fg hover:bg-accent-strong">
              Game Review
            </Link>
            <Link href="/play" className="flex h-11 items-center justify-center rounded-xl border border-border text-sm font-medium hover:bg-surface-2">
              New game
            </Link>
          </div>
          <Link href="/" className="block py-1 text-sm text-fg-muted hover:text-fg">
            Back to home
          </Link>
        </div>
      ) : (
        <div className="mt-5 grid grid-cols-2 gap-2">
          <Link href={`/review/${gameId}`} className="flex h-11 items-center justify-center rounded-xl bg-accent text-sm font-semibold text-accent-fg">
            Game Review
          </Link>
          <Link href="/" className="flex h-11 items-center justify-center rounded-xl border border-border text-sm font-medium">
            Home
          </Link>
        </div>
      )}
    </Modal>
  );
}
