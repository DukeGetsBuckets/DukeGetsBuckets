// ======================================================================
// Battle royale. One Durable Object runs it for everyone, so everybody is in the same match.
//
// Every game keeps a "hub" socket to it (GET /ws?room=royale) for:
//   - duo parties: invite a friend, accept, join a friend's party, leave ({t: "invite" | "accept" | "decline" | "join" | "leaveparty"})
//   - the schedule: a battle royale every hour on the half hour. The queue opens 5 minutes
//     before; ranked lobbies pause from 2 minutes before until 1 minute after the start
//     (they ask this object for the times at /sched)
//   - queueing ({t: "queue" | "unqueue"}): a duo, or a solo player who gets a random partner
//   - the match itself: player states are relayed (near players every update, far ones less
//     often), loot is claimed first come first served, and the last team with someone standing wins
// It only starts with at least 5 teams (else it's cancelled) and holds up to 25 duos.
// BR_TEST=1 (local testing) runs one every 4 minutes, starts with a single team, and keeps
// solo players on their own teams (so two test devices can fight); BR_PAIR=1 pairs them anyway.
// ======================================================================
const MIN = 60000;
export function brConfig(env) {
  const minTeams = Number(env && env.BR_MIN_TEAMS);
  if (env && env.BR_TEST === "1") return { every: 4 * MIN, open: 90000, stop: 45000, resume: 30000, minTeams: minTeams || 1, test: true };
  // every hour on the half hour (8:30, 9:30, ... in any US time zone); the first one is 8:30 am Eastern on Oct 22, 2026
  return { every: 60 * MIN, offset: 30 * MIN, first: Date.UTC(2026, 9, 22, 12, 30), open: 5 * MIN, stop: 2 * MIN, resume: MIN, minTeams: minTeams || 5, test: false };
}
const MAX_TEAMS = 25, SLOTS = 32;              // team spawn slots on the map (the game page has the same 32)
const NEAR = 110, FAR_EVERY = 5;               // full-rate updates within NEAR blocks, every 5th one beyond
const GONE_MS = 15000, MATCH_MAX = 25 * MIN;   // a player gone this long is out; a match never runs longer
const MAP = 320;                               // the royale map is MAP x MAP blocks

function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const accounts = env => env.ACCOUNTS.get(env.ACCOUNTS.idFromName("all"));
const cleanName = s => String(s || "").replace(/[^\w .'!-]/g, "").trim().slice(0, 16);
// The storm: each phase waits, then shrinks the circle to a smaller one inside it. Times are
// seconds from the start of the match; dps is damage per second outside the circle.
export function stormPlan(seed, test) {
  const r = rng(seed), k = test ? 0.35 : 1;
  const steps = [[90, 60, 150, 1], [60, 50, 95, 2], [50, 40, 55, 4], [40, 35, 28, 6], [30, 30, 12, 8], [20, 30, 0, 10]];
  let x = MAP / 2, z = MAP / 2, rad = 230, t = 0;
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

export class Royale {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.cfg = brConfig(env);
    this.atts = new Map();        // socket -> attachment (cached)
    this.wsById = new Map();      // player id -> their socket
    this.seen = new Map();        // player id -> last message time
    this.last = new Map();        // player id -> latest match state
    this.match = null;            // the match being played, if any
    this.start = 0;               // the next battle royale's start time
    this.cancelledAt = 0;         // start time of the last one cancelled for too few teams
    this.infoT = null;
    ctx.blockConcurrencyWhile(async () => { this.start = (await ctx.storage.get("start")) || 0; });
  }
  att(ws) { let a = this.atts.get(ws); if (a === undefined) { a = ws.deserializeAttachment() || null; this.atts.set(ws, a); } return a; }
  setAtt(ws, a) { this.atts.set(ws, a); try { ws.serializeAttachment(a); } catch {} }
  hubs() { const out = []; for (const ws of this.ctx.getWebSockets()) { const a = this.att(ws); if (a && !a.replaced && !a.gone) out.push({ ws, a }); } return out; }
  byId(id) {
    let ws = this.wsById.get(id);
    if (!ws) { for (const s of this.ctx.getWebSockets()) { const a = this.att(s); if (a && a.id === id && !a.replaced && !a.gone) { ws = s; this.wsById.set(id, s); break; } } }
    const a = ws && this.att(ws); return a && !a.replaced && !a.gone ? { ws, a } : null;
  }
  send(ws, m) { try { ws.send(typeof m === "string" ? m : JSON.stringify(m)); } catch {} }

  // ---- schedule
  nextSlot(after) {
    const c = this.cfg, off = c.offset || 0;
    return Math.max(c.first || 0, Math.ceil((after + 1000 - off) / c.every) * c.every + off);
  }
  ensureStart() {
    const now = Date.now();
    if (!this.start || (!this.match && now > this.start + 5000)) { this.start = this.nextSlot(now); this.ctx.storage.put("start", this.start).catch(() => {}); }
  }
  times() {
    this.ensureStart();
    const s = this.start, c = this.cfg;
    return { start: s, open: s - c.open, stop: s - c.stop, resume: s + c.resume };
  }
  phase() { if (this.match) return "match"; return Date.now() >= this.times().open ? "queue" : "idle"; }
  queueCount() {
    const q = this.hubs().filter(h => h.a.queued), parties = new Map();
    for (const h of q) { const k = h.a.party || h.a.id; parties.set(k, (parties.get(k) || 0) + 1); }
    let duos = 0, solos = 0; for (const n of parties.values()) { if (n >= 2) duos++; else solos++; }
    return { teams: duos + (this.pairSolos() ? Math.ceil(solos / 2) : solos), players: q.length };
  }
  pairSolos() { return !this.cfg.test || this.env.BR_PAIR === "1"; }
  info() {
    const t = this.times(), q = this.queueCount(), m = this.match;
    return { t: "brinfo", now: Date.now(), ...t, ph: this.phase(), teams: q.teams, players: q.players, minTeams: this.cfg.minTeams, maxTeams: MAX_TEAMS, test: this.cfg.test,
      match: m ? { at: m.at, alive: [...m.teams.values()].filter(x => !x.out).length, teams: m.teams.size } : null, cancelled: this.cancelledAt && this.cancelledAt === this.lastStart ? true : false };
  }
  broadcastInfo(now) {
    if (now) { clearTimeout(this.infoT); this.infoT = null; const out = JSON.stringify(this.info()); for (const h of this.hubs()) this.send(h.ws, out); return; }
    if (this.infoT) return;
    this.infoT = setTimeout(() => this.broadcastInfo(true), 1000);
  }
  schedule() {
    const now = Date.now(), t = this.times(), wake = [];
    if (t.open > now) wake.push(t.open);
    if (t.start > now) wake.push(t.start);
    if (this.match) wake.push(Math.min(this.match.deadline, now + 5000));   // keep an eye on the match
    if (wake.length) this.ctx.storage.setAlarm(Math.min(...wake)).catch(() => {});
  }
  async alarm() {
    const now = Date.now();
    if (!this.match && this.start && now >= this.start - 200 && this.lastStart !== this.start) this.launch();
    if (this.match) { this.sweepMatch(); if (this.match && now > this.match.deadline) this.endMatch(null); }
    this.broadcastInfo(true);
    this.schedule();
  }

  // ---- internal calls (ranked lobbies, the admin dashboard)
  async internal(request) {
    const path = new URL(request.url).pathname;
    if (path === "/sched") {
      const t = this.times(), c = this.cfg, windows = [{ stop: t.stop, resume: t.resume }];
      if (this.lastStart && this.cancelledAt !== this.lastStart) windows.push({ stop: this.lastStart - c.stop, resume: this.lastStart + c.resume });
      return Response.json({ ...t, windows, match: !!this.match });
    }
    if (path === "/status") { const i = this.info(); return Response.json({ ...i, hubs: this.hubs().length }); }
    if (path === "/admin-now") {
      if (this.match) return Response.json({ error: "A battle royale is already running" }, { status: 400 });
      const now = Date.now();
      this.start = now + Math.min(this.cfg.open, 2 * MIN); this.ctx.storage.put("start", this.start).catch(() => {});
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
    for (const ws of this.ctx.getWebSockets()) {             // the same game reconnecting takes over its old place
      const o = this.att(ws);
      if (o && o.id === id && !o.replaced) { carry = { party: o.party, queued: o.queued, inMatch: o.inMatch, team: o.team, acc: o.acc, disp: o.disp, name: o.name, skin: o.skin, color: o.color }; this.setAtt(ws, { ...o, replaced: true }); try { ws.close(4005, "Reconnected"); } catch {} }
    }
    this.ctx.acceptWebSocket(server);
    this.setAtt(server, { id, ...carry }); this.wsById.set(id, server);
    this.seen.set(id, Date.now());
    if (this.match && carry.inMatch) { const P = this.match.players.get(id); if (P) P.gone = 0; }
    this.send(server, { t: "welcome", id });
    this.send(server, this.info());
    if (carry.party) this.sendParty(carry.party);
    if (this.match && carry.inMatch) this.send(server, this.startMsg(id));
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
    if (a.party) this.leaveParty(ws, a, true);
    if (this.match && a.inMatch) { const P = this.match.players.get(a.id); if (P) P.gone = Date.now(); }
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
          this.setAtt(ws, { ...cur, acc: r.acc || null, disp: r.display || null });
          if (cur.party) this.sendParty(cur.party);
        }).catch(() => {});
      } else if (a.acc) this.setAtt(ws, { ...a, acc: null, disp: null });
      if (a.party) this.sendParty(a.party);
      return;
    }
    if (d.t === "invite") return this.invite(ws, a, String(d.to || "").trim().toLowerCase());
    if (d.t === "accept") return this.accept(ws, a, String(d.from || ""));
    if (d.t === "decline") { const h = this.byId(String(d.from || "")); if (h) this.send(h.ws, { t: "declined", by: a.disp || a.name }); return; }
    if (d.t === "leaveparty") { if (a.party) this.leaveParty(ws, a, false); return; }
    if (d.t === "join") return this.join(ws, a, String(d.to || "").trim().toLowerCase());
    if (d.t === "online") return this.online(ws, Array.isArray(d.accs) ? d.accs.slice(0, 200).map(x => String(x).toLowerCase()) : []);
    if (d.t === "queue") return this.queue(ws, a, true);
    if (d.t === "unqueue") return this.queue(ws, a, false);
    if (this.match && a.inMatch) {
      if (d.t === "take") return this.take(a, d);
      if (!d.t) return this.relay(ws, a, d);
    }
  }

  // ---- duo parties
  members(pid) { return pid ? this.hubs().filter(h => h.a.party === pid) : []; }
  sendParty(pid) {
    const m = this.members(pid);
    const list = m.map(h => ({ id: h.a.id, name: h.a.disp || h.a.name || "Player", acc: h.a.acc || null, skin: h.a.skin || null, color: h.a.color || 0, rk: h.a.rk || 0, queued: !!h.a.queued }));
    for (const h of m) this.send(h.ws, { t: "party", id: pid, members: list });
  }
  invite(ws, a, to) {
    if (!a.acc) return this.send(ws, { t: "invited", ok: false, msg: "Sign in to invite friends" });
    if (!to || to === a.acc) return this.send(ws, { t: "invited", ok: false, msg: "Pick a friend to invite" });
    if (this.members(a.party).length >= 2) return this.send(ws, { t: "invited", ok: false, msg: "Your party is full (duos only)" });
    const targets = this.hubs().filter(h => h.a.acc === to);
    if (!targets.length) return this.send(ws, { t: "invited", ok: false, msg: "That friend isn't online right now" });
    for (const h of targets) this.send(h.ws, { t: "invite", from: a.id, name: a.disp || a.name || "A friend" });
    this.send(ws, { t: "invited", ok: true, msg: "Invite sent" });
  }
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
    for (const h of this.hubs()) if (h.a.acc && accs.includes(h.a.acc)) on[h.a.acc] = { party: this.members(h.a.party).length, match: !!h.a.inMatch };
    this.send(ws, { t: "online", on });
  }
  accept(ws, a, from) {
    const host = this.byId(from);
    if (!host) return this.send(ws, { t: "invited", ok: false, msg: "That invite has expired" });
    if (host.a.inMatch || a.inMatch) return this.send(ws, { t: "invited", ok: false, msg: "They're in a battle royale right now" });
    let pid = host.a.party;
    if (!pid) { pid = host.a.id; this.setAtt(host.ws, { ...host.a, party: pid, queued: false }); }
    if (this.members(pid).filter(h => h.a.id !== a.id).length >= 2) return this.send(ws, { t: "invited", ok: false, msg: "That party is already full" });
    if (a.party && a.party !== pid) this.leaveParty(ws, a, false);
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

  // ---- the queue
  queue(ws, a, on) {
    if (on && this.match) return this.send(ws, { t: "queue", on: false, msg: "A battle royale is running. Queue for the next one when it opens" });
    if (on && this.phase() !== "queue") return this.send(ws, { t: "queue", on: false, msg: "The queue isn't open yet" });
    const group = a.party ? this.members(a.party) : [{ ws, a }];
    for (const h of group) { this.setAtt(h.ws, { ...h.a, queued: on }); this.send(h.ws, { t: "queue", on }); }
    if (a.party) this.sendParty(a.party);
    this.broadcastInfo();
  }

  // ---- starting (or cancelling) a match
  launch() {
    const now = Date.now(); this.lastStart = this.start;
    const q = this.hubs().filter(h => h.a.queued && !h.a.inMatch && now - (this.seen.get(h.a.id) || 0) < 20000);
    const parties = new Map(), solos = [];
    for (const h of q) { if (h.a.party) { if (!parties.has(h.a.party)) parties.set(h.a.party, []); parties.get(h.a.party).push(h); } else solos.push(h); }
    const teams = [];
    for (const list of parties.values()) { if (list.length >= 2) teams.push(list.slice(0, 2)); else solos.push(...list); }
    const r = rng(now & 0x7fffffff);
    for (let i = solos.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [solos[i], solos[j]] = [solos[j], solos[i]]; }
    const per = this.pairSolos() ? 2 : 1;
    for (let i = 0; i < solos.length; i += per) teams.push(solos.slice(i, i + per));   // random partners (a last odd one plays alone)
    for (const h of q) this.setAtt(h.ws, { ...this.att(h.ws), queued: false });
    if (teams.length < this.cfg.minTeams) {
      this.cancelledAt = this.start;
      const msg = `Battle royale cancelled: only ${teams.length} team${teams.length === 1 ? "" : "s"} queued (${this.cfg.minTeams} needed). Next one in ${Math.round(this.cfg.every / MIN)} minutes`;
      for (const h of this.hubs()) this.send(h.ws, { t: "br", ph: "cancelled", teams: teams.length, need: this.cfg.minTeams, msg });
      this.start = this.nextSlot(now); this.ctx.storage.put("start", this.start).catch(() => {});
      for (const pid of parties.keys()) this.sendParty(pid);
      return;
    }
    const playing = teams.slice(0, MAX_TEAMS);
    for (const t of teams.slice(MAX_TEAMS)) for (const h of t) this.send(h.ws, { t: "queue", on: false, msg: "The battle royale is full (25 teams). Try the next one!" });
    const seed = Math.floor(r() * 2147483646) + 1, slots = Array.from({ length: SLOTS }, (_, i) => i);
    for (let i = slots.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [slots[i], slots[j]] = [slots[j], slots[i]]; }
    const m = { at: now, seed, storm: stormPlan(seed, this.cfg.test), teams: new Map(), players: new Map(), taken: new Set(), deadline: now + MATCH_MAX };
    playing.forEach((list, ti) => {
      const tid = "T" + (ti + 1);
      m.teams.set(tid, { ids: list.map(h => h.a.id), slot: slots[ti], out: false, place: 0 });
      for (const h of list) {
        m.players.set(h.a.id, { team: tid, bs: "up", gone: 0, n: 0, name: h.a.disp || h.a.name || "Player", acc: h.a.acc || null });
        this.setAtt(h.ws, { ...this.att(h.ws), inMatch: true, team: tid, queued: false });
      }
    });
    this.match = m; this.last.clear();
    for (const id of m.players.keys()) { const h = this.byId(id); if (h) this.send(h.ws, this.startMsg(id)); }
    this.start = this.nextSlot(now + 5 * MIN); this.ctx.storage.put("start", this.start).catch(() => {});
    this.broadcastInfo(true);
  }
  startMsg(id) {
    const m = this.match, P = m.players.get(id), T = m.teams.get(P.team);
    return { t: "brstart", now: Date.now(), at: m.at, seed: m.seed, storm: m.storm, team: P.team, slot: T.slot, mates: T.ids.filter(x => x !== id),
      players: [...m.players].map(([pid, q]) => ({ id: pid, name: q.name, team: q.team })), teams: m.teams.size, taken: [...m.taken] };
  }

  // ---- during the match
  relay(ws, a, d) {
    const m = this.match, P = m.players.get(a.id); if (!P) return;
    P.gone = 0; P.n++;
    this.last.set(a.id, d);
    const bs = ["up", "down", "out"].includes(d.bs) ? d.bs : P.bs, changed = bs !== P.bs;
    if (changed) { P.bs = bs; this.checkTeams(); if (!this.match) return; }
    const out = JSON.stringify({ t: "st", id: a.id, d }), me = this.viewPos(a.id);
    // far players get every few updates, but a knock or elimination reaches everyone (the kill feed)
    const far = changed || P.n % FAR_EVERY === 0;
    const hitT = new Set(Array.isArray(d.hits) ? d.hits.map(h => h && String(h.t)) : []);
    if (d.dth && typeof d.dth.by === "string") hitT.add(d.dth.by);
    for (const [qid, Q] of m.players) {
      if (qid === a.id) continue;
      const h = this.byId(qid); if (!h) continue;
      const p = this.viewPos(qid);
      if (Q.team === P.team || far || hitT.has(qid) || !me || !p || Math.hypot(me[0] - p[0], me[2] - p[2]) < NEAR) this.send(h.ws, out);
    }
  }
  viewPos(id) {
    const m = this.match, P = m.players.get(id), d = this.last.get(id);
    if (P && P.bs === "out") for (const mate of m.teams.get(P.team).ids) { const q = m.players.get(mate), md = this.last.get(mate); if (mate !== id && q && q.bs !== "out" && md && Array.isArray(md.p)) return md.p; }   // watching their duo
    return d && Array.isArray(d.p) ? d.p : null;
  }
  take(a, d) {
    const i = Math.floor(Number(d.i)); if (!(i >= 0 && i < 5000) || this.match.taken.has(i)) return;
    this.match.taken.add(i);
    const out = JSON.stringify({ t: "taken", i, by: a.id });
    for (const id of this.match.players.keys()) { const h = this.byId(id); if (h) this.send(h.ws, out); }
  }
  sweepMatch() {                                             // players gone for a while are out
    const now = Date.now(); let changed = false;
    for (const P of this.match.players.values()) if (P.gone && now - P.gone > GONE_MS && P.bs !== "out") { P.bs = "out"; changed = true; }
    if (changed) this.checkTeams();
  }
  checkTeams() {
    const m = this.match; if (!m) return;
    const tell = msg => { const out = JSON.stringify(msg); for (const id of m.players.keys()) { const h = this.byId(id); if (h) this.send(h.ws, out); } };
    // a team is still in while anyone on it is standing (both knocked down = out, like Fortnite)
    for (const [tid, T] of m.teams) {
      if (T.out) continue;
      if (!T.ids.some(id => m.players.get(id).bs === "up")) {
        T.out = true; T.place = [...m.teams.values()].filter(x => !x.out).length + 1;
        tell({ t: "teamout", team: tid, place: T.place, alive: T.place - 1 });
      }
    }
    const alive = [...m.teams].filter(([, T]) => !T.out);
    if (alive.length <= 1 && m.teams.size > 1) this.endMatch(alive.length ? alive[0][0] : null);
    else if (alive.length === 0) this.endMatch(null);
    this.broadcastInfo();
  }
  endMatch(winTeam) {
    const m = this.match; if (!m) return;
    const T = winTeam ? m.teams.get(winTeam) : null, ids = T ? T.ids : [];
    const names = ids.map(id => m.players.get(id).name), accts = ids.map(id => m.players.get(id).acc).filter(Boolean);
    const out = JSON.stringify({ t: "brend", team: winTeam, ids, names });
    for (const id of m.players.keys()) {
      const h = this.byId(id);
      if (h) { this.send(h.ws, out); this.setAtt(h.ws, { ...this.att(h.ws), inMatch: false, team: null }); }
    }
    this.match = null; this.last.clear();
    if (T) {                                                 // the winners: Royale Champion skin, and the crown until the next win
      const crown = { t: "crown", names, accts, at: Date.now() };
      accounts(this.env).fetch("https://internal/internal/brwin", { method: "POST", body: JSON.stringify({ accts, names }) }).catch(() => {});
      const c = JSON.stringify(crown); for (const h of this.hubs()) this.send(h.ws, c);
    }
    this.ensureStart(); this.broadcastInfo(true); this.schedule();
  }
}
