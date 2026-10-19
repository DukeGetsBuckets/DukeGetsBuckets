// Cubefire Arena server.
// GET /ws?room=<lobby> upgrades to a WebSocket in that lobby's Durable Object,
// which relays each player's state to everyone else in the lobby. Every other
// path serves the game page from ./public.
//
// Each lobby also runs the round clock: with at least 2 players in a match it counts
// down 20 seconds, plays a 3-minute round, shows the results for 8 seconds and repeats.
// Below 2 players it goes back to warm-up ("wait"). Players get {t: "round"} on changes.
//
// Some name + armor color combinations have extra powers. Online they must first send
// {t: "auth", key, who} with the password in that profile's Worker secret
// (DOUG_PASSWORD; set with `wrangler secret put`). Anyone else using a
// protected name and color is refused.

const MAX_PLAYERS = 16;
// Oldest game copy allowed online. Older copies (including any that still have the
// removed cheats) are told to refresh and can't join until they do.
const MIN_BUILD = 13;
const MAX_MESSAGE = 6000;
const ROUND_MS = { count: 20000, live: 180000, end: 8000 };
const ROUND_TEST_MS = { count: 3000, live: 8000, end: 3000 };   // ROUND_TEST=1 (local testing only)
const MIN_ROUND_PLAYERS = 2;
// protected profiles: name -> armor color, and which can turn invisible
const PROTECTED = { doug: { color: 2, invisible: true } };
const profileOf = d => { const n = String(d.n || "").trim().toLowerCase(), p = PROTECTED[n]; return p && d.c === p.color ? n : null; };

function lobbyName(raw) {
  const name = String(raw || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 48);
  return name || "arena-open";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });
      if ((Number(url.searchParams.get("v")) || 0) < MIN_BUILD) {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.accept();
        server.send(JSON.stringify({ t: "update" }));
        server.close(4001, "Refresh to get the new version");
        return new Response(null, { status: 101, webSocket: client });
      }
      const stub = env.LOBBY.get(env.LOBBY.idFromName(lobbyName(url.searchParams.get("room"))));
      return stub.fetch(request);
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
    this.round = { ph: "wait", ends: 0, n: 0 };
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
    this.round = next;
    const out = JSON.stringify({ t: "round", ...next, now });
    for (const ws of this.ctx.getWebSockets()) { if (ws !== except) { try { ws.send(out); } catch {} } }
    if (next.ends) this.ctx.storage.setAlarm(next.ends).catch(() => {});
  }
  async alarm() { this.tickRound(); }

  async fetch() {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_PLAYERS) return new Response("Lobby is full", { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, auth: false });
    const peers = [];
    for (const ws of sockets) {
      const a = ws.deserializeAttachment();
      if (a && this.last.has(a.id)) peers.push({ id: a.id, d: this.last.get(a.id) });
    }
    server.send(JSON.stringify({ t: "welcome", id, peers, round: this.round, now: Date.now() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > MAX_MESSAGE) return;
    const a = ws.deserializeAttachment();
    if (!a) return;
    let d;
    try { d = JSON.parse(message); } catch { return; }
    if (!d || typeof d !== "object" || Array.isArray(d)) return;
    if (d.t === "auth") {
      const who = typeof d.who === "string" && PROTECTED[d.who] ? d.who : "doug";
      const secret = this.env && this.env[who.toUpperCase() + "_PASSWORD"];
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
    if (!(a.auth && PROTECTED[a.auth].invisible)) delete d.iv; // only verified profiles can be invisible
    if (a.auth !== "doug") {                                     // only Doug can nuke
      delete d.nk;
      if (Array.isArray(d.hits)) d.hits = d.hits.filter(h => !(h && h.nk)); // grenades (w: 3) still count
    }
    this.last.set(a.id, d);
    const out = JSON.stringify({ t: "st", id: a.id, d });
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) { try { other.send(out); } catch {} }
    }
    const pl = d.pl === 1;
    if (!!a.pl !== pl) { ws.serializeAttachment({ ...a, pl }); this.tickRound(); }      // joined or left a match
    else if (this.round.ends && Date.now() >= this.round.ends) this.tickRound();
  }

  webSocketClose(ws) { this.leave(ws); }
  webSocketError(ws) { this.leave(ws); }

  leave(ws) {
    const a = ws.deserializeAttachment();
    if (!a) return;
    this.last.delete(a.id);
    const out = JSON.stringify({ t: "leave", id: a.id });
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) { try { other.send(out); } catch {} }
    }
    try { ws.close(1000, "bye"); } catch {}
    if (a.pl) this.tickRound(ws);
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
  common: ["camo", "desert", "arctic", "nightops", "hivis", "cherry", "ocean", "grape"],
  rare: ["ninja", "knight", "astro", "robot", "pirate", "cowboy"],
  super: ["golden", "lava", "galaxy", "diamond", "rainbow"],
};
const ALL_SKINS = [...SKINS.common, ...SKINS.rare, ...SKINS.super];   // the wheel's skins
// Rank rewards: owned automatically once the account's rank points reach the number
const RANK_SKINS = [["silvervet", 300], ["goldelite", 700], ["platguard", 1200], ["diamondwarden", 1800], ["masterphantom", 2500], ["champion", 3500]];
const rankSkins = rank => RANK_SKINS.filter(([, min]) => rank >= min).map(([k]) => k);
const ODDS = [["super", 0.05], ["rare", 0.25], ["common", 0.7]];
const START_TICKETS = 3, PTS_PER_TICKET = 10;
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const today = () => new Date().toISOString().slice(0, 10);
async function hashPw(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 5000 }, key, 256);
  return hex(bits);
}
class UserError extends Error {}

export class Accounts {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, display TEXT, salt TEXT, hash TEXT, data TEXT, created INTEGER)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, name TEXT, created INTEGER)");
    this.fails = new Map(); // name -> { n, until }: slows down password guessing
  }

  async fetch(request) {
    const op = new URL(request.url).pathname.replace(/^\/api\//, "");
    let body = {};
    try { body = await request.json(); } catch {}
    if (!body || typeof body !== "object") body = {};
    try { return Response.json(await this.handle(op, body)); }
    catch (e) { return Response.json({ error: e instanceof UserError ? e.message : "Something went wrong" }, { status: e instanceof UserError ? 400 : 500 }); }
  }

  user(name) { return this.sql.exec("SELECT * FROM users WHERE name = ?", name).toArray()[0] || null; }
  data(u) { try { return JSON.parse(u.data) || {}; } catch { return {}; } }
  saveData(name, d) { this.sql.exec("UPDATE users SET data = ? WHERE name = ?", JSON.stringify(d), name); }
  view(u, d) {
    if (u.name === "doug") return { name: u.display, tickets: 999, unlimited: true, owned: [...ALL_SKINS, ...RANK_SKINS.map(([k]) => k)], equipped: d.equipped || null, rank: d.rank || 0, bank: 0, daily: false };
    return { name: u.display, tickets: d.tickets || 0, owned: [...(d.owned || []), ...rankSkins(Math.max(d.best || 0, d.rank || 0))], equipped: d.equipped || null, rank: d.rank || 0, bank: d.bank || 0, daily: d.lastDaily !== today() };
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

  async handle(op, body) {
    if (op === "signup" || op === "login") {
      const display = String(body.name || "").trim().replace(/\s+/g, " ");
      const password = String(body.password || "");
      const name = display.toLowerCase();
      if (!/^[A-Za-z0-9_ .-]{3,16}$/.test(display)) throw new UserError("Names are 3-16 letters, numbers, spaces, _ . or -");
      if (password.length < 4 || password.length > 64) throw new UserError("Passwords are 4-64 characters");
      const f = this.fails.get(name);
      if (f && f.until > Date.now()) throw new UserError("Too many tries. Wait a minute and try again");
      // The "Doug" account (every skin, unlimited spins) only opens with Doug's password
      // (the DOUG_PASSWORD secret); it's created the first time Doug signs in.
      if (name === "doug") {
        const secret = this.env && this.env.DOUG_PASSWORD;
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
          this.sql.exec("INSERT INTO users (name, display, salt, hash, data, created) VALUES (?, ?, ?, ?, ?, ?)", name, "Doug", salt, await hashPw(password, salt),
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
    const u = this.who(body), d = this.data(u);
    if (op === "me") return { account: this.view(u, d) };
    if (op === "logout") { this.sql.exec("DELETE FROM sessions WHERE token = ?", String(body.token)); return { ok: true }; }
    if (op === "daily") {
      if (d.lastDaily === today()) throw new UserError("Come back tomorrow for another free spin");
      d.lastDaily = today(); d.tickets = (d.tickets || 0) + 1;
      this.saveData(u.name, d); return { account: this.view(u, d) };
    }
    if (op === "progress") {
      const pts = Math.max(0, Math.min(100, Math.floor(Number(body.pts) || 0)));
      const wins = Math.max(0, Math.min(3, Math.floor(Number(body.wins) || 0)));
      d.bank = (d.bank || 0) + pts;
      d.tickets = (d.tickets || 0) + Math.floor(d.bank / PTS_PER_TICKET) + wins;
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
    if (op === "spin" && u.name === "doug") {          // Doug: free spins, any skin
      let r = Math.random(), rarity = "common";
      for (const [k, p] of ODDS) { if (r < p) { rarity = k; break; } r -= p; }
      const list = SKINS[rarity];
      return { skin: list[Math.floor(Math.random() * list.length)], rarity, account: this.view(u, d) };
    }
    if (op === "spin") {
      const owned = new Set(d.owned || []);
      if (ALL_SKINS.every(s => owned.has(s))) throw new UserError("You already have every skin!");
      if ((d.tickets || 0) < 1) throw new UserError("No spins left. Get eliminations, win rounds, or come back tomorrow");
      // roll a rarity, then a skin of that rarity you don't have (or the nearest rarity that has one)
      let r = Math.random(), rarity = "common";
      for (const [k, p] of ODDS) { if (r < p) { rarity = k; break; } r -= p; }
      const order = rarity === "super" ? ["super", "rare", "common"] : rarity === "rare" ? ["rare", "super", "common"] : ["common", "rare", "super"];
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
