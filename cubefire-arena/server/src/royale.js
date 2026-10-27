// ======================================================================
// Battle royale. One Durable Object runs them all: everyone queued at a start time is in the same
// match, and several can be running at once (Doug can start one while another is going).
//
// Every game keeps a "hub" socket to it (GET /ws?room=royale) for:
//   - duo parties: invite a friend, accept, join a friend's party, leave ({t: "invite" | "accept" | "decline" | "join" | "leaveparty"})
//   - the schedule: a battle royale every 20 minutes (:00, :20, :40), or when Doug starts one.
//     You can queue any time; ranked lobbies pause from 2 minutes before until 1 minute after
//     each start (they ask this object for the times at /sched)
//   - queueing ({t: "queue" | "unqueue"}): a duo, or a solo player who gets a random partner.
//     Everyone playing ranked at a start time is put in too ({t: "where", in: "ranked"} from their game)
//   - the match itself: player states are relayed (near players every update, far ones less
//     often), loot is claimed first come first served, and the last team with someone standing wins
// It only starts with at least 2 teams (else the queued stay queued for the next) and holds up to 50 players.
// BR_TEST=1 (local testing) runs one every 4 minutes, starts with a single team, and keeps
// solo players on their own teams (so two test devices can fight); BR_PAIR=1 pairs them anyway.
// ======================================================================
import { badName } from "./names.js";
const MIN = 60000;
export function brConfig(env) {
  const minTeams = Number(env && env.BR_MIN_TEAMS);
  if (env && env.BR_TEST === "1") return { every: 4 * MIN, open: 90000, stop: 45000, resume: 30000, minTeams: minTeams || 1, test: true };
  // one every 20 minutes (:00, :20, :40), and whenever Doug starts one; you can queue for the next one any time
  return { every: 20 * MIN, open: 20 * MIN, stop: 2 * MIN, resume: MIN, minTeams: minTeams || 2, test: false };
}
const MAX_PLAYERS = 150, SLOTS = 80;           // up to 150 players; team spawn slots on the map (the game page has the same 80)
const NEAR = 110, FAR_EVERY = 5;               // full-rate updates within NEAR blocks, every 5th one beyond
const HIDDEN = 220, HIDDEN_EVERY = 15;         // past the fog (nobody can see them): one update a second, for the map
const GONE_MS = 2 * MIN, MATCH_MAX = 25 * MIN;  // a player gone (or frozen) this long is out; a match never runs longer
const AWAY_MS = 20000, STORM_AWAY_MS = 20000;   // a player we haven't heard from in 20 s who is left out in the storm for 20 s is out
const LATE_MS = 100000;                          // a battle royale this new still takes players who queue (before the storm forms)
const SEEN_MS = 60000;
const SPLIT_AT = 80, FINAL_AT = 20;             // more than 80 players: two halves; when 20 are left between them, they meet in one final
const RANKED_ONLY = ["snipeaa"];                 // hacks that don't work in the battle royale: an account with only these is a normal player here
const DROP_MS = 30000;                           // a connection we haven't heard from in 30 s is dead (games ping every few seconds): it's closed
const SILENT_MS = 2 * MIN;                         // in a match, a game that sends nothing this long is out (a game that's playing sends many times a second)                           // a queued game heard from this recently is put in at the start
const MAP = 448;                               // the royale map is MAP x MAP blocks

function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const accounts = env => env.ACCOUNTS.get(env.ACCOUNTS.idFromName("all"));
const cleanName = s => { const n = String(s || "").replace(/[^\w .'!-]/g, "").trim().slice(0, 16); return badName(n) ? "Player" : n; };   // no bad words in names
// The storm: each phase waits, then shrinks the circle to a smaller one inside it. Times are
// seconds from the start of the match; dps is damage per second outside the circle.
export function stormPlan(seed, test) {
  const r = rng(seed), k = test ? 0.35 : 1;
  const steps = [[100, 70, 210, 1], [70, 60, 130, 2], [55, 50, 75, 4], [45, 40, 38, 6], [35, 35, 16, 8], [25, 30, 0, 10]];
  let x = MAP / 2, z = MAP / 2, rad = 320, t = 0;
  const out = [];
  for (const [wait, shrink, nr, dps] of steps) {
    const room = Math.max(0, rad - nr) * (out.length ? 1 : 0.55), a = r() * Math.PI * 2, d = Math.sqrt(r()) * room;
    const nx = clamp(x + Math.cos(a) * d, 20 + nr * 0.3, MAP - 20 - nr * 0.3), nz = clamp(z + Math.sin(a) * d, 20 + nr * 0.3, MAP - 20 - nr * 0.3);
    const t0 = t + wait * k, t1 = t0 + shrink * k;
    out.push({ t0: Math.round(t0), t1: Math.round(t1), x0: Math.round(x), z0: Math.round(z), r0: Math.round(rad), x1: Math.round(nx), z1: Math.round(nz), r1: nr, dps });
    x = nx; z = nz; rad = nr; t = t1;
  }
  return out;
}

// Where the storm circle is at a moment of the match (the game works it out the same way)
function stormAt(storm, secs) {
  let x = MAP / 2, z = MAP / 2, r = 999;
  if (storm.length) { x = storm[0].x0; z = storm[0].z0; r = storm[0].r0; }
  for (const p of storm) {
    if (secs < p.t0) break;
    if (secs < p.t1) { const k = (secs - p.t0) / Math.max(1, p.t1 - p.t0); return { x: p.x0 + (p.x1 - p.x0) * k, z: p.z0 + (p.z1 - p.z0) * k, r: p.r0 + (p.r1 - p.r0) * k }; }
    x = p.x1; z = p.z1; r = p.r1;
  }
  return { x, z, r };
}

export class Royale {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.cfg = brConfig(env);
    this.atts = new Map();        // socket -> attachment (cached)
    this.outq = new Map();        // socket -> player updates waiting to go out together
    this.flushT = null;
    this.wsById = new Map();      // player id -> their socket
    this.seen = new Map();        // player id -> last message time
    this.matches = new Map();     // match id -> the match (only one runs at a time)
    this.afterMatch = false;      // a start came while a match was still going: the next one starts a minute after it ends
    this.savedAt = 0;
    this.splitAt = Number(env && env.BR_SPLIT) || SPLIT_AT; this.finalAt = Number(env && env.BR_FINAL) || FINAL_AT;   // (smaller for local tests)
    this.start = 0;               // the next battle royale's start time
    this.cancelledAt = 0;         // start time of the last one cancelled for too few teams
    this.infoT = null;
    this.wokeAt = Date.now();     // when this object came back into memory (pings since then say who's really here)
    this.departed = new Map();    // player id -> {party, queued, ...} kept 10 minutes after their connection drops
    this.invites = new Map();     // account -> Map(inviter id -> {from, name, at}): invites wait here until answered
    this.pushedAt = new Map();    // "from>to" -> when we last sent that invite as a notification
    this.pushed = "";             // the last notification sent ("start:kind"), so each goes out once
    ctx.blockConcurrencyWhile(async () => {
      this.start = (await ctx.storage.get("start")) || 0; this.pushed = (await ctx.storage.get("pushed")) || "";
      // a start that isn't on the schedule, or further off than one gap (and wasn't set by Doug or the admin page), is from an old schedule
      if (this.start && (this.start % this.cfg.every !== (this.cfg.offset || 0) % this.cfg.every || this.start - Date.now() > this.cfg.every) && !(await ctx.storage.get("custom"))) this.start = 0;
      this.afterMatch = !!(await ctx.storage.get("afterMatch"));
      // the match carries on after this object restarts (an update to the server): everyone has 2 minutes to reconnect
      const one = await ctx.storage.get("match"), list = (await ctx.storage.get("matches")) || (one ? [one] : []), now = Date.now();
      for (const sm of list) {
        if (!(now < sm.deadline)) continue;
        const m = { ...sm, last: new Map(sm.players.filter(([, P]) => P.p).map(([id, P]) => [id, { p: P.p }])), teams: new Map(sm.teams), players: new Map(sm.players), taken: new Set(sm.taken) };
        for (const P of m.players.values()) { P.gone = now; P.lastAt = now; P.n = 0; P.stormAt = 0; }
        this.matches.set(m.id, m);
      }
    });
  }
  // Close connections that went quiet without saying goodbye (an iPad that went to sleep, the app swiped
  // away): otherwise they pile up and every message goes out to all of them. A player who was in a match
  // keeps their place and gets back in when their game reconnects.
  dropSilent() {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.att(ws); if (!a) continue;
      if (a.replaced || a.gone) { try { ws.close(4006, "Closed"); } catch {} continue; }
      if (now - (this.seen.get(a.id) || this.wokeAt) > DROP_MS) { try { ws.close(4006, "Timed out"); } catch {} this.leave(ws); }
    }
  }
  saveMatch(force) {
    const now = Date.now();
    if (!this.matches.size) { this.ctx.storage.delete("matches").catch(() => {}); this.ctx.storage.delete("match").catch(() => {}); return; }
    if (!force && now - this.savedAt < 5000) return;
    this.savedAt = now;
    const list = [...this.matches.values()].map(m => ({ id: m.id, at: m.at, seed: m.seed, storm: m.storm, deadline: m.deadline, pair: m.pair || null, half: m.half || 0, teams: [...m.teams], taken: [...m.taken],
      players: [...m.players].map(([id, P]) => [id, { team: P.team, bs: P.bs, name: P.name, acc: P.acc, gone: 0, n: 0, p: (m.last.get(id) || {}).p || null }]) }));
    this.ctx.storage.put("matches", list).catch(() => {}); this.ctx.storage.delete("match").catch(() => {});
  }
  // A big battle royale runs as two halves on the same island (same storm, same loot): these count both
  pairOf(m) { return m.pair ? this.matches.get(m.pair) || null : null; }
  totals(m) {
    const all = [m, this.pairOf(m)].filter(Boolean);
    return { teams: all.reduce((s, x) => s + x.teams.size, 0), alive: all.reduce((s, x) => s + [...x.teams.values()].filter(T => !T.out).length, 0),
      left: all.reduce((s, x) => s + [...x.players.values()].filter(P => P.bs !== "out").length, 0) };
  }
  // The final: once 20 players are left between the two halves (or one half is down to its last team),
  // everyone still in goes into one match, right where they are
  maybeMerge(m) {
    const o = this.pairOf(m); if (!o) { m.pair = null; return false; }
    const t = this.totals(m), aliveIn = x => [...x.teams.values()].filter(T => !T.out).length;
    if (t.left > this.finalAt && aliveIn(m) > 1 && aliveIn(o) > 1) return false;
    const A = (m.half || 0) <= (o.half || 0) ? m : o, B = A === m ? o : m;
    for (const [tid, T] of B.teams) A.teams.set(tid, T);
    for (const [id, P] of B.players) A.players.set(id, P);
    for (const [id, d] of B.last) A.last.set(id, d);
    for (const i of B.taken) A.taken.add(i);
    A.pair = null; A.half = 0; A.final = true;
    this.matches.delete(B.id);
    for (const id of B.players.keys()) { const h = this.byId(id); if (h && h.a.inMatch === B.id) this.setAtt(h.ws, { ...this.att(h.ws), inMatch: A.id }); }
    const n = this.totals(A);
    const msg = JSON.stringify({ t: "brmerge", teams: n.teams, alive: n.alive, left: n.left, taken: [...A.taken], players: [...A.players].map(([pid, q]) => ({ id: pid, name: q.name, team: q.team })) });
    for (const id of A.players.keys()) { const h = this.byId(id); if (h) this.send(h.ws, msg); }
    this.saveMatch(true);
    this.checkTeams(A);
    return true;
  }
  att(ws) { let a = this.atts.get(ws); if (a === undefined) { a = ws.deserializeAttachment() || null; this.atts.set(ws, a); } return a; }
  setAtt(ws, a) {
    const old = this.atts.get(ws);
    this.atts.set(ws, a); try { ws.serializeAttachment(a); } catch {}
    if (a && a.id && (old ? old.party : undefined) !== a.party) {        // your duo is kept even through a server update
      if (a.party) this.ctx.storage.put("pty:" + a.id, a.party).catch(() => {}); else this.ctx.storage.delete("pty:" + a.id).catch(() => {});
    }
  }
  hubs() { const out = []; for (const ws of this.ctx.getWebSockets()) { const a = this.att(ws); if (a && !a.replaced && !a.gone) out.push({ ws, a }); } return out; }
  byId(id) {
    let ws = this.wsById.get(id);
    if (!ws) { for (const s of this.ctx.getWebSockets()) { const a = this.att(s); if (a && a.id === id && !a.replaced && !a.gone) { ws = s; this.wsById.set(id, s); break; } } }
    const a = ws && this.att(ws); return a && !a.replaced && !a.gone ? { ws, a } : null;
  }
  send(ws, m) { if (this.outq.has(ws)) this.flushOne(ws); try { ws.send(typeof m === "string" ? m : JSON.stringify(m)); } catch {} }
  // Player updates during a match go out in batches (one message every ~50 ms with everything since
  // the last one) instead of one message per update: with 50 players that's thousands fewer a second.
  // Anything else sent to that player first sends what's waiting, so the order stays the same.
  sendSoon(ws, out) {
    const q = this.outq.get(ws); if (q) q.push(out); else this.outq.set(ws, [out]);
    if (!this.flushT) this.flushT = setTimeout(() => { this.flushT = null; for (const w of [...this.outq.keys()]) this.flushOne(w); }, 50);
  }
  flushOne(ws) {
    const q = this.outq.get(ws); this.outq.delete(ws); if (!q || !q.length) return;
    try { ws.send(q.length === 1 ? q[0] : '{"t":"sb","l":[' + q.join(",") + "]}"); } catch {}
  }

  // ---- schedule
  nextSlot(after) {
    const c = this.cfg, off = c.offset || 0;
    return Math.max(c.first || 0, Math.ceil((after + 1000 - off) / c.every) * c.every + off);
  }
  ensureStart() {
    const now = Date.now();
    if (!this.start || now > this.start + 5000) { this.start = this.nextSlot(now); this.ctx.storage.put("start", this.start).catch(() => {}); this.ctx.storage.put("custom", false).catch(() => {}); }
  }
  times() {
    const ev = Number(this.env.BR_AT) || 0;                  // a one-off battle royale at this time (a deploy setting)
    if (ev && ev > Date.now() - 5000 && this.lastStart !== ev && this.start !== ev) this.start = ev;
    this.ensureStart();
    const s = this.start, c = this.cfg;
    return { start: s, open: s - c.open, stop: s - c.stop, resume: s + c.resume };
  }
  phase() { return Date.now() >= this.times().open ? "queue" : "idle"; }
  matchOf(a) { return a && a.inMatch ? this.matches.get(a.inMatch) || null : null; }
  queueCount() {
    const q = this.hubs().filter(h => h.a.queued || h.a.in === "ranked"), parties = new Map();
    for (const h of q) { const k = h.a.party || h.a.id; parties.set(k, (parties.get(k) || 0) + 1); }
    let duos = 0, solos = 0; for (const n of parties.values()) { if (n >= 2) duos++; else solos++; }
    return { teams: duos + (this.pairSolos() ? Math.ceil(solos / 2) : solos), players: q.length };
  }
  pairSolos() { return !this.cfg.test || this.env.BR_PAIR === "1"; }
  info() {
    const t = this.times(), q = this.queueCount();
    let live = 0; for (const m of this.matches.values()) live += m.players.size;
    const events = new Set([...this.matches.values()].map(m => m.at)).size;           // two halves are one battle royale
    return { t: "brinfo", now: Date.now(), ...t, ph: this.phase(), teams: q.teams, players: q.players, minTeams: this.cfg.minTeams, maxPlayers: MAX_PLAYERS, test: this.cfg.test,
      joinable: !!this.joinable(), closeAt: Number(this.env.CLOSE_AT) || 0, closedMsg: this.env.CLOSED_MSG || "", match: null, afterMatch: this.afterMatch && this.matches.size > 0, live: events, livePlayers: live, cancelled: this.cancelledAt && this.cancelledAt === this.lastStart ? true : false };
  }
  broadcastInfo(now) {
    if (now) { clearTimeout(this.infoT); this.infoT = null; const out = JSON.stringify(this.info()); for (const h of this.hubs()) this.send(h.ws, out); return; }
    if (this.infoT) return;
    this.infoT = setTimeout(() => this.broadcastInfo(true), 1000);
  }
  // Notifications to everyone with notifications on: 15 minutes before, when the queue opens
  // (5 before) and a last call 1 minute before. Not overnight (10 pm to 7 am Eastern).
  // Battle royales every few minutes: one reminder every half hour instead, 2 minutes before.
  // Every 20 to 59 minutes: one reminder per battle royale, 5 minutes before.
  pushPlan() {
    const t = this.times(), c = this.cfg;
    if (t.start === (Number(this.env.BR_AT) || -1)) return [["ev0", t.start - 3 * MIN], ["ev1", t.start - 70000], ["ev2", t.start - 25000]];   // the special one: lots of reminders
    if (c.every < 20 * MIN) return t.start % (30 * MIN) === 0 || c.test ? [["soon", t.start - 2 * MIN]] : [];
    if (c.every < 60 * MIN) return [["open", t.start - 5 * MIN]];
    return [["15", t.start - 15 * MIN], ["open", t.start - 5 * MIN], ["last", t.start - MIN]].filter(([k, at]) => !c.test || k !== "15");
  }
  quietHours() {
    let h = 12; try { h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(new Date())); } catch {}
    return h >= 22 || h < 7;
  }
  async sendPushes(now) {
    // the moment the game opens (OPEN_AT): tell everyone with notifications on
    const openAt = Number(this.env.OPEN_AT) || 0;
    if (openAt && now >= openAt && now - openAt < 3 * MIN && !this.env.CLOSED && (await this.ctx.storage.get("openPushed")) !== openAt) {
      await this.ctx.storage.put("openPushed", openAt);
      const until = Number(this.env.CLOSE_AT) ? " until " + new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(Number(this.env.CLOSE_AT))) : "";
      let offset = 0;                                        // everyone, a page of subscribers at a time
      for (let i = 0; i < 30 && offset != null; i++) {
        try { offset = (await (await accounts(this.env).fetch("https://internal/internal/pushall", { method: "POST", body: JSON.stringify({ title: String(this.env.OPEN_TITLE || "🔥 Cubefire Arena is OPEN!"), body: String(this.env.OPEN_BODY || `Play now${until}! Tap to jump in.`), url: "/", tag: "cfa-br", offset }) })).json()).next; }
        catch { break; }
      }
    }
    if (!this.hacksGoneAsked) {                              // once: tell everyone with notifications on that hacks are gone for good
      this.hacksGoneAsked = true;
      try {
        if ((await (await accounts(this.env).fetch("https://internal/internal/hacksgone", { method: "POST", body: "{}" })).json()).go) {
          let offset = 0;
          for (let i = 0; i < 30 && offset != null; i++) offset = (await (await accounts(this.env).fetch("https://internal/internal/pushall", { method: "POST", body: JSON.stringify({ title: "🚫 Hacks are gone for good!", body: "Nobody can use hacks in Cubefire any more. Every match is fair. Come play!", url: "/", tag: "cfa-news", offset }) })).json()).next;
        }
      } catch {}
    }
    if (openAt && now < openAt) return;                      // no reminders before the game opens
    const t = this.times();
    for (const [kind, at] of this.pushPlan()) {
      if (now < at || now - at > 3 * MIN || this.sentKinds(t.start).includes(kind)) continue;
      this.markPushed(t.start, kind);
      const closeAt = Number(this.env.CLOSE_AT) || 0;
      if (this.quietHours() || this.env.BR_PUSH === "0" || this.env.CLOSED || (closeAt && now >= closeAt - 5 * MIN)) continue;   // no reminders while closed (or about to close)   // no reminders while the game is closed
      const q = this.queueCount(), skip = this.hubs().filter(h => h.a.queued && h.a.acc).map(h => h.a.acc);   // already queued: no need
      const msg = kind.startsWith("ev") ? { title: kind === "ev2" ? "🚨 BATTLE ROYALE STARTING NOW! GET ON!" : kind === "ev1" ? "🔥 Battle Royale in 1 minute! Get on now!" : "⚔️ Cubefire is back! Battle Royale at 2:47!", body: "Everyone's jumping in. Open Cubefire and tap Queue!" }
        : kind === "soon" ? { title: "⚔️ Battle Royale in 2 minutes!", body: `A new one every 5 minutes${q.teams ? ` · ${q.teams} team${q.teams === 1 ? "" : "s"} queued` : ""}. Grab your duo and tap to jump in!` }
        : kind === "15" ? { title: "⚔️ Battle Royale in 15 minutes!", body: "Get your duo ready and queue up. Last duo standing wins 500 RP and the crown 👑" }
        : kind === "open" ? { title: "🔥 Battle Royale in 5 minutes!", body: `Starts in 5 minutes${q.teams ? ` · ${q.teams} team${q.teams === 1 ? "" : "s"} queued` : ""}. Tap to queue with your duo!` }
        : { title: "🚨 LAST CALL: Battle Royale in 1 minute!", body: `${q.teams ? `${q.teams} team${q.teams === 1 ? "" : "s"} queued. ` : ""}Tap now to jump in!` };
      let offset = 0;
      for (let i = 0; i < 30 && offset != null; i++) {
        try { const r = await (await accounts(this.env).fetch("https://internal/internal/pushall", { method: "POST", body: JSON.stringify({ ...msg, url: "/?br=1", tag: "cfa-br", skip, offset }) })).json(); offset = r.next; }
        catch { break; }
      }
    }
  }
  sentKinds(start) { return this.pushed.startsWith(start + ":") ? this.pushed.slice(String(start).length + 1).split(",") : []; }
  markPushed(start, kind) { this.pushed = start + ":" + [...this.sentKinds(start), kind].join(","); this.ctx.storage.put("pushed", this.pushed).catch(() => {}); }
  schedule() {
    const now = Date.now(), t = this.times(), wake = [];
    for (const [kind, at] of this.pushPlan()) if (now - at < 3 * MIN && !this.sentKinds(t.start).includes(kind)) wake.push(Math.max(at, now + 500));
    if (t.open > now) wake.push(t.open);
    if (t.start > now) wake.push(t.start);
    for (const m of this.matches.values()) wake.push(Math.min(m.deadline, now + 5000));   // keep an eye on the matches
    if (wake.length) this.ctx.storage.setAlarm(Math.min(...wake)).catch(() => {});
  }
  async alarm() {
    const now = Date.now();
    await this.sendPushes(now);                              // reminders first (before a start moves on to the next one)
    if (this.start && now >= this.start - 200 && this.lastStart !== this.start) this.launch();
    for (const m of [...this.matches.values()]) { this.sweepMatch(m); if (this.matches.has(m.id) && now > m.deadline) this.endMatch(m, null); }
    this.saveMatch(false);
    this.dropSilent();
    this.broadcastInfo(true);
    this.schedule();
    await this.sendPushes(now);
  }

  // ---- internal calls (ranked lobbies, the admin dashboard)
  async internal(request) {
    const path = new URL(request.url).pathname;
    if (path === "/sched") {
      const t = this.times(), c = this.cfg, windows = [];
      if (c.every >= 20 * MIN) {                              // ranked only pauses for battle royales far apart
        windows.push({ stop: t.stop, resume: t.resume });
        if (this.lastStart && this.cancelledAt !== this.lastStart) windows.push({ stop: this.lastStart - c.stop, resume: this.lastStart + c.resume });
      }
      return Response.json({ ...t, windows, match: this.matches.size > 0 });
    }
    if (path === "/poke") { await this.alarm(); return Response.json({ ok: true }); }   // the worker's once-a-minute wake-up
    if (path === "/status") { const i = this.info(); return Response.json({ ...i, hubs: this.hubs().length }); }
    if (path === "/admin-now") {
      const now = Date.now();
      this.start = now + Math.min(this.cfg.open, 2 * MIN); this.ctx.storage.put("start", this.start).catch(() => {}); this.ctx.storage.put("custom", true).catch(() => {});
      this.broadcastInfo(true); this.schedule();
      return Response.json({ ok: true, start: this.start });
    }
    return Response.json({ error: "Unknown" }, { status: 404 });
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return this.internal(request);
    const url = new URL(request.url);
    const want = String(url.searchParams.get("pid") || "").replace(/[^a-z0-9]/gi, "").slice(0, 16);
    const id = want.length >= 8 ? want : crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    let carry = {};
    const dep = this.departed.get(id) || await this.ctx.storage.get("dep:" + id).catch(() => null);
    if (dep && Date.now() - dep.at < 10 * MIN) { const { at, ...rest } = dep; carry = rest; }   // came back after the connection dropped
    this.departed.delete(id); this.ctx.storage.delete("dep:" + id).catch(() => {});
    for (const ws of this.ctx.getWebSockets()) {             // the same game reconnecting takes over its old place
      const o = this.att(ws);
      if (o && o.id === id && !o.replaced) { carry = { party: o.party, queued: o.queued, inMatch: o.inMatch, team: o.team, acc: o.acc, disp: o.disp, name: o.name, skin: o.skin, color: o.color, perks: o.perks, perksKnown: o.perksKnown, bw: o.bw }; this.setAtt(ws, { ...o, replaced: true }); try { ws.close(4005, "Reconnected"); } catch {} }
    }
    if (!carry.party) { const p = await this.ctx.storage.get("pty:" + id).catch(() => null); if (p) carry.party = p; }   // your duo, saved
    if (!this.matchOf(carry)) for (const m of this.matches.values()) if (m.players.has(id)) { carry.inMatch = m.id; carry.team = m.players.get(id).team; carry.queued = false; }   // you're still in the battle royale
    this.ctx.acceptWebSocket(server);
    this.setAtt(server, { id, ...carry }); this.wsById.set(id, server);
    this.seen.set(id, Date.now());
    const cm = this.matchOf(carry);
    if (cm) { const P = cm.players.get(id); if (P) { P.gone = 0; P.lastAt = Date.now(); } } else if (carry.inMatch) carry.inMatch = null;
    this.send(server, { t: "welcome", id });
    this.send(server, this.info());
    if (carry.party) this.sendParty(carry.party); else this.send(server, { t: "party", id: null, members: [] });   // the game always shows the duo the server really has
    if (cm) this.send(server, this.startMsg(cm, id));
    this.schedule();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) { try { this.onMessage(ws, message); } catch (e) { console.log("royale message error", e && e.message); } }
  webSocketClose(ws) { this.leave(ws); }
  webSocketError(ws) { this.leave(ws); }
  leave(ws) {
    const a = this.att(ws); if (!a || a.replaced || a.gone) return;
    this.setAtt(ws, { ...a, gone: true });
    if (this.wsById.get(a.id) === ws) this.wsById.delete(a.id);
    // a dropped connection (an iPad going to sleep, a Wi-Fi blip) keeps your duo and your place in the
    // queue: the game reconnects with the same id and picks them back up
    const keep = { party: a.party, queued: a.queued, inMatch: a.inMatch, team: a.team, acc: a.acc, disp: a.disp, name: a.name, skin: a.skin, color: a.color, perks: a.perks, perksKnown: a.perksKnown, bw: a.bw, at: Date.now() };
    this.departed.set(a.id, keep); this.ctx.storage.put("dep:" + a.id, keep).catch(() => {});
    for (const [k, v] of this.departed) if (Date.now() - v.at > 10 * MIN) { this.departed.delete(k); this.ctx.storage.delete("dep:" + k).catch(() => {}); }
    if (a.party) this.sendParty(a.party);
    const lm = this.matchOf(a); if (lm) { const P = lm.players.get(a.id); if (P) P.gone = Date.now(); }
    this.broadcastInfo();
  }

  onMessage(ws, message) {
    if (typeof message !== "string" || message.length > 6000) return;
    let a = this.att(ws); if (!a || a.replaced) return;
    let d; try { d = JSON.parse(message); } catch { return; }
    if (!d || typeof d !== "object") return;
    this.seen.set(a.id, Date.now());
    if (d.t === "ping") return this.send(ws, { t: "pong", c: d.c });
    if (d.t === "hello") {                                     // who you are and how you look (for your duo's screen)
      a = { ...a, name: cleanName(d.name) || "Player", skin: typeof d.skin === "string" ? d.skin.slice(0, 24) : null, color: clamp(Math.floor(Number(d.color) || 0), 0, 7), rk: clamp(Math.floor(Number(d.rk) || 0), 0, 99999) };
      this.setAtt(ws, a);
      if (typeof d.token === "string" && d.token) {
        accounts(this.env).fetch("https://internal/internal/who", { method: "POST", body: JSON.stringify({ token: d.token }) }).then(r => r.json()).then(r => {
          const cur = this.att(ws); if (!cur || cur.gone) return;
          if (r.banned) { this.send(ws, { t: "blocked", why: "You're banned from Cubefire Arena." }); try { ws.close(4003, "Banned"); } catch {} this.leave(ws); return; }   // a banned account
          this.setAtt(ws, { ...cur, perks: Array.isArray(r.perks) ? r.perks.filter(k => !RANKED_ONLY.includes(k)) : [], perksKnown: true, bw: Math.max(0, Math.floor(Number(r.bw) || 0)), acc: r.acc || null, disp: r.display && !badName(r.display) ? r.display : r.display ? "Player" : null });
          this.send(ws, { t: "you", acc: r.acc || null });
          if (cur.party) this.sendParty(cur.party);
          if (r.acc) this.deliverInvites(ws, r.acc);
        }).catch(() => {});
      } else this.setAtt(ws, { ...a, acc: null, disp: null, perks: [], perksKnown: true });   // not signed in: no hacks
      if (a.party) this.sendParty(a.party);
      return;
    }
    if (d.t === "where") { this.setAtt(ws, { ...a, in: ["ranked", "party", "bots", "royale", "menu"].includes(d.in) ? d.in : "menu" }); return; }   // what the game is doing
    if (d.t === "invite") return this.invite(ws, a, String(d.to || "").trim().toLowerCase());
    if (d.t === "accept") return this.accept(ws, a, String(d.from || ""));
    if (d.t === "decline") { this.dropInvite(a.acc, String(d.from || "")); const h = this.byId(String(d.from || "")); if (h) this.send(h.ws, { t: "declined", by: a.disp || a.name }); return; }
    if (d.t === "leaveparty") { if (a.party) this.leaveParty(ws, a, false); return; }
    if (d.t === "join") return this.join(ws, a, String(d.to || "").trim().toLowerCase());
    if (d.t === "online") return this.online(ws, Array.isArray(d.accs) ? d.accs.slice(0, 200).map(x => String(x).toLowerCase()) : []);
    if (d.t === "dougstart") return this.dougStart(ws, a);
    if (d.t === "dougnow") return this.dougNow(ws, a);
    if (d.t === "queue") return this.queue(ws, a, true);
    if (d.t === "unqueue") return this.queue(ws, a, false);
    const m = this.matchOf(a);
    if (m) {
      if (d.t === "take") return this.take(m, a, d);
      if (!d.t) return this.relay(m, ws, a, d);
    }
  }

  // ---- duo parties
  members(pid) { return pid ? this.hubs().filter(h => h.a.party === pid) : []; }
  sendParty(pid) {
    const m = this.members(pid);
    const list = m.map(h => ({ id: h.a.id, name: h.a.disp || h.a.name || "Player", acc: h.a.acc || null, skin: h.a.skin || null, color: h.a.color || 0, rk: h.a.rk || 0, queued: !!h.a.queued }));
    for (const h of m) this.send(h.ws, { t: "party", id: pid, members: list });
  }
  // An invite waits for 10 minutes: it shows on every screen your friend has the game open on,
  // reaches them when they open it (or sign in), and comes as a notification if the game is closed
  invite(ws, a, to) {
    if (!a.acc) return this.send(ws, { t: "invited", ok: false, msg: "Sign in to invite friends" });
    if (!to || to === a.acc) return this.send(ws, { t: "invited", ok: false, msg: "Pick a friend to invite" });
    if (this.members(a.party).length >= 2) return this.send(ws, { t: "invited", ok: false, msg: "Your party is full (duos only)" });
    const inv = { from: a.id, name: a.disp || a.name || "A friend", at: Date.now() };
    if (!this.invites.has(to)) this.invites.set(to, new Map());
    this.invites.get(to).set(a.id, inv);
    const targets = this.hubs().filter(h => h.a.acc === to);
    for (const h of targets) this.send(h.ws, { t: "invite", ...inv });
    if (targets.length) return this.send(ws, { t: "invited", ok: true, msg: "Invite sent! It shows on their screen now" });
    const k = a.acc + ">" + to, last = this.pushedAt.get(k) || 0;
    if (Date.now() - last > 60000) {
      this.pushedAt.set(k, Date.now());
      accounts(this.env).fetch("https://internal/internal/pushinvite", { method: "POST", body: JSON.stringify({ from: a.acc, to }) }).catch(() => {});
    }
    this.send(ws, { t: "invited", ok: true, msg: "They don't have the game open, so we sent a notification. The invite waits 10 minutes: they'll see it when they open the game (signed in)" });
  }
  deliverInvites(ws, acc) {
    const list = this.invites.get(acc); if (!list) return;
    for (const [id, inv] of list) { if (Date.now() - inv.at > 10 * MIN) list.delete(id); else this.send(ws, { t: "invite", ...inv }); }
  }
  dropInvite(acc, from) { const list = acc && this.invites.get(acc); if (list) { list.delete(from); if (!list.size) this.invites.delete(acc); } }
  // Join a friend's party (or start a duo with them) without waiting for an invite
  async join(ws, a, to) {
    if (!a.acc) return this.send(ws, { t: "invited", ok: false, msg: "Sign in to join your friends" });
    const host = this.hubs().filter(h => h.a.acc === to && h.ws !== ws).sort((x, y) => (y.a.party ? 1 : 0) - (x.a.party ? 1 : 0))[0];
    if (!host) return this.send(ws, { t: "invited", ok: false, msg: "That friend isn't online right now" });
    let ok = false;
    try { ok = !!(await (await accounts(this.env).fetch("https://internal/internal/isfriend", { method: "POST", body: JSON.stringify({ a: a.acc, b: to }) })).json()).ok; } catch {}
    if (!ok) return this.send(ws, { t: "invited", ok: false, msg: "You can only join your friends' parties" });
    const cur = this.att(ws); if (!cur || cur.gone) return;
    if (host.a.party && host.a.party === cur.party) return this.send(ws, { t: "invited", ok: true, msg: "You're already in their party" });
    this.accept(ws, cur, host.a.id);
    this.send(host.ws, { t: "invited", ok: true, msg: (cur.disp || cur.name || "A friend") + " joined your party" });
  }
  // Which of your friends have the game open, and whether they're in a party or a match
  online(ws, accs) {
    const on = {};
    for (const h of this.hubs()) if (h.a.acc && accs.includes(h.a.acc)) on[h.a.acc] = { party: this.members(h.a.party).length, match: !!this.matchOf(h.a) };
    this.send(ws, { t: "online", on });
  }
  accept(ws, a, from) {
    const host = this.byId(from);
    if (!host) return this.send(ws, { t: "invited", ok: false, msg: "That invite has expired" });
    if (this.matchOf(host.a) || this.matchOf(a)) return this.send(ws, { t: "invited", ok: false, msg: "They're in a battle royale right now" });
    let pid = host.a.party;
    if (!pid) { pid = host.a.id; this.setAtt(host.ws, { ...host.a, party: pid, queued: false }); }
    if (this.members(pid).filter(h => h.a.id !== a.id).length >= 2) return this.send(ws, { t: "invited", ok: false, msg: "That party is already full" });
    if (a.party && a.party !== pid) this.leaveParty(ws, a, false);
    this.dropInvite(a.acc, host.a.id);
    for (const h of this.members(pid)) this.setAtt(h.ws, { ...h.a, queued: false });   // a new duo queues again together
    this.setAtt(ws, { ...this.att(ws), party: pid, queued: false });
    this.sendParty(pid); this.broadcastInfo();
  }
  leaveParty(ws, a, closing) {
    const pid = a.party, rest = this.members(pid).filter(h => h.ws !== ws);
    if (!closing) this.setAtt(ws, { ...this.att(ws), party: null, queued: false });
    for (const h of rest) this.setAtt(h.ws, { ...h.a, queued: false, party: rest.length > 1 ? pid : null });
    if (!closing) this.send(ws, { t: "party", id: null, members: [] });
    if (rest.length > 1) this.sendParty(pid); else for (const h of rest) { this.send(h.ws, { t: "party", id: null, members: [] }); this.send(h.ws, { t: "queue", on: false, msg: "Your partner left the party" }); }
    this.broadcastInfo();
  }

  // Doug's button: a battle royale in 3 minutes. Every game gets pulled out of its match to the
  // battle royale screen and has to queue for it; everyone with notifications on hears about it.
  dougStart(ws, a) {
    if (a.acc !== "doug") return this.send(ws, { t: "invited", ok: false, msg: "Only Doug can do that" });
    const now = Date.now();
    this.start = now + 3 * MIN; this.ctx.storage.put("start", this.start).catch(() => {}); this.ctx.storage.put("custom", true).catch(() => {});
    const call = JSON.stringify({ t: "brcall", start: this.start, now, by: a.disp || "Doug" });
    for (const h of this.hubs()) this.send(h.ws, call);
    this.broadcastInfo(true); this.schedule();
    accounts(this.env).fetch("https://internal/internal/pushall", { method: "POST", body: JSON.stringify({ title: "⚔️ Doug started a Battle Royale!", body: "It starts in 3 minutes. Tap to queue with your duo!", url: "/?br=1", tag: "cfa-br", offset: 0 }) }).catch(() => {});
  }
  // Doug's other button: start one right now with everyone queued (no 5-team minimum)
  dougNow(ws, a) {
    if (a.acc !== "doug") return this.send(ws, { t: "invited", ok: false, msg: "Only Doug can do that" });
    const mine = a.party ? this.members(a.party) : [{ ws, a }];         // Doug (and his duo) are in it too
    for (const h of mine) if (!this.matchOf(h.a)) this.setAtt(h.ws, { ...this.att(h.ws), queued: true });
    const q = this.queueCount();
    if (this.matches.size) {                                  // only one at a time: join it if it just started, else the next one
      for (const h of mine) if (!this.matchOf(h.a)) { this.joinPartner(h.ws, h.a, mine) || this.joinRunning(mine.filter(x => !this.matchOf(x.a))); break; }
      return this.send(ws, { t: "invited", ok: true, msg: this.matchOf(this.att(ws)) ? "You're in the battle royale that's going now" : "A battle royale is going right now. The next one starts 1 minute after it ends" });
    }
    this.start = Date.now(); this.ctx.storage.put("start", this.start).catch(() => {}); this.ctx.storage.put("custom", true).catch(() => {});
    this.launch(true);
    this.send(ws, { t: "invited", ok: true, msg: `Battle royale started with ${q.players} player${q.players === 1 ? "" : "s"}` });
    this.schedule();
  }
  // ---- the queue
  queue(ws, a, on) {
    const group = a.party ? this.members(a.party) : [{ ws, a }];
    if (on && this.joinPartner(ws, a, group)) return;      // your duo is already in a battle royale that just started: you go in on their team
    if (on && group.some(h => this.matchOf(h.a))) return this.send(ws, { t: "queue", on: false, msg: "Your duo is still in a battle royale. Queue when it's over" });
    if (on && this.joinRunning(group)) return;              // one just started: you're in it now
    if (on && this.phase() !== "queue" && !this.matches.size) return this.send(ws, { t: "queue", on: false, msg: "The queue isn't open yet" });
    if (on && this.matches.size) for (const h of group) this.send(h.ws, { t: "br", ph: "waiting", msg: "A battle royale is going right now, and it's too far along to jump in. You're queued for the next one" });
    for (const h of group) { this.setAtt(h.ws, { ...h.a, queued: on }); this.send(h.ws, { t: "queue", on }); }
    if (a.party) this.sendParty(a.party);
    this.broadcastInfo();
  }
  // The newest battle royale, if it's young enough to still take players
  joinable() {
    const now = Date.now(); let best = null;
    let total = 0; for (const m of this.matches.values()) total += m.players.size;
    if (total >= MAX_PLAYERS) return null;
    for (const m of this.matches.values()) if (now - m.at < LATE_MS && (!best || m.at > best.at || (m.at === best.at && m.players.size < best.players.size))) best = m;   // the newest, and its smaller half
    return best;
  }
  // Your duo got in without you (your iPad was asleep at the start): join them, on their team
  joinPartner(ws, a, group) {
    const mate = group.find(h => h.a.id !== a.id && this.matchOf(h.a)); if (!mate) return false;
    const m = this.matchOf(mate.a), T = m && m.teams.get(mate.a.team);
    if (!T || T.out || T.ids.length >= 2 || T.ids.includes(a.id) || Date.now() - m.at > LATE_MS) return false;
    T.ids.push(a.id);
    m.players.set(a.id, { team: mate.a.team, bs: "up", gone: 0, n: 0, name: a.disp || a.name || "Player", acc: a.acc || null });
    this.setAtt(ws, { ...this.att(ws), inMatch: m.id, team: mate.a.team, queued: false }); this.saveMatch(true);
    this.send(ws, this.startMsg(m, a.id));
    const news = JSON.stringify({ t: "brteams", teams: this.totals(m).teams, alive: this.totals(m).alive, players: [{ id: a.id, name: m.players.get(a.id).name, team: mate.a.team }] });
    for (const id of m.players.keys()) if (id !== a.id) { const h = this.byId(id); if (h) this.send(h.ws, news); }
    return true;
  }
  // Put a duo (or a solo player) into a battle royale that's already started, on a free spawn slot
  joinRunning(group) {
    const m = this.joinable(); let total = 0; for (const x of this.matches.values()) total += x.players.size;
    if (!m || total + Math.min(2, group.length) > MAX_PLAYERS) return false;
    const used = new Set([...m.teams.values()].map(T => T.slot)), slot = [...Array(SLOTS).keys()].find(i => !used.has(i));
    if (slot == null) return false;
    let n = m.teams.size + 1; while ([...this.matches.values()].some(x => x.teams.has("T" + n))) n++;   // team names are never shared between halves
    const tid = "T" + n, list = group.slice(0, 2);
    m.teams.set(tid, { ids: list.map(h => h.a.id), slot, out: false, place: 0 });
    for (const h of list) {
      m.players.set(h.a.id, { team: tid, bs: "up", gone: 0, n: 0, name: h.a.disp || h.a.name || "Player", acc: h.a.acc || null });
      this.setAtt(h.ws, { ...this.att(h.ws), inMatch: m.id, team: tid, queued: false });
    }
    this.saveMatch(true);
    for (const h of list) this.send(h.ws, this.startMsg(m, h.a.id));
    const news = JSON.stringify({ t: "brteams", teams: this.totals(m).teams, alive: this.totals(m).alive, players: list.map(h => ({ id: h.a.id, name: m.players.get(h.a.id).name, team: tid })) });
    for (const id of m.players.keys()) if (!list.some(h => h.a.id === id)) { const h = this.byId(id); if (h) this.send(h.ws, news); }   // everyone already in: a new team joined
    this.broadcastInfo(true);
    return true;
  }

  // ---- starting (or cancelling) a match
  launch(force) {
    const now = Date.now(); this.lastStart = this.start;
    if (this.matches.size) {                                  // only one battle royale at a time: everyone queued joins it if it's new, or waits for it to end
      for (const h of this.hubs()) if (h.a.queued && !this.matchOf(h.a)) { const g = h.a.party ? this.members(h.a.party) : [h]; if (!g.some(x => this.matchOf(x.a))) this.joinRunning(g); }
      this.afterMatch = true; this.ctx.storage.put("afterMatch", true).catch(() => {});
      const msg = JSON.stringify({ t: "br", ph: "waiting", msg: "A battle royale is still going. You stay queued: the next one starts 1 minute after it ends" });
      for (const h of this.hubs()) if (h.a.queued && !this.matchOf(h.a)) this.send(h.ws, msg);
      this.broadcastInfo(true);
      return;
    }
    // everyone queued, and everyone playing ranked right now: they're pulled in (with a random partner if they have no duo).
    // fresh: heard from lately (a game we haven't heard from since this object woke up counts from the wake-up).
    // A duo stays together as long as one of them is fresh; a partner whose iPad is asleep is swept out of the match if they never show up.
    const fresh = h => now - (this.seen.get(h.a.id) || this.wokeAt) < SEEN_MS;
    const q = this.hubs().filter(h => (h.a.queued || h.a.in === "ranked") && !this.matchOf(h.a));
    const parties = new Map(), solos = [];
    for (const h of q) { if (h.a.party) { if (!parties.has(h.a.party)) parties.set(h.a.party, []); parties.get(h.a.party).push(h); } else if (fresh(h)) solos.push(h); }
    const teams = [];
    for (const list of parties.values()) {
      if (!list.some(fresh)) continue;                       // nobody on this duo is really here
      teams.push(list.slice(0, 2));                          // a duo, or one of a duo: never given a random partner, so the other can join them late
    }
    const r = rng(now & 0x7fffffff);
    for (let i = solos.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [solos[i], solos[j]] = [solos[j], solos[i]]; }
    const per = this.pairSolos() ? 2 : 1;
    for (let i = 0; i < solos.length; i += per) teams.push(solos.slice(i, i + per));   // random partners (a last odd one plays alone)
    if (teams.length < (force ? 1 : this.cfg.minTeams)) {                  // not enough teams: everyone queued stays queued for the next one
      this.cancelledAt = this.start;
      const next = Math.round(this.cfg.every / MIN), many = this.cfg.every < 60 * MIN;
      const msg = `Only ${teams.length} team${teams.length === 1 ? "" : "s"} queued (${this.cfg.minTeams} needed), so it didn't start. ` + (many ? `You stay queued for the next one in ${next} minutes` : `Next one in ${next} minutes`);
      if (teams.length) for (const h of this.hubs()) this.send(h.ws, { t: "br", ph: "cancelled", teams: teams.length, need: this.cfg.minTeams, msg, stay: many && !!h.a.queued });
      if (!many) for (const h of q) this.setAtt(h.ws, { ...this.att(h.ws), queued: false });
      this.start = this.nextSlot(now); this.ctx.storage.put("start", this.start).catch(() => {}); this.ctx.storage.put("custom", false).catch(() => {});
      for (const pid of parties.keys()) this.sendParty(pid);
      return;
    }
    for (const h of q) this.setAtt(h.ws, { ...this.att(h.ws), queued: false });
    const playing = [], full = []; let count = 0;                        // up to 150 players (and as many teams as the spawn slots hold)
    for (const t of teams) { if (count + t.length <= MAX_PLAYERS && playing.length < SLOTS * (count + t.length > this.splitAt ? 2 : 1)) { playing.push(t); count += t.length; } else full.push(t); }
    for (const t of full) for (const h of t) this.send(h.ws, { t: "queue", on: false, msg: `The battle royale is full (${MAX_PLAYERS} players). Try the next one!` });
    const seed = Math.floor(r() * 2147483646) + 1, slots = Array.from({ length: SLOTS }, (_, i) => i);
    for (let i = slots.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [slots[i], slots[j]] = [slots[j], slots[i]]; }
    // more than 80 players: two halves on the same island (same storm and loot), teams split between them
    const halves = count > this.splitAt ? 2 : 1, storm = stormPlan(seed, this.cfg.test), ms = [];
    for (let k = 0; k < halves; k++) ms.push({ id: "M" + now + (halves > 1 ? "-" + (k + 1) : ""), half: halves > 1 ? k + 1 : 0, last: new Map(), at: now, seed, storm, teams: new Map(), players: new Map(), taken: new Set(), deadline: now + MATCH_MAX });
    if (halves > 1) { ms[0].pair = ms[1].id; ms[1].pair = ms[0].id; }
    playing.forEach((list, ti) => {
      const tid = "T" + (ti + 1), m = ms[ti % halves];
      m.teams.set(tid, { ids: list.map(h => h.a.id), slot: slots[Math.floor(ti / halves)], out: false, place: 0 });
      for (const h of list) {
        m.players.set(h.a.id, { team: tid, bs: "up", gone: 0, n: 0, name: h.a.disp || h.a.name || "Player", acc: h.a.acc || null });
        this.setAtt(h.ws, { ...this.att(h.ws), inMatch: m.id, team: tid, queued: false });
      }
    });
    for (const m of ms) this.matches.set(m.id, m);
    this.saveMatch(true);
    for (const m of ms) for (const id of m.players.keys()) { const h = this.byId(id); if (h) this.send(h.ws, this.startMsg(m, id)); }
    this.start = this.nextSlot(now + 30000); this.ctx.storage.put("start", this.start).catch(() => {}); this.ctx.storage.put("custom", false).catch(() => {});
    this.broadcastInfo(true);
  }
  startMsg(m, id) {
    const P = m.players.get(id), T = m.teams.get(P.team);
    return { t: "brstart", now: Date.now(), at: m.at, seed: m.seed, storm: m.storm, team: P.team, slot: T.slot, bs: P.bs, pos: (m.last.get(id) || {}).p || null, mates: T.ids.filter(x => x !== id),
      players: [...m.players].map(([pid, q]) => ({ id: pid, name: q.name, team: q.team })), teams: this.totals(m).teams, alive: this.totals(m).alive, half: m.half || 0, finalAt: this.finalAt, taken: [...m.taken] };
  }

  // ---- during the match
  relay(m, ws, a, d) {
    const P = m.players.get(a.id); if (!P) return;
    // hacks are gone: a game still sending them is an old or changed copy, so it has to update
    // (right after connecting, before we've looked up the account's hacks, they're just ignored: no kick)
    if (!(a.perks || []).length && (d.iv === 1 || d.nk || d.hx === 1 || (Array.isArray(d.hits) && d.hits.some(h => h && h.nk)))) {
      if (!a.perksKnown) {
      delete d.iv; delete d.nk; d.hx = 0; if (Array.isArray(d.hits)) d.hits = d.hits.filter(h => h && !h.nk);
      } else { this.send(ws, { t: "update" }); try { ws.close(4001, "Update your game"); } catch {} return; }
    }
    if (typeof d.n === "string" && badName(d.n)) d.n = "Player";
    d.bw = a.bw || 0;                                         // battle royale wins: from their account, not their game
    if (Array.isArray(d.hits)) d.hits = d.hits.filter(h => h && !h.nk);
    P.gone = 0; P.n++; P.lastAt = Date.now();
    m.last.set(a.id, d);
    const bs = ["up", "down", "out"].includes(d.bs) ? d.bs : P.bs, changed = bs !== P.bs;
    if (changed) { P.bs = bs; this.checkTeams(m); if (!this.matches.has(m.id)) return; }
    const out = JSON.stringify({ t: "st", id: a.id, d }), me = this.viewPos(m, a.id);
    // far players get every few updates, but a knock or elimination reaches everyone (the kill feed)
    const far = changed || P.n % FAR_EVERY === 0, hidden = changed || P.n % HIDDEN_EVERY === 0;
    const hitT = new Set(Array.isArray(d.hits) ? d.hits.map(h => h && String(h.t)) : []);
    if (d.dth && typeof d.dth.by === "string") hitT.add(d.dth.by);
    for (const [qid, Q] of m.players) {
      if (qid === a.id) continue;
      const h = this.byId(qid); if (!h) continue;
      const p = this.viewPos(m, qid);
      const dist = me && p ? Math.hypot(me[0] - p[0], me[2] - p[2]) : 0;
      if (Q.team === P.team || hitT.has(qid) || !me || !p || dist < NEAR || (dist < HIDDEN ? far : hidden)) this.sendSoon(h.ws, out);
    }
  }
  viewPos(m, id) {
    const P = m.players.get(id), d = m.last.get(id);
    if (P && P.bs === "out") for (const mate of m.teams.get(P.team).ids) { const q = m.players.get(mate), md = m.last.get(mate); if (mate !== id && q && q.bs !== "out" && md && Array.isArray(md.p)) return md.p; }   // watching their duo
    return d && Array.isArray(d.p) ? d.p : null;
  }
  take(m, a, d) {
    const i = Math.floor(Number(d.i)); if (!(i >= 0 && i < 5000) || m.taken.has(i)) return;
    m.taken.add(i);
    const out = JSON.stringify({ t: "taken", i, by: a.id });
    for (const id of m.players.keys()) { const h = this.byId(id); if (h) this.send(h.ws, out); }
  }
  // A dropped connection or a game in the background (an iPad locked for a moment, a Wi-Fi blip) doesn't
  // knock you out: you keep your place and pick up where you were when the game reconnects. You're only
  // out if you're away 2 minutes, or away while the storm has you for 20 seconds (it would have got you).
  sweepMatch(m) {
    const now = Date.now(), S = stormAt(m.storm, (now - m.at) / 1000); let changed = false;
    for (const [id, P] of m.players) {
      if (P.bs === "out") continue;
      const away = P.gone ? now - P.gone : now - (P.lastAt || m.at), d = m.last.get(id), p = d && Array.isArray(d.p) ? d.p : null;
      if (away < AWAY_MS) { P.stormAt = 0; continue; }
      const inStorm = p && Math.hypot(p[0] - S.x, p[2] - S.z) > S.r;
      P.stormAt = inStorm ? P.stormAt || now : 0;
      if (away > (P.gone ? GONE_MS : SILENT_MS) || (P.stormAt && now - P.stormAt > STORM_AWAY_MS)) { P.bs = "out"; changed = true; }
    }
    if (changed) this.checkTeams(m);
  }
  checkTeams(m) {
    if (!this.matches.has(m.id)) return;
    const tell = msg => { const out = JSON.stringify(msg); for (const id of m.players.keys()) { const h = this.byId(id); if (h) this.send(h.ws, out); } };
    // a team is still in while anyone on it is standing (both knocked down = out, like Fortnite)
    for (const [tid, T] of m.teams) {
      if (T.out) continue;
      if (!T.ids.some(id => m.players.get(id).bs === "up")) {
        T.out = true; T.place = this.totals(m).alive + 1;                // place among both halves
        tell({ t: "teamout", team: tid, place: T.place, alive: T.place - 1 });
      }
    }
    const o = this.pairOf(m);
    if (o) { const n = this.totals(m), out = JSON.stringify({ t: "bralive", alive: n.alive, teams: n.teams }); for (const id of o.players.keys()) { const h = this.byId(id); if (h) this.send(h.ws, out); } }   // the other half's count
    if (this.maybeMerge(m)) return;
    const alive = [...m.teams].filter(([, T]) => !T.out);
    this.saveMatch(true);
    if (alive.length <= 1 && m.teams.size > 1) this.endMatch(m, alive.length ? alive[0][0] : null);
    else if (alive.length === 0) this.endMatch(m, null);
    this.broadcastInfo();
  }
  endMatch(m, winTeam) {
    if (!this.matches.has(m.id)) return;
    const T = winTeam ? m.teams.get(winTeam) : null, ids = T ? T.ids : [];
    const names = ids.map(id => m.players.get(id).name), accts = ids.map(id => m.players.get(id).acc).filter(Boolean);
    const out = JSON.stringify({ t: "brend", team: winTeam, ids, names });
    for (const id of m.players.keys()) {
      const h = this.byId(id);
      if (h) { this.send(h.ws, out); if (h.a.inMatch === m.id) this.setAtt(h.ws, { ...this.att(h.ws), inMatch: null, team: null }); }
    }
    this.matches.delete(m.id); this.saveMatch(true);
    if (this.afterMatch) {                                   // a start was held up by this match: the next one is in a minute
      this.afterMatch = false; this.ctx.storage.put("afterMatch", false).catch(() => {});
      this.start = Date.now() + MIN; this.ctx.storage.put("start", this.start).catch(() => {}); this.ctx.storage.put("custom", true).catch(() => {});
    }
    if (T) {                                                 // the winners: Royale Champion skin, and the crown until the next win
      const crown = { t: "crown", names, accts, at: Date.now() };
      accounts(this.env).fetch("https://internal/internal/brwin", { method: "POST", body: JSON.stringify({ accts, names }) }).catch(() => {});
      const c = JSON.stringify(crown); for (const h of this.hubs()) this.send(h.ws, c);
    }
    this.ensureStart(); this.broadcastInfo(true); this.schedule();
  }
}
