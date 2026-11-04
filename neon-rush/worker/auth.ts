// Guest + account authentication, sessions and the /api/me endpoints.
// Tokens: 32 random bytes (hex) stored as SHA-256 hashes with a 180-day expiry.
// Passwords: PBKDF2-SHA256, 100k iterations, 16-byte salt (WebCrypto).

import type { Env } from './index';
import type { AuthResponse, PlayerProfile } from '../shared/api';
import { sanitizeName } from '../shared/game/names';
import { sanitizeCarConfig } from '../shared/game/carConfig';
import { one, run, isUniqueViolation, type PlayerRow } from './db';
import { badRequest, unauthorized, conflict, tooMany, forbidden, asObject, clientIp, rateLimit, toHex, fromHex } from './http';
import { buildProfile, fromRow, insertPlayer, savePlayer, type Player } from './players';
import { checkCarOwnership } from './progression';
import type { Ctx } from './api';

export const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 100_000;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 72;
const AUTH_RATE_MAX = 30;           // auth calls per IP per window
const AUTH_RATE_WINDOW_MS = 60_000;
const LAST_SEEN_WRITE_INTERVAL = 60_000;

/* ---------- crypto ---------- */

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return toHex(new Uint8Array(digest));
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const saltBuf = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer;
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBuf, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2:${PBKDF2_ITERATIONS}:${toHex(salt)}:${toHex(hash)}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, iterStr, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'pbkdf2' || !iterStr || !saltHex || !hashHex) return false;
  const iterations = Number(iterStr);
  if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 1_000_000) return false;
  const computed = await pbkdf2(password, fromHex(saltHex), iterations);
  const expected = fromHex(hashHex);
  if (computed.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed[i] ^ expected[i];
  return diff === 0;
}

/* ---------- sessions ---------- */

export async function createSession(env: Env, playerId: string, now = Date.now()): Promise<string> {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  await run(env.DB, 'INSERT INTO sessions (token_hash, player_id, created_at, expires_at) VALUES (?, ?, ?, ?)', await sha256Hex(token), playerId, now, now + SESSION_TTL_MS);
  return token;
}

function bearerToken(request: Request): string | null {
  const h = request.headers.get('authorization') ?? '';
  const m = /^Bearer\s+([A-Za-z0-9._\-]{16,256})$/i.exec(h.trim());
  return m ? m[1] : null;
}

async function playerForToken(env: Env, token: string | null): Promise<Player | null> {
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await one<PlayerRow & { expires_at: number }>(
    env.DB,
    'SELECT p.*, s.expires_at FROM sessions s JOIN players p ON p.id = s.player_id WHERE s.token_hash = ?',
    hash,
  );
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at <= now) {
    await run(env.DB, 'DELETE FROM sessions WHERE token_hash = ?', hash);
    return null;
  }
  const p = fromRow(row);
  if (now - p.lastSeen > LAST_SEEN_WRITE_INTERVAL) {
    p.lastSeen = now;
    await run(env.DB, 'UPDATE players SET last_seen = ? WHERE id = ?', now, p.id);
  }
  return p;
}

/** Returns the authenticated player or throws 401. */
export async function requireAuth(request: Request, env: Env): Promise<Player> {
  const p = await playerForToken(env, bearerToken(request));
  if (!p) throw unauthorized();
  return p;
}

export async function optionalAuth(request: Request, env: Env): Promise<Player | null> {
  try { return await playerForToken(env, bearerToken(request)); } catch { return null; }
}

/* ---------- helpers ---------- */

function guardRate(c: Ctx) {
  if (!rateLimit('auth', clientIp(c.request), AUTH_RATE_MAX, AUTH_RATE_WINDOW_MS)) throw tooMany('Too many sign-in attempts, try again in a minute');
}

function requireName(v: unknown): string {
  const name = sanitizeName(v);
  if (!name) throw badRequest('Names are 3-16 letters, digits or underscores and must be family friendly', 'invalid_name');
  return name;
}

function requirePassword(v: unknown): string {
  if (typeof v !== 'string' || v.length < PASSWORD_MIN || v.length > PASSWORD_MAX) throw badRequest(`Passwords are ${PASSWORD_MIN}-${PASSWORD_MAX} characters`, 'invalid_password');
  return v;
}

async function accountNameTaken(env: Env, name: string, exceptId: string | null): Promise<boolean> {
  const row = await one<{ id: string }>(env.DB, 'SELECT id FROM players WHERE name_lower = ? AND is_guest = 0', name.toLowerCase());
  return !!row && row.id !== exceptId;
}

async function authResponse(env: Env, p: Player): Promise<AuthResponse> {
  const token = await createSession(env, p.id);
  return { token, player: await buildProfile(env, p) };
}

/* ---------- handlers ---------- */

export async function authGuest(c: Ctx): Promise<AuthResponse> {
  guardRate(c);
  const body = asObject(await c.body());
  const name = requireName(body.name);
  const car = body.car !== undefined ? sanitizeCarConfig(body.car) : undefined;
  const p = await insertPlayer(c.env, { name, isGuest: true, car });
  return authResponse(c.env, p);
}

export async function authRegister(c: Ctx): Promise<AuthResponse> {
  guardRate(c);
  const body = asObject(await c.body());
  const name = requireName(body.name);
  const password = requirePassword(body.password);
  const guestToken = typeof body.guestToken === 'string' ? body.guestToken : null;

  const guest = guestToken ? await playerForToken(c.env, guestToken) : null;
  if (guestToken && !guest) throw unauthorized('Guest session expired, please sign in as a guest again', 'bad_guest_token');
  if (guest && !guest.isGuest) throw conflict('This profile already has an account', 'already_registered');
  if (await accountNameTaken(c.env, name, null)) throw conflict('That name is already taken', 'name_taken');

  const passwordHash = await hashPassword(password);
  try {
    if (guest) {
      // Upgrade the guest row in place: keeps id, records, xp, friends.
      guest.name = name;
      guest.isGuest = false;
      guest.passwordHash = passwordHash;
      guest.lastSeen = Date.now();
      await savePlayer(c.env, guest);
      return authResponse(c.env, guest);
    }
    const p = await insertPlayer(c.env, { name, isGuest: false, passwordHash });
    return authResponse(c.env, p);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('That name is already taken', 'name_taken');
    throw err;
  }
}

export async function authLogin(c: Ctx): Promise<AuthResponse> {
  guardRate(c);
  const body = asObject(await c.body());
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, '_') : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const row = name ? await one<PlayerRow>(c.env.DB, 'SELECT * FROM players WHERE name_lower = ? AND is_guest = 0', name.toLowerCase()) : null;
  const ok = row ? await verifyPassword(password, row.password_hash) : await verifyPassword(password, null);
  if (!row || !ok) throw unauthorized('Wrong name or password', 'bad_credentials');
  return authResponse(c.env, fromRow(row));
}

export async function getMe(c: Ctx): Promise<{ player: PlayerProfile }> {
  const p = await requireAuth(c.request, c.env);
  return { player: await buildProfile(c.env, p) };
}

export async function updateMe(c: Ctx): Promise<{ player: PlayerProfile }> {
  const p = await requireAuth(c.request, c.env);
  const body = asObject(await c.body());
  let changed = false;
  if (body.name !== undefined) {
    const name = requireName(body.name);
    if (name !== p.name) {
      if (!p.isGuest && (await accountNameTaken(c.env, name, p.id))) throw conflict('That name is already taken', 'name_taken');
      p.name = name;
      changed = true;
    }
  }
  if (body.car !== undefined) {
    const car = sanitizeCarConfig(body.car);
    const locked = checkCarOwnership(p, car);
    if (locked) throw forbidden(`You do not own ${locked}`, 'locked_item');
    p.car = car;
    changed = true;
  }
  if (changed) {
    try { await savePlayer(c.env, p); } catch (err) {
      if (isUniqueViolation(err)) throw conflict('That name is already taken', 'name_taken');
      throw err;
    }
  }
  return { player: await buildProfile(c.env, p) };
}
