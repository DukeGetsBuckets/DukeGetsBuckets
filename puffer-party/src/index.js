import { DurableObject } from "cloudflare:workers";
import { Game } from "./game.js";
import { QUESTIONS } from "./questions.js";

const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_RE = /^[A-Z]{4}$/;

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((b) => CODE_LETTERS[b % CODE_LETTERS.length]).join("");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/new") {
      return Response.json({ code: newCode() });
    }

    if (url.pathname === "/api/info") {
      return Response.json({
        questions: QUESTIONS.length,
        answers: QUESTIONS.reduce((n, q) => n + q.answers.length, 0),
      });
    }

    const ws = url.pathname.match(/^\/ws\/([A-Za-z]{4})$/);
    if (ws) {
      const code = ws[1].toUpperCase();
      if (!CODE_RE.test(code)) return new Response("Bad room code", { status: 400 });
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket", { status: 426 });
      }
      const room = env.ROOMS.get(env.ROOMS.idFromName(code));
      return room.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

// One Durable Object per room code holds the game and every player's socket.
export class PufferRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sockets = new Map(); // WebSocket -> player id
    this.game = new Game(QUESTIONS, {
      send: (id, msg) => {
        for (const [socket, pid] of this.sockets) if (pid === id) this.send(socket, msg);
      },
      broadcast: (msg) => {
        const data = JSON.stringify(msg);
        for (const socket of this.sockets.keys()) {
          try {
            socket.send(data);
          } catch {}
        }
      },
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h),
      random: () => Math.random(),
    });
  }

  async fetch(request) {
    const code = new URL(request.url).pathname.slice(-4).toUpperCase();
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    server.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this.onMessage(server, msg, code);
    });
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  send(socket, msg) {
    try {
      socket.send(JSON.stringify(msg));
    } catch {}
  }

  onMessage(socket, msg, code) {
    if (msg?.t === "join") {
      if (this.sockets.has(socket)) return;
      const res = this.game.join(msg.name, msg.token);
      if (res.error) {
        this.send(socket, { t: "error", message: res.error });
        socket.close(4000, res.error);
        return;
      }
      this.sockets.set(socket, res.id);
      this.send(socket, { t: "welcome", you: res.id, token: res.token, code });
      this.game.broadcastState();
      return;
    }
    if (msg?.t === "ping") return this.send(socket, { t: "pong" });
    const id = this.sockets.get(socket);
    if (id) this.game.handle(id, msg);
  }

  onClose(socket) {
    const id = this.sockets.get(socket);
    if (!this.sockets.delete(socket) || !id) return;
    const stillHere = [...this.sockets.values()].includes(id);
    if (!stillHere) this.game.disconnect(id);
  }
}
