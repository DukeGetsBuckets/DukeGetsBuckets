// Cubefire Arena server.
// GET /ws?room=<lobby> upgrades to a WebSocket in that lobby's Durable Object,
// which relays each player's state to everyone else in the lobby. Every other
// path serves the game page from ./public.
//
// Each lobby also runs the round clock: with at least 2 players in a match it counts
// down 20 seconds, plays a 3-minute round, shows the results for 8 seconds and repeats.
// Below 2 players it goes back to warm-up ("wait"). Players get {t: "round"} on changes.
// Each countdown picks a new map; in the ranked lobby it also re-sorts players into
// rank groups ({t: "group"}). If everyone else leaves mid-round, the last player left
// in a group wins it ({t: "lastwin"}).
//
// Some name + armor color combinations have extra powers. Online they must first send
// {t: "auth", key, who} with the password in that profile's Worker secret
// (DOUG_PASSWORD; set with `wrangler secret put`). Anyone else using a
// protected name and color is refused.

const MAX_PLAYERS = 24;   // sockets per lobby, including people still in the menu
// Ranked: one lobby where players are sorted by rank into groups of about GROUP_SIZE
// (Elite, Normal, Trash), each with its own fights; up to RANKED_MAX playing at once.
const GROUP_SIZE = 6, RANKED_MAX = 18;
const GROUP_NAMES = [["normal"], ["elite", "normal"], ["elite", "normal", "trash"]];
// Every round is played on a new map (must match MAPS in the game page)
const MAP_IDS = ["arena", "farm", "peaks", "desert", "castle", "snow", "jungle"];
const nextMap = cur => { const l = MAP_IDS.filter(m => m !== cur); return l[Math.floor(Math.random() * l.length)]; };
// Oldest game copy allowed online. Older copies (including any that still have the
// removed cheats) are told to refresh and can't join until they do.
const MIN_BUILD = 30;
const MAX_MESSAGE = 6000;
const ROUND_MS = { count: 20000, live: 180000, end: 8000 };
const ROUND_TEST_MS = { count: 3000, live: 8000, end: 3000 };   // ROUND_TEST=1 (local testing only)
const MIN_ROUND_PLAYERS = 2;
// protected profiles: name -> armor color, and which can turn invisible
const PROTECTED = {};   // all hacks are removed: no protected profiles
const PROFILE_ALIAS = {};   // other names that use a profile
const profileOf = d => { const raw = String(d.n || "").trim().toLowerCase(), n = PROFILE_ALIAS[raw] || raw, p = PROTECTED[n]; return p && d.c === p.color ? n : null; };

function lobbyName(raw) {
  const name = String(raw || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 48);
  return name || "arena-open";
}

const accounts = env => env.ACCOUNTS.get(env.ACCOUNTS.idFromName("all"));
// Accept a socket only to send one message and close it (out-of-date copy, kill switch, ban)
function closingSocket(msg, code, why) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  server.send(JSON.stringify(msg));
  server.close(code, why);
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });
      if ((Number(url.searchParams.get("v")) || 0) < MIN_BUILD) return closingSocket({ t: "update" }, 4001, "Refresh to get the new version");
      // the admin's kill switch and bans (by address) are checked before joining a lobby
      const room = lobbyName(url.searchParams.get("room"));
      let gate = {};
      try { gate = await (await accounts(env).fetch("https://internal/internal/gate", { method: "POST", body: JSON.stringify({ ip: request.headers.get("CF-Connecting-IP") || "local", room }) })).json(); } catch {}
      if (gate.block) return closingSocket({ t: "blocked", why: gate.block }, 4003, "Blocked");
      const fwd = new URL(request.url); fwd.searchParams.set("ipk", gate.ipKey || "");
      return env.LOBBY.get(env.LOBBY.idFromName(room)).fetch(new Request(fwd, request));
    }
    if (url.pathname.startsWith("/api/")) {
      // accounts (also usable from other hosts of the game page, hence CORS)
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS" };
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (request.method !== "POST") return new Response("Use POST", { status: 405, headers: cors });
      if (Number(request.headers.get("content-length") || 0) > 4000) return new Response("Too big", { status: 413, headers: cors });
      const res = await env.ACCOUNTS.get(env.ACCOUNTS.idFromName("all")).fetch(request);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      return out;
    }
    return env.ASSETS.fetch(request);
  },
};

export class Lobby {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.last = new Map(); // player id -> latest state, handed to newcomers
    this.round = { ph: "wait", ends: 0, n: 0, map: nextMap(null), sizes: {}, won: [] };
    this.ps = new Map(); // player id -> what the server knows about their health (see referee)
  }

  // No trading kills. Each game decides its own hits, so when two players shoot each other
  // at the same moment both shots used to count. The server referees: it keeps an estimate
  // of everyone's health from the hits it relays, and once a player's health hits zero
  // their shots stop counting (they're dropped from what everyone receives) until that
  // player has died and respawned. Whichever killing shot reaches the server first wins.
  player(id) {
    let P = this.ps.get(id);
    if (!P) { P = { hp: 100, al: true, dead: false, deadAt: 0, down: false, spawnUntil: 0, lastHitAt: 0, lastSeq: 0, dropped: new Set() }; this.ps.set(id, P); }
    return P;
  }
  referee(a, d) {
    const now = Date.now(), P = this.player(a.id);
    // what this player says about themselves
    const al = d.al !== 0;
    if (!al) { P.down = true; P.dead = false; }                                       // their game shows them dead
    else if (P.down) { P.down = false; P.dead = false; P.hp = 100; P.spawnUntil = now + 1500; }   // respawned
    if (P.dead && now - P.deadAt > 4000) P.dead = false;                              // their game never agreed: forget it
    P.al = al; P.god = !!(a.auth && PROTECTED[a.auth] && PROTECTED[a.auth].god) || (a.perks || []).includes("god");
    if (!P.dead && now - P.lastHitAt > 1000 && typeof d.hp === "number") P.hp = Math.max(0, Math.min(100, d.hp));
    // their shots
    if (!Array.isArray(d.hits)) return;
    const keep = [];
    for (const h of d.hits) {
      if (!h || typeof h.s !== "number" || P.dropped.has(h.s)) continue;
      if (h.s > P.lastSeq) {
        P.lastSeq = h.s;
        if ((P.dead || !P.al) && !h.nk) {                                            // fired after being killed
          P.dropped.add(h.s); if (P.dropped.size > 64) P.dropped.delete(P.dropped.values().next().value);
          continue;
        }
        const T = this.ps.get(String(h.t));
        if (T && T.al && !T.dead && !(T.spawnUntil > now) && this.round.ph !== "end") {
          T.hp -= Math.max(0, Math.min(999, Number(h.dm) || 0)); T.lastHitAt = now;
          if (T.hp <= 0 && !T.god) { T.dead = true; T.deadAt = now; this.kills = (this.kills || 0) + 1; }
        }
      }
      keep.push(h);
    }
    d.hits = keep;
  }

  times() { return this.env && this.env.ROUND_TEST === "1" ? ROUND_TEST_MS : ROUND_MS; }
  // Players in a match (not in the menu). Kept in each socket's attachment so it survives hibernation.
  inMatch(except) {
    let n = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment();
      if (a && a.pl) n++;
    }
    return n;
  }
  // ---- ranked groups (kept in each socket's attachment as g)
  ranked() { for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a) return !!a.ranked; } return false; }
  players(except) {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (ws !== except && a && a.pl) out.push({ ws, a }); }
    return out;
  }
  rankOf(id) { const d = this.last.get(id); return Math.max(0, Number(d && d.rk) || 0); }
  sendGroup(ws, a) {
    const peers = this.players(ws).filter(p => p.a.g === a.g && this.last.has(p.a.id)).map(p => ({ id: p.a.id, d: this.last.get(p.a.id) }));
    try { ws.send(JSON.stringify({ t: "group", g: a.g, peers })); } catch {}
  }
  // Someone joining mid-round goes to the group nearest their rank that has room
  place(id) {
    const groups = new Map();
    for (const p of this.players()) if (p.a.g) { const l = groups.get(p.a.g) || []; l.push(this.rankOf(p.a.id)); groups.set(p.a.g, l); }
    if (!groups.size) return "normal";
    const rk = this.rankOf(id), open = [...groups].filter(([, l]) => l.length < GROUP_SIZE), pool = open.length ? open : [...groups];
    pool.sort((x, y) => Math.abs(x[1].reduce((s, v) => s + v, 0) / x[1].length - rk) - Math.abs(y[1].reduce((s, v) => s + v, 0) / y[1].length - rk));
    return pool[0][0];
  }
  // At each countdown: everyone playing, sorted by rank, split into even groups of up to 6
  regroup() {
    const ps = this.players().sort((x, y) => this.rankOf(y.a.id) - this.rankOf(x.a.id));
    const k = Math.min(3, Math.max(1, Math.ceil(ps.length / GROUP_SIZE))), names = GROUP_NAMES[k - 1];
    const base = Math.floor(ps.length / k), extra = ps.length % k;
    let i = 0;
    names.forEach((g, gi) => { for (let n = base + (gi < extra ? 1 : 0); n > 0; n--, i++) { ps[i].a = { ...ps[i].a, g }; ps[i].ws.serializeAttachment(ps[i].a); } });
    for (const p of ps) this.sendGroup(p.ws, p.a);
  }
  // How many are playing (and in which group), for the menu
  pop(except) {
    const groups = {}, ps = this.players(except);
    for (const p of ps) if (p.a.g) groups[p.a.g] = (groups[p.a.g] || 0) + 1;
    const out = JSON.stringify({ t: "pop", n: ps.length, groups });
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) { try { ws.send(out); } catch {} }
  }
  // The last one left in a group (or the lobby) mid-round wins that round
  lastStanding(g, except) {
    const r = this.round; if (r.ph !== "live") return;
    const key = g || "all", left = this.players(except).filter(p => !g || p.a.g === g);
    if (left.length !== 1 || (r.sizes[key] || 0) < 2 || r.won.includes(key)) return;
    r.won.push(key);
    try { left[0].ws.send(JSON.stringify({ t: "lastwin", n: r.n, size: r.sizes[key] })); } catch {}
  }

  // Move the round on if it's time (or if players came or went), and tell everyone
  tickRound(except) {
    const now = Date.now(), r = this.round, T = this.times(), n = this.inMatch(except);
    let next = null;
    if (n < MIN_ROUND_PLAYERS) { if (r.ph !== "wait") next = { ph: "wait", ends: 0, n: r.n }; }
    else if (r.ph === "wait") next = { ph: "count", ends: now + T.count, n: r.n };
    else if (now >= r.ends - 30) {
      if (r.ph === "count") next = { ph: "live", ends: now + T.live, n: r.n + 1 };
      else if (r.ph === "live") next = { ph: "end", ends: now + T.end, n: r.n };
      else next = { ph: "count", ends: now + T.count, n: r.n };
    }
    if (!next) { if (r.ends > now) this.ctx.storage.setAlarm(r.ends).catch(() => {}); return; }
    next.map = next.ph === "count" ? nextMap(r.map) : r.map;
    next.sizes = r.sizes; next.won = r.won;
    if (next.ph === "count" && this.ranked()) this.regroup();
    if (next.ph === "end" && r.ph === "live") this.stat(this.roomOf(), { rounds: 1 });
    if (next.ph === "live") {                                    // group sizes as the round starts
      next.sizes = {}; next.won = [];
      for (const p of this.players(except)) { const key = p.a.g || "all"; next.sizes[key] = (next.sizes[key] || 0) + 1; }
    }
    this.round = next;
    const out = JSON.stringify({ t: "round", ph: next.ph, ends: next.ends, n: next.n, map: next.map, now });
    for (const ws of this.ctx.getWebSockets()) { if (ws !== except) { try { ws.send(out); } catch {} } }
    if (next.ends) this.ctx.storage.setAlarm(next.ends).catch(() => {});
  }
  async alarm() { this.tickRound(); }

  // Usage numbers for the admin dashboard (sent to the accounts store; never waited on)
  stat(room, extra) {
    const kills = this.kills || 0; this.kills = 0;
    accounts(this.env).fetch("https://internal/internal/stat", { method: "POST", body: JSON.stringify({ room, n: this.players().length, kills, ...extra }) }).catch(() => {});
  }
  roomOf() { for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a && a.room) return a.room; } return ""; }
  // Only the game server itself calls these (the public /ws route only forwards socket upgrades)
  async adminFetch(request) {
    const path = new URL(request.url).pathname;
    let b = {}; try { b = await request.json(); } catch {}
    const socks = this.ctx.getWebSockets().map(ws => ({ ws, a: ws.deserializeAttachment() })).filter(x => x.a);
    if (path === "/state") return Response.json({ round: { ph: this.round.ph, n: this.round.n, map: this.round.map }, players: socks.map(({ a }) => {
      const d = this.last.get(a.id) || {};
      return { id: a.id, name: String(d.n || "?").slice(0, 24), pl: !!a.pl, g: a.g || null, rk: Number(d.rk) || 0, k: Number(d.k) || 0, d: Number(d.d) || 0, afk: !!d.afk, perks: a.perks || [] };
    }) });
    if (path === "/act") {
      if (b.act === "closeall") { for (const { ws } of socks) { try { ws.send(JSON.stringify({ t: "blocked", why: String(b.msg || "") })); ws.close(4003, "Closed"); } catch {} } return Response.json({ ok: true }); }
      const x = socks.find(s => s.a.id === b.id);
      if (!x) return Response.json({ error: "That player has left" }, { status: 404 });
      if (b.act === "info") return Response.json({ ipKey: x.a.ipk || "", name: (this.last.get(x.a.id) || {}).n || "" });
      if (b.act === "kill") { try { x.ws.send(JSON.stringify({ t: "smite" })); } catch {} return Response.json({ ok: true }); }
      if (b.act === "kick") { try { x.ws.send(JSON.stringify({ t: "kicked", why: String(b.msg || "") })); x.ws.close(4004, "Kicked"); } catch {} this.leave(x.ws); return Response.json({ ok: true }); }
    }
    return Response.json({ error: "Unknown" }, { status: 400 });
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return this.adminFetch(request);
    const sockets = this.ctx.getWebSockets();
    const room = lobbyName(new URL(request.url).searchParams.get("room")), ranked = room.startsWith("ranked");
    const ipk = String(new URL(request.url).searchParams.get("ipk") || "").slice(0, 64);
    if (sockets.length >= MAX_PLAYERS) return new Response("Lobby is full", { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, auth: false, ranked, room, ipk });
    const peers = [];
    for (const ws of sockets) {
      const a = ws.deserializeAttachment();
      if (!ranked && a && this.last.has(a.id)) peers.push({ id: a.id, d: this.last.get(a.id) });   // ranked: sent with the group
    }
    const r = this.round;
    server.send(JSON.stringify({ t: "welcome", id, peers, round: { ph: r.ph, ends: r.ends, n: r.n, map: r.map }, now: Date.now() }));
    this.pop();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > MAX_MESSAGE) return;
    const a = ws.deserializeAttachment();
    if (!a) return;
    let d;
    try { d = JSON.parse(message); } catch { return; }
    if (!d || typeof d !== "object" || Array.isArray(d)) return;
    if (d.t === "acct") {                                        // hacks the admin gave this account
      accounts(this.env).fetch("https://internal/internal/perks", { method: "POST", body: JSON.stringify({ token: String(d.token || "") }) })
        .then(r => r.json()).then(r => { const cur = ws.deserializeAttachment(); if (cur) ws.serializeAttachment({ ...cur, perks: Array.isArray(r.perks) ? r.perks : [] }); }).catch(() => {});
      return;
    }
    if (d.t === "auth") {
      const who = typeof d.who === "string" && PROTECTED[d.who] ? d.who : null;
      const secret = who && this.env && this.env[who.toUpperCase() + "_PASSWORD"];
      const ok = !!secret && typeof d.key === "string" && d.key === secret;
      ws.serializeAttachment({ ...a, auth: ok ? who : false });
      try { ws.send(JSON.stringify({ t: "auth", ok })); } catch {}
      return;
    }
    const prof = profileOf(d);
    if (prof && a.auth !== prof) {
      try { ws.send(JSON.stringify({ t: "denied" })); } catch {}
      return;
    }
    const perk = a.auth && PROTECTED[a.auth] || {}, given = a.perks || [];
    if (!perk.invisible && !given.includes("inv")) delete d.iv;  // only players given the hack can be invisible
    if (!perk.nuke && !given.includes("nuke")) {                 // or nuke
      delete d.nk;
      if (Array.isArray(d.hits)) d.hits = d.hits.filter(h => !(h && h.nk)); // grenades (w: 3) still count
    }
    const pl = d.pl === 1;
    if (pl && !a.pl && a.ranked && this.players().length >= RANKED_MAX) {              // ranked is full
      try { ws.send(JSON.stringify({ t: "full", max: RANKED_MAX })); } catch {}
      return;
    }
    this.referee(a, d);
    this.last.set(a.id, d);
    const out = JSON.stringify({ t: "st", id: a.id, d });
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      if (a.ranked) { const o = other.deserializeAttachment(); if (!a.g || !o || o.g !== a.g) continue; }   // ranked: only your group
      try { other.send(out); } catch {}
    }
    if (!!a.pl !== pl) {                                                                // joined or left a match
      const old = a.g;
      const early = this.round.ph === "wait" || this.round.ph === "count";       // no fighting yet: re-sort everyone
      const now = { ...a, pl, g: pl && a.ranked ? (early ? "normal" : this.place(a.id)) : null };
      ws.serializeAttachment(now);
      if (now.g && early) this.regroup(); else if (now.g) this.sendGroup(ws, now);
      if (!pl) { this.tellGroup(old, ws, JSON.stringify({ t: "leave", id: a.id })); this.lastStanding(old, ws); }
      this.pop(); this.tickRound();
      if (pl) {
        this.stat(a.room, { plays: 1, who: String(d.n || "").trim().toLowerCase().slice(0, 24) });
        // banned names (or addresses) are turned away
        accounts(this.env).fetch("https://internal/internal/check", { method: "POST", body: JSON.stringify({ name: d.n, ipKey: a.ipk }) })
          .then(r => r.json()).then(r => { if (r.banned) { try { ws.send(JSON.stringify({ t: "blocked", why: r.banned })); ws.close(4003, "Banned"); } catch {} this.leave(ws); } }).catch(() => {});
      } else this.stat(a.room, {});
    }
    else if (this.round.ends && Date.now() >= this.round.ends) this.tickRound();
  }

  webSocketClose(ws) { this.leave(ws); }
  webSocketError(ws) { this.leave(ws); }

  leave(ws) {
    const a = ws.deserializeAttachment();
    if (!a) return;
    this.last.delete(a.id); this.ps.delete(a.id);
    const out = JSON.stringify({ t: "leave", id: a.id });
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) { try { other.send(out); } catch {} }
    }
    try { ws.close(1000, "bye"); } catch {}
    if (a.pl) { this.lastStanding(a.g, ws); this.tickRound(ws); }
    this.pop(ws);
    if (a.pl) this.stat(a.room, {});
  }
  tellGroup(g, except, out) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment(); if (g && (!a || a.g !== g)) continue;
      try { ws.send(out); } catch {}
    }
  }
}

// ======================================================================
// Accounts: name + password, kept by one Durable Object in SQLite. Each account owns
// skins won on the wheel, the skin it wears, wheel tickets and its rank points.
//   POST /api/signup {name, password, rank}   POST /api/login {name, password}
//   POST /api/me      POST /api/logout        POST /api/daily (one free ticket a day)
//   POST /api/spin    POST /api/equip {skin}  POST /api/progress {pts, wins, rank}
// Every call but signup/login carries {token}. Passwords are stored salted and hashed.
// ======================================================================
// Must match SKIN_DEFS in the game page.
const SKINS = {
  common: ["camo", "desert", "arctic", "nightops", "hivis", "cherry", "ocean", "grape", "forest", "sky", "lime", "bubblegum", "midnight", "sandstone", "tiger", "zebra",
    "olive", "slate", "rust", "mint", "coral", "navy", "plum", "mustard", "teal", "brick", "charcoal", "peach", "lavender", "khaki", "steel", "cocoa", "denim", "salmon", "pine", "sunny", "storm", "berry", "ash", "sage", "tangerine", "icecube", "wine", "beach", "urban", "snowcamo", "bluecamo", "pinkcamo", "redcamo", "jogger", "referee", "jailbird", "candycane", "bee", "ladybug", "watermelon", "banana", "grassy", "cloudy", "mud", "sunset", "copper"],
  rare: ["ninja", "knight", "astro", "robot", "pirate", "cowboy", "firefighter", "police", "doctor", "chef", "viking", "samurai", "alien", "zombie",
    "tuxedo", "scientist", "pilot", "diver", "miner", "kitty", "fox", "panda", "bunny", "grizzly", "froggy", "shark", "dino", "clown", "mummy", "skeleton", "pumpkin", "snowman", "santa", "wizard", "paladin", "spartan", "gladiator", "pharaoh", "jester", "racer", "goalie", "lifeguard", "punk", "hacker", "agent", "bandit"],
  super: ["golden", "lava", "galaxy", "diamond", "rainbow", "iceking", "neon", "shadow", "toxic", "phoenix",
    "plasma", "emerald", "ruby", "sapphire", "amethyst", "obsidian", "stormcaller", "aurora", "vampire", "reaper", "angel", "demon", "cyborg", "mecha", "kraken", "magma", "frostbyte", "venom", "nebula", "chrome", "shogun", "wildfire"],
  ultra: ["voidemperor", "solarflare", "glitch", "jadedragon", "seraph", "infernodemon", "hologram", "thundergod"],
};
const ALL_SKINS = [...SKINS.common, ...SKINS.rare, ...SKINS.super, ...SKINS.ultra];   // the wheel's skins
// Rank rewards: owned automatically once the account's rank points reach the number
const RANK_SKINS = [["silvervet", 300], ["goldelite", 700], ["platguard", 1200], ["diamondwarden", 1800], ["masterphantom", 2500], ["champion", 3500], ["mythic", 8000], ["legend", 15000]];
const rankSkins = rank => RANK_SKINS.filter(([, min]) => rank >= min).map(([k]) => k);
const ODDS = [["ultra", 0.01], ["super", 0.04], ["rare", 0.25], ["common", 0.7]];
// Spins are hard to earn: 50 points each (online elimination 2, bot one 1, round win 20)
const START_TICKETS = 1, PTS_PER_TICKET = 50, PTS_PER_WIN = 20;
// Accounts that own every skin and spin for free; each opens only with its Worker secret
const OWNER_ACCOUNTS = { doug: "DOUG_PASSWORD", alex: "ALEX_PASSWORD" };
// Admin dashboard: the hacks it can give an account, daily usage counters, rank tiers
const HACKS = ["aim", "god", "snipe", "wall", "inv", "tp", "nuke"];
const DAILY_FIELDS = ["visits", "plays", "rounds", "kills", "signups", "logins", "spins", "calls", "peak"];
const RANK_TIERS = [["Bronze", 0], ["Silver", 300], ["Gold", 700], ["Platinum", 1200], ["Diamond", 1800], ["Master", 2500], ["Champion", 3500], ["Mythic", 8000], ["Legend", 15000]];   // must match RANKS in the game page
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const today = () => new Date().toISOString().slice(0, 10);
async function hashPw(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 5000 }, key, 256);
  return hex(bits);
}
// ======================================================================
// Premium: players who turn on notifications. Web Push (RFC 8030) with VAPID (RFC 8292)
// and encrypted messages (RFC 8291), all with WebCrypto. The VAPID signing key is the
// VAPID_PRIVATE secret (a P-256 JWK). Premium players can "call" everyone to their map.
//   POST /api/push-key    POST /api/push-sub {sub}     POST /api/push-check {endpoint}
//   POST /api/push-unsub {endpoint}   POST /api/push-call {endpoint, name, map, mapName, code}
// A call only goes to the caller's friends (both signed in; the subscription remembers its account).
// ======================================================================
const PUSH_SUBJECT = "https://cubefire-arena.secret321.workers.dev";
// Only real push services, so the server can't be pointed at any other address
const PUSH_HOSTS = /(^|\.)push\.apple\.com$|^fcm\.googleapis\.com$|(^|\.)push\.services\.mozilla\.com$|(^|\.)notify\.windows\.com$/;
const CALL_EACH_MS = 2 * 60000;   // one call per player every 2 min
const enc = new TextEncoder();
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4)), c => c.charCodeAt(0));
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}
// The message, encrypted for one subscription (aes128gcm, one record)
async function encryptPush(sub, text) {
  const uaPublic = unb64u(sub.p256dh), authSecret = unb64u(sub.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(enc.encode(text), new Uint8Array([2]))));
  const header = new Uint8Array(21); header.set(salt); new DataView(header.buffer).setUint32(16, 4096); header[20] = asPublic.length;
  return concat(header, asPublic, sealed);
}
function vapidPublic(jwk) { return b64u(concat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y))); }
async function vapidAuth(jwk, endpoint) {
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: PUSH_SUBJECT })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + claims));
  return "vapid t=" + head + "." + claims + "." + b64u(sig) + ", k=" + vapidPublic(jwk);
}
// Sends one message; resolves to the push service's HTTP status (0 if unreachable)
async function sendPush(jwk, sub, message) {
  try {
    const res = await fetch(sub.endpoint, { method: "POST", body: await encryptPush(sub, JSON.stringify(message)),
      headers: { Authorization: await vapidAuth(jwk, sub.endpoint), TTL: "1800", Urgency: "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream" } });
    return res.status;
  } catch { return 0; }
}
const cleanText = (s, n) => String(s || "").replace(/[^\w .'!-]/g, "").trim().slice(0, n);

class UserError extends Error {}

export class Accounts {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, display TEXT, salt TEXT, hash TEXT, data TEXT, created INTEGER)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, name TEXT, created INTEGER)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS push (endpoint TEXT PRIMARY KEY, p256dh TEXT, auth TEXT, created INTEGER, lastCall INTEGER)");
    // admin dashboard: settings (kill switch), bans, hacks given to accounts, daily usage
    this.sql.exec("CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS bans (kind TEXT, val TEXT, label TEXT, reason TEXT, at INTEGER, PRIMARY KEY (kind, val))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS perks (name TEXT PRIMARY KEY, list TEXT)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS daily (day TEXT PRIMARY KEY, visits INTEGER DEFAULT 0, plays INTEGER DEFAULT 0, rounds INTEGER DEFAULT 0, kills INTEGER DEFAULT 0, signups INTEGER DEFAULT 0, logins INTEGER DEFAULT 0, spins INTEGER DEFAULT 0, calls INTEGER DEFAULT 0, peak INTEGER DEFAULT 0)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS seen (day TEXT, who TEXT, PRIMARY KEY (day, who))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS admins (token TEXT PRIMARY KEY, exp INTEGER)");
    this.rooms = new Map();   // live lobbies -> { n, at }, so the dashboard can list who's online
    // friends: a -> b 'pending' is a request; accepted friends have a 'friends' row each way
    this.sql.exec("CREATE TABLE IF NOT EXISTS friends (a TEXT, b TEXT, status TEXT, at INTEGER, PRIMARY KEY (a, b))");
    try { this.sql.exec("ALTER TABLE push ADD COLUMN acct TEXT"); } catch {}   // which account a subscription belongs to
    this.lastCallAt = 0;
    this.fails = new Map(); // name -> { n, until }: slows down password guessing
  }

  async fetch(request) {
    const path = new URL(request.url).pathname, op = path.replace(/^\/api\//, "");
    let body = {};
    try { body = await request.json(); } catch {}
    if (!body || typeof body !== "object") body = {};
    if (path.startsWith("/internal/")) return Response.json(await this.internal(path.slice(10), body));
    // an old copy of the page doesn't know the newest skins: have it reload first
    if (!op.startsWith("admin-") && (Number(body.v) || 0) < MIN_BUILD) return Response.json({ error: "This copy of the game is out of date. Refresh the page to get the new one.", update: true }, { status: 426 });
    try { return Response.json(await this.handle(op, body)); }
    catch (e) { return Response.json({ error: e instanceof UserError ? e.message : "Something went wrong" }, { status: e instanceof UserError ? 400 : 500 }); }
  }

  // ---- admin dashboard support
  setting(k) { const r = this.sql.exec("SELECT v FROM settings WHERE k = ?", k).toArray()[0]; return r ? r.v : null; }
  setSetting(k, v) { this.sql.exec("INSERT OR REPLACE INTO settings (k, v) VALUES (?, ?)", k, String(v)); }
  bump(field, by = 1) {
    if (!DAILY_FIELDS.includes(field) || !by) return;
    this.sql.exec("INSERT OR IGNORE INTO daily (day) VALUES (?)", today());
    if (field === "peak") this.sql.exec("UPDATE daily SET peak = MAX(peak, ?) WHERE day = ?", by, today());
    else this.sql.exec(`UPDATE daily SET ${field} = ${field} + ? WHERE day = ?`, by, today());
  }
  banned(kind, val) { return !!val && !!this.sql.exec("SELECT 1 FROM bans WHERE kind = ? AND val = ?", kind, String(val)).toArray()[0]; }
  requestsFor(name) { return this.sql.exec("SELECT COUNT(*) AS c FROM friends WHERE b = ? AND status = 'pending'", name).toArray()[0].c; }
  perksOf(name) { const r = this.sql.exec("SELECT list FROM perks WHERE name = ?", name).toArray()[0]; try { return r ? JSON.parse(r.list) : []; } catch { return []; } }
  async internal(op, b) {
    if (op === "gate") {
      let salt = this.setting("ipsalt"); if (!salt) { salt = hex(crypto.getRandomValues(new Uint8Array(16))); this.setSetting("ipsalt", salt); }
      const ipKey = hex(await crypto.subtle.digest("SHA-256", enc.encode(salt + String(b.ip || "")))).slice(0, 32);   // addresses are kept only as a salted hash
      const killed = this.setting("kill") === "1";
      if (!killed && b.room !== "probe") this.bump("visits");
      return { ipKey, block: killed ? this.setting("killmsg") || "The game is closed right now. Check back soon." : this.banned("ip", ipKey) ? "You're banned from Cubefire Arena." : null };
    }
    if (op === "stat") {
      if (b.room) { if (b.n > 0) this.rooms.set(String(b.room), { n: b.n, at: Date.now() }); else this.rooms.delete(String(b.room)); }
      for (const f of ["plays", "rounds", "kills"]) this.bump(f, Math.max(0, Math.min(500, Math.floor(Number(b[f]) || 0))));
      if (b.n > 0) { let total = 0; for (const r of this.rooms.values()) total += r.n; this.bump("peak", total); }
      if (b.who) this.sql.exec("INSERT OR IGNORE INTO seen (day, who) VALUES (?, ?)", today(), String(b.who).slice(0, 24));
      return { ok: true };
    }
    if (op === "check") {
      const n = String(b.name || "").trim().toLowerCase();
      return { banned: this.banned("name", n) || this.banned("ip", b.ipKey) ? "You're banned from Cubefire Arena." : null };
    }
    if (op === "perks") {
      const t = String(b.token || ""), s = t && this.sql.exec("SELECT name FROM sessions WHERE token = ?", t).toArray()[0];
      return { perks: s ? this.perksOf(s.name) : [] };
    }
    return { error: "Unknown" };
  }
  async lobbyCall(room, path, body) {
    const res = await this.env.LOBBY.get(this.env.LOBBY.idFromName(room)).fetch("https://internal" + path, { method: "POST", body: JSON.stringify(body || {}) });
    const j = await res.json(); if (j.error) throw new UserError(j.error); return j;
  }
  async online() {
    const rooms = new Set(["rankedv4-open", ...[...this.rooms].filter(([, r]) => Date.now() - r.at < 15 * 60000).map(([k]) => k)]);
    const out = [];
    for (const room of rooms) { try { const st = await this.lobbyCall(room, "/state"); for (const p of st.players) out.push({ ...p, room, map: st.round.map, ph: st.round.ph }); } catch {} }
    return out;
  }
  async adminOp(op, b) {
    if (op === "admin-login") {
      const pw = (this.env && (this.env.ADMIN_PASSWORD || this.env.DOUG_PASSWORD)) || "";
      const f = this.fails.get("#admin");
      if (f && f.until > Date.now()) throw new UserError("Too many tries. Wait a minute and try again");
      if (!pw || String(b.password || "") !== pw) {
        const g = f || { n: 0, until: 0 }; g.n++; if (g.n >= 5) { g.n = 0; g.until = Date.now() + 60000; } this.fails.set("#admin", g);
        throw new UserError("Wrong password");
      }
      this.fails.delete("#admin");
      const token = hex(crypto.getRandomValues(new Uint8Array(24)));
      this.sql.exec("DELETE FROM admins WHERE exp < ?", Date.now());
      this.sql.exec("INSERT INTO admins (token, exp) VALUES (?, ?)", token, Date.now() + 12 * 3600000);
      return { token };
    }
    if (!this.sql.exec("SELECT 1 FROM admins WHERE token = ? AND exp > ?", String(b.admin || ""), Date.now()).toArray()[0]) throw new UserError("Please sign in again");
    const users = () => this.sql.exec("SELECT name, display, data, created FROM users").toArray().map(u => ({ ...u, d: this.data(u) }));
    if (op === "admin-overview") {
      const days = []; for (let i = 13; i >= 0; i--) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
      const rows = new Map(this.sql.exec("SELECT * FROM daily WHERE day >= ?", days[0]).toArray().map(r => [r.day, r]));
      const uniq = new Map(this.sql.exec("SELECT day, COUNT(*) AS n FROM seen WHERE day >= ? GROUP BY day", days[0]).toArray().map(r => [r.day, r.n]));
      const all = users(), tiers = RANK_TIERS.map(([name, min]) => ({ name, min, n: 0 })), skinCount = {};
      for (const u of all) {
        const rk = u.d.rank || 0; let t = 0; RANK_TIERS.forEach(([, min], i) => { if (rk >= min) t = i; }); tiers[t].n++;
        for (const k of u.d.owned || []) skinCount[k] = (skinCount[k] || 0) + 1;
      }
      const count = sql => this.sql.exec(sql).toArray()[0].n;
      return {
        days: days.map(day => ({ day, unique: uniq.get(day) || 0, ...Object.fromEntries(DAILY_FIELDS.map(f => [f, (rows.get(day) || {})[f] || 0])) })),
        totals: { accounts: all.length, premium: count("SELECT COUNT(*) AS n FROM push"), bans: count("SELECT COUNT(*) AS n FROM bans"), hacked: count("SELECT COUNT(*) AS n FROM perks") },
        ranks: tiers, skins: Object.entries(skinCount).sort((x, y) => y[1] - x[1]).slice(0, 10), ultra: all.filter(u => (u.d.owned || []).some(k => SKINS.ultra.includes(k))).length,
        online: await this.online(), kill: this.setting("kill") === "1", killmsg: this.setting("killmsg") || "",
        bans: this.sql.exec("SELECT kind, val, label, reason, at FROM bans ORDER BY at DESC").toArray(),
      };
    }
    if (op === "admin-users") {
      const bannedNames = new Set(this.sql.exec("SELECT val FROM bans WHERE kind = 'name'").toArray().map(r => r.val));
      const perkRows = new Map(this.sql.exec("SELECT name, list FROM perks").toArray().map(r => [r.name, r.list]));
      return { users: users().map(u => ({ name: u.name, display: u.display, rank: u.d.rank || 0, best: u.d.best || 0, skins: (u.d.owned || []).length, tickets: OWNER_ACCOUNTS[u.name] ? "∞" : u.d.tickets || 0, created: u.created, seen: u.d.seen || 0, banned: bannedNames.has(u.name), perks: JSON.parse(perkRows.get(u.name) || "[]") })) };
    }
    const name = String(b.name || "").trim().toLowerCase();
    if (op === "admin-ban") {
      const reason = String(b.reason || "").slice(0, 120);
      if (b.room && b.id) {                                       // a player online: ban their name and address, then remove them
        const info = await this.lobbyCall(String(b.room), "/act", { act: "info", id: b.id });
        const n = String(info.name || "").trim().toLowerCase();
        if (n) this.sql.exec("INSERT OR REPLACE INTO bans VALUES ('name', ?, ?, ?, ?)", n, info.name, reason, Date.now());
        if (info.ipKey) this.sql.exec("INSERT OR REPLACE INTO bans VALUES ('ip', ?, ?, ?, ?)", info.ipKey, (info.name || "?") + "'s device", reason, Date.now());
        await this.lobbyCall(String(b.room), "/act", { act: "kick", id: b.id, msg: "You're banned from Cubefire Arena." }).catch(() => {});
      } else if (name) this.sql.exec("INSERT OR REPLACE INTO bans VALUES ('name', ?, ?, ?, ?)", name, String(b.name).trim(), reason, Date.now());
      else throw new UserError("Who should be banned?");
      return { ok: true };
    }
    if (op === "admin-unban") { this.sql.exec("DELETE FROM bans WHERE kind = ? AND val = ?", String(b.kind), String(b.val)); return { ok: true }; }
    if (op === "admin-perks") {
      if (!this.user(name)) throw new UserError("No account with that name");
      const list = (Array.isArray(b.perks) ? b.perks : []).map(String).filter(k => HACKS.includes(k));
      if (list.length) this.sql.exec("INSERT OR REPLACE INTO perks (name, list) VALUES (?, ?)", name, JSON.stringify(list));
      else this.sql.exec("DELETE FROM perks WHERE name = ?", name);
      return { ok: true, perks: list };
    }
    if (op === "admin-gift" || op === "admin-rank") {
      const u = this.user(name); if (!u) throw new UserError("No account with that name");
      const d = this.data(u);
      if (op === "admin-gift") d.tickets = Math.min(9999, (d.tickets || 0) + Math.max(-9999, Math.min(1000, Math.floor(Number(b.tickets) || 0))));
      else { d.rank = Math.max(0, Math.min(99999, Math.floor(Number(b.rank) || 0))); d.best = Math.max(d.best || 0, d.rank); }
      this.saveData(u.name, d); return { ok: true };
    }
    if (op === "admin-kick" || op === "admin-kill") return this.lobbyCall(String(b.room || ""), "/act", { act: op === "admin-kick" ? "kick" : "kill", id: b.id, msg: "An admin removed you from the match." });
    if (op === "admin-killswitch") {
      const on = !!b.on, msg = String(b.msg || "").slice(0, 160);
      this.setSetting("kill", on ? "1" : "0"); this.setSetting("killmsg", msg);
      if (on) for (const room of new Set(["rankedv4-open", ...this.rooms.keys()])) await this.lobbyCall(room, "/act", { act: "closeall", msg: msg || "The game is closed right now. Check back soon." }).catch(() => {});
      if (on) this.rooms.clear();
      return { ok: true, kill: on };
    }
    throw new UserError("Unknown request");
  }

  user(name) { return this.sql.exec("SELECT * FROM users WHERE name = ?", name).toArray()[0] || null; }
  data(u) { try { return JSON.parse(u.data) || {}; } catch { return {}; } }
  saveData(name, d) { this.sql.exec("UPDATE users SET data = ? WHERE name = ?", JSON.stringify(d), name); }
  view(u, d) {
    if (OWNER_ACCOUNTS[u.name]) return { name: u.display, tickets: 999, unlimited: true, owned: [...ALL_SKINS, ...RANK_SKINS.map(([k]) => k)], equipped: d.equipped || null, rank: d.rank || 0, bank: 0, daily: false, perks: this.perksOf(u.name), requests: this.requestsFor(u.name) };
    return { name: u.display, tickets: d.tickets || 0, owned: [...(d.owned || []), ...rankSkins(Math.max(d.best || 0, d.rank || 0))], equipped: d.equipped || null, rank: d.rank || 0, bank: d.bank || 0, daily: d.lastDaily !== today(), perks: this.perksOf(u.name), requests: this.requestsFor(u.name) };
  }
  async session(name) {
    const token = hex(crypto.getRandomValues(new Uint8Array(24)));
    this.sql.exec("INSERT INTO sessions (token, name, created) VALUES (?, ?, ?)", token, name, Date.now());
    return token;
  }
  who(body) {
    const t = typeof body.token === "string" ? body.token : "";
    const s = t && this.sql.exec("SELECT name FROM sessions WHERE token = ?", t).toArray()[0];
    const u = s && this.user(s.name);
    if (!u) throw new UserError("Please sign in again");
    return u;
  }

  vapid() {
    try { const j = JSON.parse((this.env && this.env.VAPID_PRIVATE) || ""); if (j && j.d && j.x && j.y) return j; } catch {}
    throw new UserError("Notifications aren't set up on this server yet");
  }
  pushEndpoint(s) {
    let u; try { u = new URL(String(s || "")); } catch { return null; }
    const test = this.env && this.env.PUSH_TEST === "1" && u.protocol === "http:" && u.hostname === "127.0.0.1";   // local testing only
    return (u.protocol === "https:" && PUSH_HOSTS.test(u.hostname)) || test ? u.href : null;
  }
  sessionName(token) { const t = String(token || ""), r = t && this.sql.exec("SELECT name FROM sessions WHERE token = ?", t).toArray()[0]; return r ? r.name : null; }
  friendsOf(name) { return this.sql.exec("SELECT b FROM friends WHERE a = ? AND status = 'friends'", name).toArray().map(r => r.b); }
  async pushOp(op, body) {
    const jwk = this.vapid();
    const acct = this.sessionName(body.token);
    if (op === "push-key") return { key: vapidPublic(jwk) };
    const sub = body.sub && typeof body.sub === "object" ? body.sub : {};
    const endpoint = this.pushEndpoint(op === "push-sub" ? sub.endpoint : body.endpoint);
    if (!endpoint) throw new UserError("That notification address isn't supported");
    if (op === "push-sub") {
      const keys = sub.keys || {}, p256dh = String(keys.p256dh || ""), auth = String(keys.auth || "");
      let ok = false; try { ok = unb64u(p256dh).length === 65 && unb64u(auth).length === 16; } catch {}
      if (!ok) throw new UserError("Couldn't turn on notifications. Try again");
      this.sql.exec("INSERT OR REPLACE INTO push (endpoint, p256dh, auth, created, lastCall, acct) VALUES (?, ?, ?, ?, COALESCE((SELECT lastCall FROM push WHERE endpoint = ?), 0), ?)", endpoint, p256dh, auth, Date.now(), endpoint, acct);
      return { premium: true };
    }
    const me = this.sql.exec("SELECT * FROM push WHERE endpoint = ?", endpoint).toArray()[0];
    if (me && acct && me.acct !== acct) this.sql.exec("UPDATE push SET acct = ? WHERE endpoint = ?", acct, endpoint);   // signed in since
    if (op === "push-check") return { premium: !!me };
    if (op === "push-unsub") { this.sql.exec("DELETE FROM push WHERE endpoint = ?", endpoint); return { premium: false }; }
    if (op === "push-call") {
      if (!me) throw new UserError("Turn on notifications to become Premium first");
      if (!acct) throw new UserError("Sign in to call your friends");
      const friends = this.friendsOf(acct);
      if (!friends.length) throw new UserError("Add friends first (Friends tab), then you can call them");
      const now = Date.now(), wait = me.lastCall + CALL_EACH_MS - now;
      if (wait > 0) throw new UserError(`You can call your friends again in ${Math.ceil(wait / 60000)} min`);
      this.sql.exec("UPDATE push SET lastCall = ? WHERE endpoint = ?", now, endpoint); this.lastCallAt = now; this.bump("calls");
      const name = (this.user(acct) || {}).display || cleanText(body.name, 16) || "Your friend", mapName = cleanText(body.mapName, 24) || "the arena";
      const q = new URLSearchParams({ join: "1", map: cleanText(body.map, 16).replace(/[^a-z]/g, ""), code: cleanText(body.code, 12).replace(/[^\w-]/g, ""), from: name });
      const message = { title: "Cubefire Arena", body: `${name} is playing ${mapName}${body.code ? " (party " + cleanText(body.code, 12).toUpperCase() + ")" : ""}. Tap to join!`, url: "/?" + q };
      const subs = this.sql.exec(`SELECT * FROM push WHERE endpoint != ? AND acct IN (${friends.map(() => "?").join(",")})`, endpoint, ...friends).toArray();
      let sent = 0;
      for (let i = 0; i < subs.length; i += 20) {
        const res = await Promise.all(subs.slice(i, i + 20).map(s => sendPush(jwk, s, message)));
        res.forEach((st, k) => { if (st >= 200 && st < 300) sent++; else if (st === 404 || st === 410) this.sql.exec("DELETE FROM push WHERE endpoint = ?", subs[i + k].endpoint); });
      }
      return { sent, friends: friends.length };
    }
    throw new UserError("Unknown request");
  }
  friendOp(op, me, b) {
    const n = String(b.name || "").trim().toLowerCase(), row = (a, x) => this.sql.exec("SELECT status FROM friends WHERE a = ? AND b = ?", a, x).toArray()[0];
    const both = st => { this.sql.exec("INSERT OR REPLACE INTO friends VALUES (?, ?, ?, ?)", me, n, st, Date.now()); this.sql.exec("INSERT OR REPLACE INTO friends VALUES (?, ?, ?, ?)", n, me, st, Date.now()); };
    if (op === "friend-add") {
      if (!n) throw new UserError("Type a friend's account name");
      if (n === me) throw new UserError("That's your own account");
      if (!this.user(n)) throw new UserError("No player has an account called " + String(b.name).trim());
      const mine = row(me, n), theirs = row(n, me);
      if (mine && mine.status === "friends") throw new UserError("You're already friends");
      if (this.sql.exec("SELECT COUNT(*) AS c FROM friends WHERE a = ?", me).toArray()[0].c >= 100) throw new UserError("You can have up to 100 friends");
      if (theirs && theirs.status === "pending") { both("friends"); return { added: "friends" }; }   // they asked you first: you're friends
      this.sql.exec("INSERT OR IGNORE INTO friends VALUES (?, ?, 'pending', ?)", me, n, Date.now());
      return { added: "pending" };
    }
    if (op === "friend-accept") { const theirs = row(n, me); if (!theirs) throw new UserError("That request is gone"); both("friends"); return { ok: true }; }
    if (op === "friend-remove") { this.sql.exec("DELETE FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)", me, n, n, me); return { ok: true }; }
    // friends-list
    const info = x => { const u = this.user(x), d = u ? this.data(u) : {}; return { name: u ? u.display : x, rank: d.rank || 0, seen: d.seen || 0 }; };
    return {
      friends: this.friendsOf(me).map(info).sort((x, y) => y.seen - x.seen),
      incoming: this.sql.exec("SELECT a FROM friends WHERE b = ? AND status = 'pending'", me).toArray().map(r => info(r.a)),
      outgoing: this.sql.exec("SELECT b FROM friends WHERE a = ? AND status = 'pending'", me).toArray().map(r => info(r.b)),
    };
  }

  async handle(op, body) {
    if (op.startsWith("admin-")) return this.adminOp(op, body);
    if (op.startsWith("push-")) return this.pushOp(op, body);
    if (op === "signup" || op === "login") {
      const display = String(body.name || "").trim().replace(/\s+/g, " ");
      const password = String(body.password || "");
      const name = display.toLowerCase();
      if (!/^[A-Za-z0-9_ .-]{3,16}$/.test(display)) throw new UserError("Names are 3-16 letters, numbers, spaces, _ . or -");
      if (password.length < 4 || password.length > 64) throw new UserError("Passwords are 4-64 characters");
      const f = this.fails.get(name);
      if (f && f.until > Date.now()) throw new UserError("Too many tries. Wait a minute and try again");
      if (this.banned("name", name)) throw new UserError("This account is banned");
      this.bump(op === "signup" ? "signups" : "logins");
      // The "Doug" and "Alex" accounts (every skin, unlimited spins) only open with their
      // passwords (Worker secrets); each is created the first time its owner signs in.
      if (OWNER_ACCOUNTS[name]) {
        const secret = this.env && this.env[OWNER_ACCOUNTS[name]];
        if (!secret || password !== secret) {
          const g = this.fails.get(name) || { n: 0, until: 0 }; g.n++;
          if (g.n >= 8) { g.n = 0; g.until = Date.now() + 60000; }
          this.fails.set(name, g);
          throw new UserError(op === "signup" ? "That name is taken" : "Wrong name or password");
        }
        this.fails.delete(name);
        let u = this.user(name);
        if (!u) {
          const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
          this.sql.exec("INSERT INTO users (name, display, salt, hash, data, created) VALUES (?, ?, ?, ?, ?, ?)", name, name[0].toUpperCase() + name.slice(1), salt, await hashPw(password, salt),
            JSON.stringify({ owned: [], equipped: null, tickets: 0, bank: 0, rank: Math.max(0, Math.min(5000, Math.floor(Number(body.rank) || 0))), lastDaily: "" }), Date.now());
          u = this.user(name);
        }
        return { token: await this.session(name), account: this.view(u, this.data(u)) };
      }
      if (op === "signup") {
        if (this.user(name)) throw new UserError("That name is taken");
        const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
        const rank = Math.max(0, Math.min(5000, Math.floor(Number(body.rank) || 0)));
        const d = { owned: [], equipped: null, tickets: START_TICKETS, bank: 0, rank, best: rank, lastDaily: "" };
        this.sql.exec("INSERT INTO users (name, display, salt, hash, data, created) VALUES (?, ?, ?, ?, ?, ?)", name, display, salt, await hashPw(password, salt), JSON.stringify(d), Date.now());
        const u = this.user(name);
        return { token: await this.session(name), account: this.view(u, d) };
      }
      const u = this.user(name);
      if (!u || (await hashPw(password, u.salt)) !== u.hash) {
        const g = this.fails.get(name) || { n: 0, until: 0 }; g.n++;
        if (g.n >= 8) { g.n = 0; g.until = Date.now() + 60000; }
        this.fails.set(name, g);
        throw new UserError("Wrong name or password");
      }
      this.fails.delete(name);
      return { token: await this.session(name), account: this.view(u, this.data(u)) };
    }
    if (op === "top") {                                    // leaderboard: the 20 highest-ranked accounts
      const top = this.sql.exec("SELECT display, CAST(json_extract(data, '$.rank') AS INTEGER) AS rank FROM users WHERE CAST(json_extract(data, '$.rank') AS INTEGER) > 0 ORDER BY rank DESC, created ASC LIMIT 20").toArray();
      return { top: top.map(r => ({ name: r.display, rank: r.rank })) };
    }
    const u = this.who(body), d = this.data(u);
    if (Date.now() - (d.seen || 0) > 300000) { d.seen = Date.now(); this.saveData(u.name, d); }   // last seen, for the dashboard
    if (op === "me") return { account: this.view(u, d) };
    if (op.startsWith("friend")) return { ...this.friendOp(op, u.name, body), account: this.view(u, d) };
    if (op === "logout") { this.sql.exec("DELETE FROM sessions WHERE token = ?", String(body.token)); return { ok: true }; }
    if (op === "daily") {
      if (d.lastDaily === today()) throw new UserError("Come back tomorrow for another free spin");
      d.lastDaily = today(); d.tickets = (d.tickets || 0) + 1;
      this.saveData(u.name, d); return { account: this.view(u, d) };
    }
    if (op === "progress") {
      const pts = Math.max(0, Math.min(100, Math.floor(Number(body.pts) || 0)));
      const wins = Math.max(0, Math.min(3, Math.floor(Number(body.wins) || 0)));
      d.bank = (d.bank || 0) + pts + wins * PTS_PER_WIN;
      d.tickets = (d.tickets || 0) + Math.floor(d.bank / PTS_PER_TICKET);
      d.bank %= PTS_PER_TICKET;
      if (body.rank != null) d.rank = Math.max(0, Math.min(99999, Math.floor(Number(body.rank) || 0)));
      d.best = Math.max(d.best || 0, d.rank || 0);                    // rank skins stay yours for good
      this.saveData(u.name, d); return { account: this.view(u, d) };
    }
    if (op === "equip") {
      const skin = body.skin == null ? null : String(body.skin);
      if (skin && !this.view(u, d).owned.includes(skin)) throw new UserError("You don't have that skin yet");
      d.equipped = skin; this.saveData(u.name, d); return { account: this.view(u, d) };
    }
    if (op === "spin") this.bump("spins");
    if (op === "spin" && OWNER_ACCOUNTS[u.name]) {      // Doug and Alex: free spins, any skin
      let r = Math.random(), rarity = "common";
      for (const [k, p] of ODDS) { if (r < p) { rarity = k; break; } r -= p; }
      const list = SKINS[rarity];
      return { skin: list[Math.floor(Math.random() * list.length)], rarity, account: this.view(u, d) };
    }
    if (op === "spin") {
      const owned = new Set(d.owned || []);
      if (ALL_SKINS.every(s => owned.has(s))) throw new UserError("You already have every skin!");
      if ((d.tickets || 0) < 1) throw new UserError("No spins left. Get eliminations, win rounds, or come back tomorrow");
      // roll a rarity, then a skin of that rarity you don't have (or the nearest rarity that has one;
      // ultras only come from an ultra roll, unless they're all that's left)
      let r = Math.random(), rarity = "common";
      for (const [k, p] of ODDS) { if (r < p) { rarity = k; break; } r -= p; }
      const order = { ultra: ["ultra", "super", "rare", "common"], super: ["super", "rare", "common", "ultra"], rare: ["rare", "common", "super", "ultra"], common: ["common", "rare", "super", "ultra"] }[rarity];
      let skin = null;
      for (const k of order) {
        const left = SKINS[k].filter(s => !owned.has(s));
        if (left.length) { rarity = k; skin = left[Math.floor(Math.random() * left.length)]; break; }
      }
      d.tickets -= 1; d.owned = [...owned, skin];
      this.saveData(u.name, d);
      return { skin, rarity, account: this.view(u, d) };
    }
    throw new UserError("Unknown request");
  }
}
