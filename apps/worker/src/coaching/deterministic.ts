import type { AnalysisSummary, CoachingMistake, CoachingReport, MoveAnalysisDTO, PlayerColor } from "@tempo/shared";
import { THEME_LABELS } from "@tempo/shared";

export interface GameFacts {
  whiteName: string;
  blackName: string;
  result: "WHITE_WINS" | "BLACK_WINS" | "DRAW" | null;
  endReason: string | null;
  category: "BULLET" | "BLITZ" | "RAPID";
  initialTimeMs: number;
}

type MoveWithTheme = MoveAnalysisDTO & { theme?: string | null };

const PRACTICE: Record<string, string> = {
  "hanging-piece": "Before every move, ask “what can my opponent capture after this?” — scan for undefended pieces and loose pawns.",
  "missed-tactic": "Solve a few tactics puzzles daily; look for checks, captures and threats on every move before settling on a quiet plan.",
  "king-safety": "Castle early and keep the pawn shield intact; avoid opening lines near your own king.",
  "allowed-mate": "When your king is exposed, calculate your opponent's checks first — mate threats come before everything else.",
  "missed-mate": "When ahead, look for forcing sequences (checks first) — a forced mate is better than winning material.",
  "opening-development": "Follow the opening principles: control the center, develop knights and bishops, castle, then make a plan.",
  "endgame-technique": "Study basic endgames (king activity, passed pawns, rook endings); technique is where many games are decided.",
  "piece-activity": "Improve your worst-placed piece; active pieces create threats and limit your opponent's options.",
  "pawn-structure": "Keep pawn moves purposeful — each one creates weaknesses that last the whole game.",
  "time-trouble": "Budget your clock: play known moves quickly and spend time on critical positions, not routine ones.",
  "converting-advantage": "When winning, simplify: trade pieces, keep the king safe and avoid unnecessary complications.",
  defence: "In worse positions, stay solid: keep pieces coordinated and avoid creating new weaknesses.",
  material: "Count material after every exchange sequence — never assume a recapture is coming.",
  "center-control": "Fight for the central squares; they give your pieces mobility and restrict your opponent.",
  "threat-recognition": "After each opponent move, ask what it threatens before executing your own plan.",
};

export function buildCoaching(color: PlayerColor, moves: MoveWithTheme[], summary: AnalysisSummary, game: GameFacts): CoachingReport {
  const own = moves.filter((m) => m.color === color);
  const sideSummary = color === "white" ? summary.white : summary.black;
  const won = game.result === (color === "white" ? "WHITE_WINS" : "BLACK_WINS");
  const lost = game.result && game.result !== "DRAW" && !won;

  // Biggest mistakes by win-chance lost.
  const bad = own
    .filter((m) => ["INACCURACY", "MISTAKE", "BLUNDER"].includes(m.classification))
    .sort((a, b) => b.winChanceBefore - b.winChanceAfter - (a.winChanceBefore - a.winChanceAfter));
  const biggestMistakes: CoachingMistake[] = bad.slice(0, 3).map((m) => ({
    ply: m.ply,
    san: m.playedSan,
    color,
    classification: m.classification,
    bestSan: m.bestSan,
    winDrop: Math.round((m.winChanceBefore - m.winChanceAfter) * 10) / 10,
    theme: m.theme ?? "piece-activity",
    explanation: m.explanation ?? "",
  }));

  // Themes by frequency, weighted by severity.
  const themeCounts = new Map<string, number>();
  for (const m of bad) {
    const t = m.theme ?? "piece-activity";
    themeCounts.set(t, (themeCounts.get(t) ?? 0) + (m.classification === "BLUNDER" ? 2 : 1));
  }
  const themes = [...themeCounts.entries()].sort((a, b) => b[1] - a[1]).map(([theme, count]) => ({ theme, count }));

  // Strengths — only claims backed by the numbers.
  const didWell: string[] = [];
  const judged = own.filter((m) => m.classification !== "BOOK" && m.classification !== "FORCED");
  if (sideSummary.bestMovePct != null && judged.length >= 5 && sideSummary.bestMovePct >= 45) didWell.push(`You found the engine's top move ${sideSummary.bestMovePct}% of the time.`);
  if (sideSummary.counts.BRILLIANT) didWell.push(`You played ${sideSummary.counts.BRILLIANT} brilliant sacrifice${sideSummary.counts.BRILLIANT > 1 ? "s" : ""} that the engine confirms as sound.`);
  if (sideSummary.counts.GREAT) didWell.push(`You found ${sideSummary.counts.GREAT} critical “only move${sideSummary.counts.GREAT > 1 ? "s" : ""}” under pressure.`);
  if (sideSummary.counts.BOOK >= 4) didWell.push(`You stayed in opening theory for ${sideSummary.counts.BOOK} moves${summary.opening?.name ? ` (${summary.opening.name})` : ""}.`);
  const openingMoves = own.filter((m) => m.ply <= 20);
  if (openingMoves.length >= 6 && openingMoves.every((m) => !["MISTAKE", "BLUNDER"].includes(m.classification))) didWell.push("No mistakes or blunders in the opening — a solid start.");
  const winningStretch = own.filter((m) => m.winChanceBefore >= 80);
  if (won && winningStretch.length >= 5 && winningStretch.every((m) => m.classification !== "BLUNDER")) didWell.push("You converted a winning position without any blunders.");
  const defending = own.filter((m) => m.winChanceBefore <= 35);
  if (defending.length >= 5 && defending.filter((m) => m.classification === "BLUNDER").length === 0) didWell.push("You defended a difficult position without blundering.");
  if (sideSummary.accuracy != null && sideSummary.accuracy >= 85) didWell.push(`An accuracy of ${sideSummary.accuracy}% is excellent for ${game.category.toLowerCase()} chess.`);
  if (!sideSummary.counts.BLUNDER && judged.length >= 10) didWell.push("No blunders in the whole game.");
  if (!didWell.length) didWell.push(sideSummary.counts.BEST ? `You matched the engine's choice on ${sideSummary.counts.BEST} moves.` : "Every game has lessons — review the mistakes below to find yours.");

  // Practice recommendations from the dominant themes.
  const practice: string[] = themes.slice(0, 3).map((t) => PRACTICE[t.theme] ?? PRACTICE["piece-activity"]!);
  const trainable = bad.filter((m) => ["MISTAKE", "BLUNDER"].includes(m.classification)).length;
  if (trainable) practice.push(`Replay the ${trainable} saved position${trainable > 1 ? "s" : ""} from this game in Practice Mistakes until you find the better move without hints.`);
  if (!practice.length) practice.push("Keep playing — try slightly longer time controls to practise calculating critical positions.");

  // Turning point.
  let turningPoint: CoachingReport["turningPoint"] = null;
  if (summary.turningPoint) {
    const tp = moves.find((m) => m.ply === summary.turningPoint!.ply);
    const theirs = summary.turningPoint.color !== color;
    const moveNo = `${Math.ceil(summary.turningPoint.ply / 2)}${summary.turningPoint.color === "white" ? "." : "..."}`;
    turningPoint = {
      ply: summary.turningPoint.ply,
      san: summary.turningPoint.san,
      text: theirs
        ? `The game turned on ${moveNo} ${summary.turningPoint.san} by your opponent, a ${summary.turningPoint.swing}% swing in winning chances.${tp?.bestSan ? ` ${tp.bestSan} would have kept the balance.` : ""}`
        : `Your ${moveNo} ${summary.turningPoint.san} was the key moment: a ${summary.turningPoint.swing}% swing.${tp?.explanation ? ` ${tp.explanation}` : ""}`,
    };
  }

  // Opening insight.
  let openingInsight: string;
  if (summary.opening?.name && summary.opening.lastBookPly >= moves.length) {
    openingInsight = `You played the ${summary.opening.name} (${summary.opening.eco}) and the whole game stayed within known opening theory.`;
  } else if (summary.opening?.name) {
    const leavePly = summary.opening.lastBookPly;
    const after = moves.find((m) => m.ply === leavePly + 1);
    const leaver = after ? (after.color === color ? "you" : "your opponent") : null;
    const evalAtLeave = summary.winChances[leavePly];
    const yourChance = evalAtLeave != null ? (color === "white" ? evalAtLeave : 100 - evalAtLeave) : null;
    openingInsight = `You played the ${summary.opening.name} (${summary.opening.eco}). The game left known theory at move ${Math.ceil((leavePly + 1) / 2)}${leaver ? ` when ${leaver} played ${after!.playedSan}` : ""}${
      yourChance != null ? `, with your winning chances at ${Math.round(yourChance)}%` : ""
    }.${after && after.color === color && ["INACCURACY", "MISTAKE", "BLUNDER"].includes(after.classification) ? ` ${after.bestSan ?? "The main line"} was the theoretical continuation.` : ""}`;
  } else {
    openingInsight = "The opening did not match a named line in the database — focus on principles: center, development, king safety.";
  }

  // One lesson.
  const dominant = themes[0]?.theme;
  const lesson = dominant
    ? `Lesson: ${THEME_LABELS[dominant] ?? dominant}. ${PRACTICE[dominant] ?? ""}`.trim()
    : won
      ? "Lesson: keep playing principled chess — this game had no serious errors from you."
      : lost
        ? "Lesson: the loss came from small inaccuracies rather than a single blunder — tighten calculation on every move."
        : "Lesson: solid play; look for ways to create winning chances from balanced positions.";

  return { color, didWell: didWell.slice(0, 4), biggestMistakes, practice: practice.slice(0, 3), turningPoint, openingInsight, lesson, themes, source: "deterministic" };
}
