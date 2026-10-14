// Cubefire Arena server.
// GET /ws?room=<lobby> upgrades to a WebSocket in that lobby's Durable Object,
// which relays each player's state to everyone else in the lobby. Every other
// path serves the game page from ./public.
//
// Some name + armor color combinations have extra powers. Online they must first send
// {t: "auth", key, who} with the password in that profile's Worker secret
// (DOUG_PASSWORD, ALEX_PASSWORD, NOLAN_PASSWORD; set with `wrangler secret put`). Anyone else using a
// protected name and color is refused.

const MAX_PLAYERS = 16;
// Oldest game copy allowed online. Older copies (including any that still have the
// removed Duke cheats) are told to refresh and can't join until they do.
const MIN_BUILD = 5;
const MAX_MESSAGE = 6000;
// protected profiles: name -> armor color, and which can turn invisible
const PROTECTED = { doug: { color: 2, invisible: true }, alex: { color: 3, invisible: true }, nolan: { color: 3, invisible: false } };
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
