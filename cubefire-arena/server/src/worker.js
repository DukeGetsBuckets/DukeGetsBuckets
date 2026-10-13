// Cubefire Arena server.
// GET /ws?room=<lobby> upgrades to a WebSocket in that lobby's Durable Object,
// which relays each player's state to everyone else in the lobby. Every other
// path serves the game page from ./public.
//
// Players named "Doug" in green armor have extra powers, so online they must first
// send {t: "auth", key} with the password stored in the DOUG_PASSWORD secret
// (`wrangler secret put DOUG_PASSWORD`). Anyone else using that name and color is
// refused. "Alex" in blue may also be invisible, with no password.

const MAX_PLAYERS = 16;
const MAX_MESSAGE = 6000;
const DOUG_COLOR = 2;
const isDoug = d => String(d.n || "").trim().toLowerCase() === "doug" && d.c === DOUG_COLOR;
// Alex in blue may be invisible without a password
const ALEX_COLOR = 3;
const isAlex = d => String(d.n || "").trim().toLowerCase() === "alex" && d.c === ALEX_COLOR;

function lobbyName(raw) {
  const name = String(raw || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 48);
  return name || "arena-open";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });
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
  }

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
    server.send(JSON.stringify({ t: "welcome", id, peers }));
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
      const secret = this.env && this.env.DOUG_PASSWORD;
      const ok = !!secret && typeof d.key === "string" && d.key === secret;
      ws.serializeAttachment({ ...a, auth: ok });
      try { ws.send(JSON.stringify({ t: "auth", ok })); } catch {}
      return;
    }
    if (isDoug(d) && !a.auth) {
      try { ws.send(JSON.stringify({ t: "denied" })); } catch {}
      return;
    }
    if (!a.auth && !isAlex(d)) delete d.iv; // only a verified Doug, or Alex in blue, can be invisible
    this.last.set(a.id, d);
    const out = JSON.stringify({ t: "st", id: a.id, d });
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) { try { other.send(out); } catch {} }
    }
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
  }
}
