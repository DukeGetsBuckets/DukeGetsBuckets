/**
 * Glicko-2 rating system (Mark Glickman, http://www.glicko.net/glicko/glicko2.pdf).
 * Each game is treated as its own rating period, as is standard for online play.
 */

export interface GlickoRating {
  rating: number;
  deviation: number;
  volatility: number;
}

export interface GlickoOptions {
  /** System constant τ, typically 0.3–1.2. Smaller = more stable volatility. */
  tau: number;
  /** Convergence tolerance for the volatility iteration. */
  epsilon?: number;
  minDeviation?: number;
  maxDeviation?: number;
}

const SCALE = 173.7178;
const PI2 = Math.PI * Math.PI;

export const DEFAULT_GLICKO_OPTIONS: GlickoOptions = {
  tau: 0.5,
  epsilon: 0.000001,
  minDeviation: 45,
  maxDeviation: 350,
};

function toMu(rating: number): number {
  return (rating - 1500) / SCALE;
}
function toPhi(deviation: number): number {
  return deviation / SCALE;
}
function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / PI2);
}
function E(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

export interface GlickoGame {
  opponent: GlickoRating;
  /** 1 = win, 0.5 = draw, 0 = loss (from the player's perspective). */
  score: 0 | 0.5 | 1;
}

/**
 * Compute a player's new rating after a rating period containing `games`.
 * With an empty `games` list only the deviation increases (inactivity).
 */
export function updateRating(player: GlickoRating, games: GlickoGame[], options: GlickoOptions = DEFAULT_GLICKO_OPTIONS): GlickoRating {
  const tau = options.tau;
  const eps = options.epsilon ?? 0.000001;
  const mu = toMu(player.rating);
  const phi = toPhi(player.deviation);
  const sigma = player.volatility;

  if (games.length === 0) {
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    return clampDeviation({ rating: player.rating, deviation: phiStar * SCALE, volatility: sigma }, options);
  }

  // Step 3: estimated variance v
  let vInv = 0;
  let deltaSum = 0;
  for (const game of games) {
    const muJ = toMu(game.opponent.rating);
    const phiJ = toPhi(game.opponent.deviation);
    const gj = g(phiJ);
    const e = E(mu, muJ, phiJ);
    vInv += gj * gj * e * (1 - e);
    deltaSum += gj * (game.score - e);
  }
  const v = 1 / vInv;
  // Step 4: estimated improvement Δ
  const delta = v * deltaSum;

  // Step 5: new volatility σ' via the Illinois algorithm
  const a = Math.log(sigma * sigma);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    const num = ex * (delta * delta - phi * phi - v - ex);
    const den = 2 * Math.pow(phi * phi + v + ex, 2);
    return num / den - (x - a) / (tau * tau);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  let iterations = 0;
  while (Math.abs(B - A) > eps && iterations < 100) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
    iterations++;
  }
  const sigmaPrime = Math.exp(A / 2);

  // Step 6 & 7: new deviation and rating
  const phiStar = Math.sqrt(phi * phi + sigmaPrime * sigmaPrime);
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muPrime = mu + phiPrime * phiPrime * deltaSum;

  return clampDeviation(
    {
      rating: muPrime * SCALE + 1500,
      deviation: phiPrime * SCALE,
      volatility: sigmaPrime,
    },
    options,
  );
}

function clampDeviation(r: GlickoRating, options: GlickoOptions): GlickoRating {
  const min = options.minDeviation ?? 0;
  const max = options.maxDeviation ?? Infinity;
  return { ...r, deviation: Math.min(max, Math.max(min, r.deviation)) };
}

/** Inflate deviation for inactivity: one rating period per day without games. */
export function inflateForInactivity(player: GlickoRating, daysInactive: number, options: GlickoOptions = DEFAULT_GLICKO_OPTIONS): GlickoRating {
  const periods = Math.max(0, Math.min(365, Math.floor(daysInactive)));
  if (periods === 0) return player;
  const phi = toPhi(player.deviation);
  const sigma = player.volatility;
  const phiStar = Math.sqrt(phi * phi + periods * sigma * sigma);
  return clampDeviation({ ...player, deviation: phiStar * SCALE }, options);
}

/** Expected score of `player` against `opponent` (win probability including half-credit for draws). */
export function expectedScore(player: GlickoRating, opponent: GlickoRating): number {
  return E(toMu(player.rating), toMu(opponent.rating), toPhi(opponent.deviation));
}

export interface PairUpdate {
  white: GlickoRating;
  black: GlickoRating;
}

/** Rate one game between two players; both are updated from their pre-game values. */
export function rateGame(
  white: GlickoRating,
  black: GlickoRating,
  result: "WHITE_WINS" | "BLACK_WINS" | "DRAW",
  options: GlickoOptions = DEFAULT_GLICKO_OPTIONS,
): PairUpdate {
  const whiteScore: 0 | 0.5 | 1 = result === "WHITE_WINS" ? 1 : result === "DRAW" ? 0.5 : 0;
  const blackScore: 0 | 0.5 | 1 = result === "BLACK_WINS" ? 1 : result === "DRAW" ? 0.5 : 0;
  return {
    white: updateRating(white, [{ opponent: black, score: whiteScore }], options),
    black: updateRating(black, [{ opponent: white, score: blackScore }], options),
  };
}

export function isProvisional(deviation: number, threshold = 110): boolean {
  return deviation > threshold;
}
