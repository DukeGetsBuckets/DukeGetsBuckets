// Small HTTP helpers shared by the API handlers: JSON responses, error type,
// request body parsing with a size cap, and best-effort in-memory rate limiting.

export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string, code = 'bad_request') => new ApiError(400, message, code);
export const unauthorized = (message = 'Sign in required', code = 'unauthorized') => new ApiError(401, message, code);
export const forbidden = (message = 'Forbidden', code = 'forbidden') => new ApiError(403, message, code);
export const notFound = (message = 'Not found', code = 'not_found') => new ApiError(404, message, code);
export const conflict = (message: string, code = 'conflict') => new ApiError(409, message, code);
export const tooMany = (message = 'Too many requests', code = 'rate_limited') => new ApiError(429, message, code);

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

/** Parses a JSON request body (object or array), rejecting bodies larger than 2 MB. */
export async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new ApiError(413, 'Request body too large', 'payload_too_large');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError(413, 'Request body too large', 'payload_too_large');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('Malformed JSON body', 'bad_json');
  }
}

export function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Returns a trimmed string of at most `max` chars, or null when missing / not a string. */
export function str(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** Returns an integer clamped to [lo, hi], or null when not a finite number. */
export function int(v: unknown, lo: number, hi: number): number | null {
  if (typeof v === 'string' && v.trim() !== '') v = Number(v);
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
}

/* ---------- in-memory rate limiting (best effort, per isolate) ---------- */

interface Bucket { count: number; resetAt: number }
const buckets = new Map<string, Bucket>();
let lastSweep = 0;

/** Fixed-window counter; returns true when the call is allowed. */
export function rateLimit(bucket: string, key: string, max: number, windowMs: number, now = Date.now()): boolean {
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  const id = `${bucket}:${key}`;
  const b = buckets.get(id);
  if (!b || b.resetAt <= now) {
    buckets.set(id, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= max) return false;
  b.count++;
  return true;
}

/** Minimum interval between two calls with the same key; returns true when allowed. */
const lastCall = new Map<string, number>();
export function throttle(bucket: string, key: string, minIntervalMs: number, now = Date.now()): boolean {
  const id = `${bucket}:${key}`;
  const prev = lastCall.get(id);
  if (prev !== undefined && now - prev < minIntervalMs) return false;
  lastCall.set(id, now);
  if (lastCall.size > 10_000) {
    for (const [k, t] of lastCall) if (now - t > 60_000) lastCall.delete(k);
  }
  return true;
}

/* ---------- ids / codes ---------- */

/** Alphabet without ambiguous characters (no 0/O, 1/I/L). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function randomCode(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let s = '';
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function uuid(): string { return crypto.randomUUID(); }

export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
