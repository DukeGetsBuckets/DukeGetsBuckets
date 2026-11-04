import { hashString } from '../math';

/** UTC day key YYYY-MM-DD. */
export function dayKey(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}
export function dayEndsAt(ts = Date.now()): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
/** ISO-like week key YYYY-Www (weeks start Monday UTC). */
export function weekKey(ts = Date.now()): string {
  const d = new Date(ts);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
  const jan4 = Date.UTC(new Date(monday).getUTCFullYear(), 0, 4);
  const jan4Day = (new Date(jan4).getUTCDay() + 6) % 7;
  const week1Monday = jan4 - jan4Day * 86400000;
  let week = Math.floor((monday - week1Monday) / (7 * 86400000)) + 1;
  let year = new Date(monday).getUTCFullYear();
  if (week < 1) { year -= 1; week = 52; }
  return `${year}-W${String(week).padStart(2, '0')}`;
}
export function weekEndsAt(ts = Date.now()): number {
  const d = new Date(ts);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 7);
}
/** Deterministic daily track selection over the official track ids (avoids repeating yesterday). */
export function dailyTrackId(key: string, trackIds: string[]): string {
  const n = trackIds.length;
  if (n === 0) return '';
  const h = hashString('daily:' + key);
  let idx = h % n;
  const prev = new Date(key + 'T00:00:00Z').getTime() - 86400000;
  const prevKey = dayKey(prev);
  const prevIdx = hashString('daily:' + prevKey) % n;
  if (idx === prevIdx && n > 1) idx = (idx + 1 + (h >>> 8) % (n - 1)) % n;
  return trackIds[idx];
}
