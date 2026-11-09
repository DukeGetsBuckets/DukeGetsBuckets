// JSON shapes returned by the API. Only public-safe fields: no internal user ids,
// password hashes, IPs, session data or moderation details leak to normal users.

export type Role = "user" | "admin";

export interface Me {
  username: string;
  role: Role;
  suspended: boolean;
  createdAt: number;
  /** Set after an admin password reset: the user must choose a new password before anything else. */
  mustChangePassword: boolean;
}

export interface PostDTO {
  id: string;
  author: string;
  caption: string | null;
  width: number;
  height: number;
  imageUrl: string;
  createdAt: number;
  expiresAt: number;
  commentCount: number;
  isMine: boolean;
  /** Only present for the owner/admin when the post is hidden pending review. */
  hidden?: boolean;
}

export interface CommentDTO {
  id: string;
  author: string;
  body: string;
  createdAt: number;
  fireCount: number;
  firedByMe: boolean;
  isMine: boolean;
  canDelete: boolean;
}

export interface ProfileDTO {
  username: string;
  joinedAt: number;
  posts: Array<{ id: string; imageUrl: string; createdAt: number; expiresAt: number; commentCount: number; width: number; height: number }>;
  recentComments: Array<{ id: string; body: string; createdAt: number; postId: string; fireCount: number }>;
}

export interface ApiError {
  error: string;
  retryAfter?: number;
}

// ───────────── admin ─────────────

export interface AdminStats {
  activePhotos: number;
  hiddenPhotos: number;
  users: number;
  suspendedUsers: number;
  comments: number;
  openReports: number;
  uploads24h: number;
}

export interface AdminPost {
  id: string;
  imageUrl: string;
  uploader: string;
  caption: string | null;
  createdAt: number;
  expiresAt: number;
  commentCount: number;
  reportCount: number;
  status: "active" | "hidden";
}

export interface AdminComment {
  id: string;
  body: string;
  author: string;
  postId: string;
  postImageUrl: string;
  createdAt: number;
  reportCount: number;
  status: "active" | "hidden";
}

export interface AdminReportGroup {
  targetType: "post" | "comment";
  targetId: string;
  reportCount: number;
  firstReportedAt: number;
  lastReportedAt: number;
  hasItsMe: boolean;
  targetStatus: "active" | "hidden" | "gone";
  content: {
    author: string | null;
    body?: string;
    imageUrl?: string;
    caption?: string | null;
    postId?: string;
  };
  reports: Array<{ id: string; reporter: string | null; reason: string; details: string | null; createdAt: number }>;
}

export interface AdminUser {
  username: string;
  role: Role;
  status: "active" | "suspended";
  createdAt: number;
  postCount: number;
  commentCount: number;
  reportsReceived: number;
}

// ───────────── review archive (reported content only) ─────────────

export interface ArchivedReport {
  reason: string;
  details: string | null;
  reporter: string | null;
  at: number;
}

export type BurnDeletionReason = "expired" | "photo_deleted" | "deleted_by_author" | "deleted_by_photo_owner" | "removed_by_admin" | "account_deleted";
export type PostDeletionReason = "expired" | "deleted_by_owner" | "removed_by_admin" | "account_deleted";

export interface ArchivedBurn {
  id: string;
  postId: string;
  author: string;
  photoOwner: string | null;
  body: string;
  fireCount: number;
  reports: ArchivedReport[];
  createdAt: number;
  deletedAt: number;
  deletionReason: BurnDeletionReason;
}

export interface ArchivedPost {
  id: string;
  owner: string;
  caption: string | null;
  commentCount: number;
  reports: ArchivedReport[];
  createdAt: number;
  deletedAt: number;
  deletionReason: PostDeletionReason;
}

export interface AdminUserDetail {
  user: AdminUser;
  livePosts: AdminPost[];
  liveBurns: AdminComment[];
  archivedPosts: ArchivedPost[];
  archivedBurns: ArchivedBurn[];
}
