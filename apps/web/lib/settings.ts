import { z } from "zod";

export const BOARD_THEMES = {
  walnut: { name: "Walnut", light: "#ead9b8", dark: "#a9774f", highlight: "rgba(255, 221, 89, 0.55)", check: "rgba(239, 68, 68, 0.75)" },
  slate: { name: "Slate", light: "#dfe4eb", dark: "#7c8ea4", highlight: "rgba(255, 221, 89, 0.5)", check: "rgba(239, 68, 68, 0.75)" },
  forest: { name: "Forest", light: "#e7ecd4", dark: "#6e8f5c", highlight: "rgba(255, 221, 89, 0.55)", check: "rgba(239, 68, 68, 0.75)" },
  ocean: { name: "Ocean", light: "#e2ecf5", dark: "#5783ab", highlight: "rgba(255, 221, 89, 0.55)", check: "rgba(239, 68, 68, 0.75)" },
  rose: { name: "Rose", light: "#f4e6e8", dark: "#b2788a", highlight: "rgba(255, 221, 89, 0.55)", check: "rgba(239, 68, 68, 0.75)" },
  graphite: { name: "Graphite", light: "#9aa0a6", dark: "#4a5057", highlight: "rgba(255, 221, 89, 0.5)", check: "rgba(239, 68, 68, 0.8)" },
} as const;
export type BoardThemeId = keyof typeof BOARD_THEMES;

export const PIECE_SETS = {
  chessnut: { name: "Chessnut", credit: "Alexis Luengas — Apache-2.0" },
  fantasy: { name: "Fantasy", credit: "Maurizio Monge — MIT" },
  spatial: { name: "Spatial", credit: "Maurizio Monge — MIT" },
  celtic: { name: "Celtic", credit: "Maurizio Monge — MIT" },
  "kiwen-suwi": { name: "Kiwen Suwi", credit: "neverRare — CC BY 4.0" },
} as const;
export type PieceSetId = keyof typeof PIECE_SETS;

export const settingsSchema = z.object({
  boardTheme: z.enum(Object.keys(BOARD_THEMES) as [BoardThemeId, ...BoardThemeId[]]),
  pieceSet: z.enum(Object.keys(PIECE_SETS) as [PieceSetId, ...PieceSetId[]]),
  showLegalMoves: z.boolean(),
  showLastMove: z.boolean(),
  showCoordinates: z.boolean(),
  animationMs: z.number().int().min(0).max(600),
  premovesEnabled: z.boolean(),
  defaultPromotion: z.enum(["q", "r", "b", "n"]),
  confirmResign: z.boolean(),
  soundEnabled: z.boolean(),
  soundVolume: z.number().int().min(0).max(100),
  showOpponentRating: z.boolean(),
  theme: z.enum(["system", "dark", "light"]),
  reducedMotion: z.boolean(),
  arrowColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  chatEnabled: z.boolean(),
  allowFriendRequests: z.boolean(),
  allowChallenges: z.enum(["everyone", "friends", "nobody"]),
  autoQueen: z.boolean().optional().default(false),
});

export type UserSettingsDTO = z.infer<typeof settingsSchema>;
export const settingsPatchSchema = settingsSchema.partial();

export const DEFAULT_SETTINGS: UserSettingsDTO = {
  boardTheme: "walnut",
  pieceSet: "chessnut",
  showLegalMoves: true,
  showLastMove: true,
  showCoordinates: true,
  animationMs: 180,
  premovesEnabled: true,
  defaultPromotion: "q",
  confirmResign: true,
  soundEnabled: true,
  soundVolume: 80,
  showOpponentRating: true,
  theme: "system",
  reducedMotion: false,
  arrowColor: "#f59e0b",
  chatEnabled: true,
  allowFriendRequests: true,
  allowChallenges: "everyone",
  autoQueen: false,
};

export function toSettingsDTO(row: Record<string, unknown> | null | undefined): UserSettingsDTO {
  if (!row) return DEFAULT_SETTINGS;
  const parsed = settingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...row });
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}
