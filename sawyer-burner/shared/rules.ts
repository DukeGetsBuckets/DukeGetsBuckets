// Limits shared by the Worker (authoritative) and the React client (UX hints only).

export const POST_TTL_MS = 24 * 60 * 60 * 1000;

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
export const USERNAME_PATTERN = /^[a-z0-9_]+$/;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export const COMMENT_MAX = 280;
export const CAPTION_MAX = 120;
export const REPORT_DETAILS_MAX = 500;

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // hard server limit (client compresses first)
export const MAX_IMAGE_DIMENSION = 10_000;
export const MAX_IMAGE_PIXELS = 50_000_000;
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

/** Distinct reporters needed before content is auto-hidden pending admin review. */
export const AUTO_HIDE_REPORT_THRESHOLD = 3;

export const REPORT_REASONS = [
  { value: "harassment", label: "Harassment or bullying" },
  { value: "non_consensual", label: "Posted without permission" },
  { value: "its_me", label: "This is me — take it down" },
  { value: "personal_info", label: "Personal / private info (doxxing)" },
  { value: "threats", label: "Threats or violence" },
  { value: "sexual_content", label: "Sexual content" },
  { value: "spam", label: "Spam" },
  { value: "other", label: "Something else" },
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number]["value"];
export const REPORT_REASON_VALUES = REPORT_REASONS.map((r) => r.value) as readonly string[];
