// Server-side content rules. Roasts are fine; doxxing, threats, slurs and links are not.
// This is a first line of defence — reports + admin review are the backstop.

import {
  CAPTION_MAX,
  COMMENT_MAX,
  PASSWORD_MAX,
  PASSWORD_MIN,
  USERNAME_MAX,
  USERNAME_MIN,
  USERNAME_PATTERN,
} from "../../shared/rules";
import { ApiError } from "./http";

// ───────────── text hygiene ─────────────

// Zero-width chars, bidi overrides and other invisible format characters used to
// dodge filters or visually spoof text.
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ﻿ﾠ]/g;
// C0/C1 control characters except \n.
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;

export function cleanText(input: unknown, max: number, { multiline = true } = {}): string {
  if (typeof input !== "string") return "";
  let s = input.normalize("NFC").replace(/\r\n?/g, "\n").replace(INVISIBLE, "").replace(CONTROL, "");
  s = multiline ? s.replace(/\n{3,}/g, "\n\n") : s.replace(/\n+/g, " ");
  s = s.replace(/[ \t]{2,}/g, " ").trim();
  // Count by code points so emoji aren't double-counted, then clamp defensively.
  return [...s].length > max ? "\u0000TOO_LONG" : s;
}

// ───────────── accounts ─────────────

const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "root", "system", "sysadmin", "mod", "moderator", "moderators", "staff", "support",
  "help", "official", "sawyer", "sawyerburner", "sawyer_burner", "burner", "security", "api", "img",
  "login", "logout", "signup", "register", "settings", "profile", "rules", "terms", "about", "null", "undefined",
  "anonymous", "everyone", "here", "me", "you", "cloudflare",
]);

export function validateUsername(input: unknown): string {
  const username = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX)
    throw new ApiError(400, `Username must be ${USERNAME_MIN}–${USERNAME_MAX} characters.`);
  if (!USERNAME_PATTERN.test(username)) throw new ApiError(400, "Username can only use letters, numbers and underscores.");
  if (/^_+$/.test(username)) throw new ApiError(400, "Username needs at least one letter or number.");
  if (RESERVED_USERNAMES.has(username)) throw new ApiError(400, "That username is reserved.");
  if (findSlur(username.replace(/_/g, " ")) || findSlur(username.replace(/_/g, "")))
    throw new ApiError(400, "Pick a different username.");
  return username;
}

export function validatePassword(password: unknown, confirm: unknown, username: string): string {
  if (typeof password !== "string") throw new ApiError(400, "Password is required.");
  if (password.length < PASSWORD_MIN) throw new ApiError(400, `Password must be at least ${PASSWORD_MIN} characters.`);
  if (password.length > PASSWORD_MAX) throw new ApiError(400, `Password must be at most ${PASSWORD_MAX} characters.`);
  if (password !== confirm) throw new ApiError(400, "Passwords don't match.");
  if (password.toLowerCase().includes(username)) throw new ApiError(400, "Password can't contain your username.");
  if (/^(.)\1+$/.test(password) || ["password", "12345678", "123456789", "qwertyuiop", "11111111"].includes(password.toLowerCase()))
    throw new ApiError(400, "That password is too easy to guess.");
  return password;
}

// ───────────── slurs ─────────────
// Patterns are ROT13-encoded so the source isn't a wall of slurs. They run against
// individual normalised tokens (leetspeak folded, punctuation stripped), which avoids
// the classic substring false positives ("Scunthorpe problem").

const rot13 = (s: string) => s.replace(/[a-z]/g, (ch) => String.fromCharCode(((ch.charCodeAt(0) - 97 + 13) % 26) + 97));
const SLUR_PATTERNS = [
  "(^|[^f])a+v+t+t+(r+e+|n+|h+u+)",
  "^a+v+t+(t+|u+)(r+e+|n+|n+u+|h+u+|n+m+)f*$",
  "^s+n+t+(t+b+g+|t+v+g+|t+l+|f+)?f*$",
  "^x+v+x+r+f*$",
  "^f+c+v+p+x*f*$",
  "^p+u+v+a+x+f*$",
  "^t+b+b+x+f*$",
  "^j+r+g+o+n+p+x+f*$",
  "^g+e+n+a+a+(l+|v+r+f+)$",
  "^e+r+g+n+e+q+(f+|r+q+)?$",
  "^q+l+x+r+f*$",
  "^p+b+b+a+f*$",
  "^o+r+n+a+r+e+f*$",
  "^(e+n+t+|g+b+j+r+y+)u+r+n+q+f*$",
].map((p) => new RegExp(rot13(p)));

const LEET: Record<string, string> = { "0": "o", "1": "i", "!": "i", "|": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "9": "g", "6": "g", "8": "b" };

function tokens(text: string): string[] {
  const folded = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[0-9!|@$]/g, (ch) => LEET[ch] ?? ch);
  const words = folded.split(/\s+/).map((w) => w.replace(/[^a-z]/g, "")).filter(Boolean);
  // Also rejoin runs of single letters ("n i g g ...") into one token.
  const joined: string[] = [];
  let run = "";
  for (const w of words) {
    if (w.length === 1) run += w;
    else {
      if (run.length > 2) joined.push(run);
      run = "";
    }
  }
  if (run.length > 2) joined.push(run);
  return [...words, ...joined];
}

function findSlur(text: string): boolean {
  return tokens(text).some((t) => SLUR_PATTERNS.some((re) => re.test(t)));
}

// ───────────── threats, doxxing, links ─────────────

const THREATS = [
  /\bk\s*y\s*s\b/i,
  /\bkill\s+(your|ur|yo)\s*self\b/i,
  /\b(hope|wish)\s+(you|u)\s+(die|get\s+(killed|shot|raped))\b/i,
  /\bi\s*('?ll|\s+will|\s*'?m\s+(going|gonna)\s+to|\s*'?m\s+gonna|\s+am\s+(going\s+to|gonna))\s+(kill|shoot|stab|murder|rape|hurt|beat|find|jump)\b/i,
  /\b(i|we)\s+know\s+where\s+(you|u|he|she|they)\s+(live|lives|work|works|go\s+to\s+school)\b/i,
  /\b(shoot|bomb|blow)\s+up\s+(your|ur|the|his|her|their)\s+(house|school|work|job)\b/i,
  /\bwatch\s+(your|ur)\s+back\b/i,
  /\b(rape|raping)\b/i,
];

const MINORS_SEXUAL = /\b(child|children|kid|kids|minor|minors|underage|little\s+(girl|boy)|\d{1,2}\s*(yo|y\/o|yrs?\s+old|years?\s+old))\b[\s\S]{0,40}\b(sexy|hot|nudes?|naked|sex|horny|thicc|fine\s+as)\b|\b(sexy|hot|nudes?|naked|sex|horny)\b[\s\S]{0,40}\b(child|kid|minor|underage|little\s+(girl|boy)|\d{1,2}\s*(yo|y\/o|years?\s+old))\b/i;

const PII: Array<[RegExp, string]> = [
  [/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, "email addresses"],
  [/\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/, "ID numbers"],
  [/\b\d{1,6}\s+(?:[a-z0-9.'-]+\s+){1,3}(?:st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|ct|court|way|pl|place|ter|terrace|cir|circle|hwy|highway|pkwy|parkway|apt|unit)\b/i, "addresses"],
  [/\b(lives?|living|stays?)\s+(at|on)\s+\d/i, "addresses"],
  [/\b(address|number|phone|cell|password|passcode|pw|pin|login|ssn|social\s+security)\s+(is|=|:)/i, "private info"],
  [/\b(home|house)\s+address\b/i, "addresses"],
];

const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(com|net|org|io|gg|co|xyz|ly|me|tv|app|link|ru|info|biz|site|online|shop|us|uk|to|cc)\b)/i;

function hasPhoneNumber(text: string): boolean {
  const candidates = text.match(/\+?\d[\d\s().-]{7,}\d/g) ?? [];
  return candidates.some((m) => {
    const digits = m.replace(/\D/g, "").length;
    return digits >= 10 && digits <= 15;
  });
}

/** Returns a user-facing rejection message, or null if the text is allowed. */
export function moderationProblem(text: string): string | null {
  if (hasPhoneNumber(text)) return "No phone numbers. Keep the burns funny, not personal.";
  for (const [re, what] of PII) if (re.test(text)) return `No ${what}. Doxxing gets you banned.`;
  if (LINK.test(text)) return "No links in burns. Say it with your chest.";
  if (THREATS.some((re) => re.test(text))) return "Threats aren't roasts. That one's not going up.";
  if (MINORS_SEXUAL.test(text)) return "That crosses a hard line. Not allowed.";
  if (findSlur(text)) return "Slurs aren't funny. Try being clever instead.";
  return null;
}

export function validateComment(input: unknown): string {
  const body = cleanText(input, COMMENT_MAX);
  if (!body) throw new ApiError(400, "Your burn is empty.");
  if (body.startsWith("\u0000")) throw new ApiError(400, `Burns max out at ${COMMENT_MAX} characters.`);
  const problem = moderationProblem(body);
  if (problem) throw new ApiError(422, problem);
  return body;
}

export function validateCaption(input: unknown): string | null {
  const caption = cleanText(input, CAPTION_MAX, { multiline: false });
  if (!caption) return null;
  if (caption.startsWith("\u0000")) throw new ApiError(400, `Captions max out at ${CAPTION_MAX} characters.`);
  const problem = moderationProblem(caption);
  if (problem) throw new ApiError(422, problem);
  return caption;
}
