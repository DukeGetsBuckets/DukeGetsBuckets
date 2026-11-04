// REST API contract shared by the Worker (server) and the client.
// All endpoints return JSON. Errors: { error: string, code?: string } with a 4xx/5xx status.
// Auth: `Authorization: Bearer <token>` header (token from /api/auth/*).

import type { CarConfig } from './game/carConfig';
import type { Placement, ThemeId, TrackDefinition } from './track/types';

/* ---------- players ---------- */

export interface PlayerPublic {
  id: string;
  name: string;
  carColor: string;      // primary paint hex, shown on leaderboards
  level: number;
  schoolId: string | null;
  schoolName: string | null;
  friendCode: string;    // short shareable code (e.g. "RX7K2P")
  isGuest: boolean;
}

export interface PlayerStats {
  races: number;         // races started (records submitted incl. non-PB)
  finishes: number;
  wins: number;          // multiplayer wins
  personalBests: number;
  tracksCompleted: number;
  goldMedals: number;
  authorMedals: number;
  worldRecords: number;
  friendsBeaten: number;
  dailyWins: number;
  tracksPublished: number;
}

export interface AchievementState { id: string; unlockedAt: number }

export interface PlayerProfile extends PlayerPublic {
  xp: number;
  coins: number;
  createdAt: number;
  stats: PlayerStats;
  unlocked: string[];          // cosmetic item ids owned (free items are always implicitly owned)
  achievements: AchievementState[];
  car: CarConfig;
  friends: PlayerPublic[];
  unreadNotifications: number;
}

export interface AuthResponse { token: string; player: PlayerProfile }

export interface GuestAuthRequest { name: string }
export interface RegisterRequest { name: string; password: string; guestToken?: string } // guestToken upgrades a guest profile
export interface LoginRequest { name: string; password: string }
export interface UpdateMeRequest { name?: string; car?: CarConfig }

/* ---------- records / leaderboards ---------- */

export type LeaderboardScope = 'global' | 'school' | 'friends' | 'daily' | 'weekly';

export interface LeaderboardEntry {
  rank: number;
  recordId: string;
  playerId: string;
  name: string;
  carColor: string;
  timeMs: number;
  achievedAt: number;
  hasReplay: boolean;
  schoolName: string | null;
  level: number;
}

export interface LeaderboardResponse {
  trackId: string;
  scope: LeaderboardScope;
  entries: LeaderboardEntry[];
  me: { rank: number; timeMs: number; recordId: string } | null;
  total: number;
  periodKey?: string;     // day or week key for daily/weekly
}

export interface SubmitRecordRequest {
  trackId: string;        // official id or community track id
  timeMs: number;
  splits: number[];       // checkpoint times incl. finish (ms)
  replay: string;         // base64 encoded replay (shared/game/replay.ts encodeReplay)
  car: CarConfig;
  respawns: number;
  topSpeed: number;       // m/s (client reported, plausibility checked)
  mode: 'solo' | 'daily' | 'live' | 'ghost';
  clientVersion?: string;
}

export interface SubmitRecordResponse {
  accepted: boolean;
  reason?: string;        // when rejected
  recordId?: string;
  isPb: boolean;
  prevPbMs: number | null;
  rank: number | null;    // global rank after submission
  worldRecord: boolean;
  medal: 'author' | 'gold' | 'silver' | 'bronze' | null;
  xp: number;             // xp awarded by this submission
  coins: number;
  levelUp: number | null; // new level if leveled up
  achievements: string[]; // newly unlocked achievement ids
  rivalsBeaten: { playerId: string; name: string; byMs: number }[];
  player: PlayerProfile;  // refreshed profile
}

export interface ReplayResponse {
  recordId: string;
  trackId: string;
  timeMs: number;
  replay: string;         // base64
  player: PlayerPublic;
  car: CarConfig;
  achievedAt: number;
}

export interface PbHistoryResponse { trackId: string; history: { timeMs: number; achievedAt: number; recordId: string }[] }

/* ---------- friends ---------- */

export interface AddFriendRequest { code: string }
export interface FriendsResponse { friends: (PlayerPublic & { lastSeen: number; bests: Record<string, number> })[] }

/* ---------- schools ---------- */

export interface School { id: string; name: string; code: string; memberCount: number; createdAt: number }
export interface CreateSchoolRequest { name: string }
export interface JoinSchoolRequest { code: string }
export interface SchoolRankingEntry { rank: number; playerId: string; name: string; carColor: string; level: number; points: number; personalBests: number; tracksCompleted: number }
export interface SchoolRecord { trackId: string; trackName: string; timeMs: number; playerId: string; playerName: string; achievedAt: number }
export interface SchoolResponse {
  school: School;
  rankings: SchoolRankingEntry[];          // all-time points
  weekly: { weekKey: string; endsAt: number; rankings: SchoolRankingEntry[] };
  records: SchoolRecord[];                 // best per track
  rivalries: { a: PlayerPublic; b: PlayerPublic; aWins: number; bWins: number }[];
}

/* ---------- daily challenge ---------- */

export interface DailyResponse {
  dayKey: string;          // YYYY-MM-DD (UTC)
  trackId: string;
  endsAt: number;          // epoch ms
  top: LeaderboardEntry[];
  me: { rank: number; timeMs: number } | null;
  friends: LeaderboardEntry[];
  participants: number;
  yesterday: { dayKey: string; trackId: string; winner: LeaderboardEntry | null } | null;
}

/* ---------- notifications / rivalries ---------- */

export type NotificationKind = 'rival_beat_you' | 'you_beat_rival' | 'rank_change' | 'friend_added' | 'school_record' | 'daily_result' | 'achievement' | 'challenge';
export interface Notification { id: string; kind: NotificationKind; text: string; trackId: string | null; fromPlayer: PlayerPublic | null; createdAt: number; read: boolean }
export interface NotificationsResponse { items: Notification[]; unread: number }
export interface ChallengeRequest { friendId: string; trackId: string }

/* ---------- community tracks ---------- */

export interface CommunityTrackSummary {
  id: string;
  code: string;            // share code
  name: string;
  theme: ThemeId;
  authorId: string;
  authorName: string;
  pieces: number;
  lengthM: number;
  likes: number;
  plays: number;
  published: boolean;
  authorTimeMs: number | null;
  createdAt: number;
  updatedAt: number;
  likedByMe: boolean;
}
export interface CommunityTrack extends CommunityTrackSummary { placements: Placement[]; description: string }
export interface SaveTrackRequest {
  id?: string;             // update an existing draft
  name: string;
  description?: string;
  theme: ThemeId;
  placements: Placement[];
  publish: boolean;
  validation?: { timeMs: number; replay: string; splits: number[] }; // required to publish: author's completed run
}
export interface SaveTrackResponse { track: CommunityTrack; definition: TrackDefinition }
export interface TracksListResponse { tracks: CommunityTrackSummary[]; total: number }
export type TracksSort = 'new' | 'top' | 'mine' | 'played';

/* ---------- shop ---------- */

export interface BuyRequest { itemId: string }
export interface BuyResponse { player: PlayerProfile; item: string }

/* ---------- multiplayer results (persisted) ---------- */

export interface LiveRaceResultRequest {
  roomCode: string;
  trackId: string;
  position: number;
  playerCount: number;
  timeMs: number | null;
}
export interface LiveRaceResultResponse { xp: number; coins: number; achievements: string[]; player: PlayerProfile }

/* ---------- routes (for reference) ----------
POST /api/auth/guest            GuestAuthRequest -> AuthResponse
POST /api/auth/register         RegisterRequest -> AuthResponse
POST /api/auth/login            LoginRequest -> AuthResponse
GET  /api/me                    -> { player: PlayerProfile }
PUT  /api/me                    UpdateMeRequest -> { player: PlayerProfile }
POST /api/records               SubmitRecordRequest -> SubmitRecordResponse
GET  /api/leaderboard?track=&scope=&limit=&offset=   -> LeaderboardResponse
GET  /api/replay/:recordId      -> ReplayResponse
GET  /api/records/history?track= -> PbHistoryResponse
GET  /api/records/bests         -> { bests: Record<trackId, number> }   (all of my PBs)
GET  /api/friends               -> FriendsResponse
POST /api/friends               AddFriendRequest -> { friend: PlayerPublic }
DELETE /api/friends/:id         -> { ok: true }
POST /api/schools               CreateSchoolRequest -> SchoolResponse
POST /api/schools/join          JoinSchoolRequest -> SchoolResponse
POST /api/schools/leave         -> { ok: true }
GET  /api/schools/mine          -> SchoolResponse | { school: null }
GET  /api/daily                 -> DailyResponse
GET  /api/notifications         -> NotificationsResponse
POST /api/notifications/read    -> { ok: true }
POST /api/challenge             ChallengeRequest -> { ok: true }
GET  /api/tracks?sort=&q=&limit=&offset=  -> TracksListResponse
GET  /api/tracks/:id            -> { track: CommunityTrack; definition: TrackDefinition }
GET  /api/tracks/code/:code     -> same
POST /api/tracks                SaveTrackRequest -> SaveTrackResponse
DELETE /api/tracks/:id          -> { ok: true }
POST /api/tracks/:id/like       -> { likes: number; likedByMe: boolean }
POST /api/tracks/:id/play       -> { ok: true }  (increments plays)
POST /api/shop/buy              BuyRequest -> BuyResponse
POST /api/live/result           LiveRaceResultRequest -> LiveRaceResultResponse
GET  /api/health                -> { ok: true }
--------------------------------------------- */
