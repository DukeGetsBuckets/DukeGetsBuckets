import Link from "next/link";
import { TIME_CONTROLS, resultForColor } from "@tempo/shared";
import type { GameListItem } from "@/lib/queries/games";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";

export function endReasonLabel(reason: string | null | undefined): string {
  switch (reason) {
    case "CHECKMATE":
      return "Checkmate";
    case "RESIGNATION":
      return "Resignation";
    case "TIMEOUT":
      return "Timeout";
    case "TIMEOUT_VS_INSUFFICIENT_MATERIAL":
      return "Timeout vs insufficient material";
    case "STALEMATE":
      return "Stalemate";
    case "INSUFFICIENT_MATERIAL":
      return "Insufficient material";
    case "THREEFOLD_REPETITION":
      return "Threefold repetition";
    case "FIVEFOLD_REPETITION":
      return "Fivefold repetition";
    case "FIFTY_MOVE_RULE":
      return "50-move rule";
    case "SEVENTY_FIVE_MOVE_RULE":
      return "75-move rule";
    case "AGREEMENT":
      return "Draw agreed";
    case "ABANDONED":
      return "Abandonment";
    case "ABORTED":
      return "Aborted";
    default:
      return "";
  }
}

export function GameRow({ game, viewerId }: { game: GameListItem; viewerId: string }) {
  const myColor = game.whiteId === viewerId ? "white" : "black";
  const opponent = myColor === "white" ? game.black : game.white;
  const outcome = game.status === "ABORTED" ? null : resultForColor(game.result, myColor);
  const before = myColor === "white" ? game.whiteRatingBefore : game.blackRatingBefore;
  const after = myColor === "white" ? game.whiteRatingAfter : game.blackRatingAfter;
  const delta = before != null && after != null ? Math.round(after) - Math.round(before) : null;
  const tc = TIME_CONTROLS[game.category];
  const accuracy = game.analysis?.status === "COMPLETED" ? (myColor === "white" ? game.analysis.whiteAccuracy : game.analysis.blackAccuracy) : null;
  return (
    <Link href={game.status === "ACTIVE" ? `/game/${game.id}` : `/review/${game.id}`} className="flex items-center gap-3 rounded-xl px-3 py-3 transition hover:bg-surface-2">
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xs font-bold",
          outcome === "win" && "bg-success-soft text-success",
          outcome === "loss" && "bg-danger-soft text-danger",
          outcome === "draw" && "bg-surface-3 text-fg-muted",
          !outcome && "bg-surface-3 text-fg-faint",
        )}
      >
        {outcome === "win" ? "W" : outcome === "loss" ? "L" : outcome === "draw" ? "½" : "—"}
      </span>
      <Avatar name={opponent.username ?? "?"} src={opponent.image} size={36} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold">{opponent.username}</span>
          <Badge>{tc.name}</Badge>
          {!game.rated ? <Badge>Casual</Badge> : null}
        </span>
        <span className="block truncate text-xs text-fg-muted">
          {game.openingName ?? "—"} · {endReasonLabel(game.endReason)} · {game.ply} plies
        </span>
      </span>
      <span className="text-right">
        {delta != null ? <span className={cn("block text-sm font-semibold", delta >= 0 ? "text-success" : "text-danger")}>{delta >= 0 ? "+" : ""}{delta}</span> : <span className="block text-sm text-fg-faint">—</span>}
        <span className="block text-xs text-fg-faint">{accuracy != null ? `${accuracy.toFixed(1)}% acc` : new Date(game.startedAt).toLocaleDateString()}</span>
      </span>
    </Link>
  );
}
