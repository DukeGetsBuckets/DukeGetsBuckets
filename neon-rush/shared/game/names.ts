// Name sanitization and a small profanity filter shared by the client, Worker and Durable Objects.

const BLOCKED = ['fuck', 'shit', 'bitch', 'cunt', 'nigg', 'fag', 'retard', 'dick', 'cock', 'pussy', 'whore', 'slut', 'asshole', 'bastard', 'damn', 'hitler', 'nazi', 'rape', 'penis', 'vagina', 'porn', 'sex'];

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };

export function normalizeForFilter(s: string): string {
  return s.toLowerCase().split('').map((c) => LEET[c] ?? c).join('').replace(/[^a-z]/g, '');
}

export function containsProfanity(s: string): boolean {
  const n = normalizeForFilter(s);
  return BLOCKED.some((w) => n.includes(w));
}

export const NAME_MIN = 3;
export const NAME_MAX = 16;
export const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

/** Returns a cleaned display name or null if invalid. */
export function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/\s+/g, '_');
  if (!NAME_RE.test(s)) return null;
  if (containsProfanity(s)) return null;
  return s;
}

/** Cleans chat text: trims, limits length, masks profanity. */
export function cleanChat(raw: unknown, max = 120): string {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
  s = s.split(/(\s+)/).map((w) => (containsProfanity(w) ? '*'.repeat(Math.min(w.length, 8)) : w)).join('');
  return s;
}
