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
const MIN_BUILD = 11;
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
