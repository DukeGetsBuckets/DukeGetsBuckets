/**
 * Central product configuration. Rename the product here (and NEXT_PUBLIC_APP_NAME) to rebrand.
 */
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || "Tempo";
export const APP_TAGLINE = "Fast, fair, beautiful chess.";

export type RatingCategory = "BULLET" | "BLITZ" | "RAPID";
export const RATING_CATEGORIES: readonly RatingCategory[] = ["BULLET", "BLITZ", "RAPID"] as const;

export interface TimeControl {
  category: RatingCategory;
  /** Initial time per player in milliseconds. */
  initialMs: number;
  /** Increment per move in milliseconds. */
  incrementMs: number;
  /** Human label, e.g. "5+0". */
  label: string;
  name: string;
}

/** Launch time controls. Additional controls can be added here without touching the game engine. */
export const TIME_CONTROLS: Record<RatingCategory, TimeControl> = {
  BULLET: { category: "BULLET", initialMs: 60_000, incrementMs: 0, label: "1+0", name: "Bullet" },
  BLITZ: { category: "BLITZ", initialMs: 300_000, incrementMs: 0, label: "5+0", name: "Blitz" },
  RAPID: { category: "RAPID", initialMs: 600_000, incrementMs: 0, label: "10+0", name: "Rapid" },
};

/**
 * Classify an arbitrary time control into a rating category using estimated game duration
 * (initial + 40 × increment), following common convention: < 3 min bullet, < 8 min blitz, otherwise rapid.
 */
export function categoryForTimeControl(initialMs: number, incrementMs: number): RatingCategory {
  const estimatedSeconds = initialMs / 1000 + 40 * (incrementMs / 1000);
  if (estimatedSeconds < 180) return "BULLET";
  if (estimatedSeconds < 480) return "BLITZ";
  return "RAPID";
}

export function timeControlLabel(initialMs: number, incrementMs: number): string {
  const minutes = initialMs / 60_000;
  const m = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
  return `${m}+${Math.round(incrementMs / 1000)}`;
}

export function categoryDisplayName(category: RatingCategory): string {
  return TIME_CONTROLS[category].name;
}

/** Glicko-2 defaults. Starting rating is 1500 (Glickman's reference scale) with high initial uncertainty. */
export const RATING_DEFAULTS = {
  startRating: Number(process.env.RATING_START ?? 1500),
  startDeviation: 350,
  startVolatility: 0.06,
  /** System constant τ — smaller values constrain volatility changes. */
  tau: 0.5,
  /** Ratings with deviation above this are shown as provisional ("?"). */
  provisionalDeviation: 110,
  /** Minimum deviation so ratings never freeze. */
  minDeviation: 45,
  maxDeviation: 350,
  /** RD inflation for inactivity: per day between games. */
  inactivityDeviationPerDay: 1.0,
} as const;

export interface RangeStep {
  /** Allowed absolute rating difference. */
  range: number;
  /** Seconds in queue after which this range applies. */
  afterSeconds: number;
}

/** Parse "100:0,150:5,250:15" into steps. */
export function parseRangeSteps(spec: string | undefined): RangeStep[] {
  const fallback: RangeStep[] = [
    { range: 100, afterSeconds: 0 },
    { range: 150, afterSeconds: 5 },
    { range: 250, afterSeconds: 15 },
    { range: 400, afterSeconds: 30 },
    { range: 600, afterSeconds: 60 },
    { range: 1000, afterSeconds: 120 },
  ];
  if (!spec) return fallback;
  const steps = spec
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [r, s] = part.split(":");
      return { range: Number(r), afterSeconds: Number(s ?? 0) };
    })
    .filter((s) => Number.isFinite(s.range) && Number.isFinite(s.afterSeconds))
    .sort((a, b) => a.afterSeconds - b.afterSeconds);
  return steps.length ? steps : fallback;
}

export const MATCHMAKING_DEFAULTS = {
  rangeSteps: parseRangeSteps(process.env.MATCHMAKING_RANGE_STEPS),
  /** Provisional players (high RD) get a wider initial window so they find games quickly. */
  provisionalBonusRange: 150,
  /** Avoid immediately re-pairing the same two players for this many seconds when alternatives exist. */
  rematchCooldownSeconds: 60,
  /** Matching loop tick in ms. */
  tickMs: 1000,
} as const;

export const GAME_RULES = {
  /** Each player's first move is untimed; the game is aborted if it is not made within this window. */
  firstMoveAbortMs: { BULLET: 20_000, BLITZ: 30_000, RAPID: 60_000 } as Record<RatingCategory, number>,
  /** Draw offers expire after this many plies of the offerer's opponent not responding. */
  drawOfferExpiryPlies: 2,
  /** Clock sync broadcast interval. */
  clockSyncIntervalMs: 5_000,
  /** How long a disconnected player's opponent must wait before claiming victory (ms). */
  disconnectClaimMs: { BULLET: 20_000, BLITZ: 45_000, RAPID: 90_000 } as Record<RatingCategory, number>,
  /** Rematch offers expire after this long. */
  rematchExpiryMs: 60_000,
  maxChatLength: 300,
} as const;

export const SOCIAL_RULES = {
  challengeExpiryMs: 5 * 60_000,
  maxPendingChallengesPerUser: 10,
  maxFriendRequestsPerHour: 30,
  maxSearchPerMinute: 60,
  usernameMin: 3,
  usernameMax: 20,
  usernameRegex: /^[a-zA-Z0-9_]+$/,
  reservedUsernames: ["admin", "administrator", "moderator", "mod", "system", "support", "tempo", "root", "null", "undefined"],
} as const;

export const LEADERBOARD_RULES = {
  minGames: 5,
  pageSize: 50,
} as const;
