# Game Review: how Tempo evaluates moves

All numbers on the review screen come from a **Stockfish** analysis run by the worker service
(`apps/worker`). Nothing is estimated client-side and nothing is shown before the job completes.

## Engine settings

| Setting | Default (env) | Notes |
|---|---|---|
| Engine | `STOCKFISH_PATH` (Stockfish 16) | Separate process, UCI protocol |
| Depth | `ANALYSIS_DEPTH=16` | `ANALYSIS_MOVETIME_MS` switches to time-based search |
| MultiPV | `ANALYSIS_MULTIPV=2` | Second line is used for "only move" and brilliancy detection |
| Threads / Hash | `STOCKFISH_THREADS=2`, `STOCKFISH_HASH_MB=128` | Per engine process |
| Concurrency | `WORKER_CONCURRENCY=1` | Bounded engine pool; queue backed by BullMQ/Redis |

Every position of the game (start position plus one per move) is evaluated once, with the same
settings, so scores are comparable. Positions are cached in Redis by FEN for 7 days. Terminal
positions (checkmate, stalemate, dead draws) are scored without the engine.

Scores are stored from White's point of view: `cp` centipawns, or `mate` = signed moves-to-mate.

## Win chance

`winChance(cp) = 50 + 50 · (2 / (1 + e^(−0.00368208·cp)) − 1)`, mate = 100 / 0. This logistic
curve is the widely used lichess calibration.

## Move accuracy and game accuracy

For each move, Δ = win chance before the move (best achievable) − win chance after the move,
from the mover's point of view. `moveAccuracy = 103.1668 · e^(−0.04354·Δ) − 3.1669`, clamped to 0–100.

Game accuracy per side = mean of (a) the volatility-weighted average of move accuracies, where the
weight is the standard deviation of win chances in a sliding window (sharper positions weigh more,
clamped to 0.5–12), and (b) the harmonic mean of move accuracies. Average centipawn loss (ACPL) is
reported separately, capping single-move losses at 1000.

This is Tempo's own calibration. It is inspired by publicly documented approaches but is **not**
a reproduction of any other site's proprietary formula.

## Classification (packages/chess-core/src/analysis.ts)

Precedence, evaluated top to bottom:

1. **Forced** - only one legal move.
2. **Book** - the position after the move is in the ECO opening database (lichess-org/chess-openings, CC0) and the game is still inside its identified opening line.
3. **Blunder** (special) - the move allows a forced mate from a position that was not already lost.
4. **Missed mate** - the mover had a forced mate and no longer does: Inaccuracy if still +3 or better, otherwise Mistake.
5. **Brilliant** - the move is the engine's best (or within 1% win chance), it sacrifices at least two pawns of material that the engine's expected continuation does not win back within four plies, the second-best move is at least 10% win chance worse, the position was not already decided (< 92% win chance) and the mover is not worse than 40% afterwards.
6. **Great** - as above without the sacrifice requirement: the only move that keeps the position (second best ≥ 10% worse), with winning chances between 15% and 92%.
7. **Best** - the engine's top move.
8. **Excellent** Δ ≤ 2 · **Good** Δ ≤ 5 · **Inaccuracy** Δ ≤ 10 · **Mistake** Δ ≤ 20 · **Blunder** Δ > 20 (Δ in win-chance percentage points).

Because Δ is measured in win chance, moves in already-decided positions are naturally graded gently.

## Explanations and themes (apps/worker/src/analysis/explain.ts)

Explanations are generated from concrete engine facts: the best move, the principal variation,
the opponent's best reply, material changes along the expected continuation, mate distances, the
game phase and the clock. Each explanation template corresponds to a theme (hanging piece, missed
tactic, king safety, allowed/missed mate, opening development, endgame technique, converting an
advantage, defence, time trouble, threat recognition). Themes feed the coaching report and the
Improve dashboard.

## Coaching (apps/worker/src/coaching)

The deterministic coach builds the report (strengths, biggest mistakes, practice items, turning
point, opening insight, one lesson) only from analysis data. If `ANTHROPIC_API_KEY` is set, the
report is rewritten for clarity by Claude with the structured facts as the only input; any output
that mentions a move not present in the engine data is rejected and the deterministic text is kept.

## Training positions (apps/worker/src/training/positions.ts)

Mistakes and blunders where the played move loses ≥ 100 cp (or a forced mate was available) become
exercises. Stored solutions are the engine lines within 25 cp of the best move. When a user plays a
move outside that set, the attempt API evaluates it with Stockfish and accepts it if it is within
30 cp of the best move and does not allow mate.
