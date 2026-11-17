"use client";

import Link from "next/link";
import type { Chess } from "chess.js";
import { capturedPieces, materialValue } from "@tempo/chess-core";
import type { ClockState, PlayerColor, PlayerInfo } from "@tempo/shared";
import { Avatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/cn";
import { Clock } from "./Clock";

export function PlayerPanel({
  player,
  color,
  clock,
  chess,
  pieceSet,
  isYou,
  connected,
  soundsEnabled,
  showRating,
  finished,
  compact,
}: {
  player: PlayerInfo;
  color: PlayerColor;
  clock: ClockState & { receivedAt: number };
  chess: Chess;
  pieceSet: string;
  isYou: boolean;
  connected: boolean;
  soundsEnabled: boolean;
  showRating: boolean;
  finished: boolean;
  compact?: boolean;
}) {
  const captured = capturedPieces(chess);
  const mine = color === "white" ? captured.byWhite : captured.byBlack;
  const theirs = color === "white" ? captured.byBlack : captured.byWhite;
  const diff = materialValue(mine) - materialValue(theirs);
  const opp = color === "white" ? "b" : "w";
  const delta = player.ratingDelta != null ? Math.round(player.ratingDelta) : null;

  return (
    <div className={cn("flex items-center gap-3", compact ? "py-1" : "py-1.5")}>
      <Link href={`/profile/${player.username}`} className="shrink-0">
        <Avatar name={player.username} src={player.image} size={compact ? 34 : 40} status={connected ? "online" : "offline"} />
      </Link>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link href={`/profile/${player.username}`} className="truncate font-semibold hover:underline">
            {player.username}
          </Link>
          {showRating ? (
            <span className="text-sm text-fg-muted">
              {Math.round(player.rating)}
              {player.provisional ? "?" : ""}
            </span>
          ) : null}
          {finished && delta != null ? <span className={cn("text-sm font-semibold", delta >= 0 ? "text-success" : "text-danger")}>{delta >= 0 ? "+" : ""}{delta}</span> : null}
          {isYou ? <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-fg-muted">You</span> : null}
          {!connected && !finished ? <span className="text-xs text-danger">reconnecting…</span> : null}
        </div>
        <div className="mt-0.5 flex h-5 items-center gap-0.5">
          {(["q", "r", "b", "n", "p"] as const).flatMap((t) =>
            Array.from({ length: mine[t] }).map((_, i) => (
              <span key={`${t}${i}`} className="inline-block h-5 w-5 bg-contain bg-center bg-no-repeat opacity-80" style={{ backgroundImage: `url(/pieces/${pieceSet}/${opp}${t.toUpperCase()}.svg)`, marginLeft: i ? -8 : 0 }} />
            )),
          )}
          {diff > 0 ? <span className="ml-1 text-xs font-semibold text-fg-muted">+{diff}</span> : null}
        </div>
      </div>
      <Clock clock={clock} color={color} soundsEnabled={soundsEnabled} compact={compact} />
    </div>
  );
}
