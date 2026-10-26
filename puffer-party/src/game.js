// Puffer Party game rules, independent of transport so it can be unit tested.
//
// A round: everyone gets the same category. The puffer starts on one player,
// who has TURN_MS to name a valid, unused answer; a good answer passes the
// puffer to the next player with a fresh turn timer. Running out of turn time
// costs a life and the puffer moves on. Meanwhile the puffer inflates on a
// hidden fuse. When it pops, whoever is holding it gets the rest of their
// turn (at least LAST_CHANCE_MIN_MS) for one final answer: answer and they're
// saved, miss and they lose a life. Then a new round starts with a new
// category. Last player with lives left wins.

import { AnswerIndex } from "./match.js";

export const TURN_MS = 10_000;
export const LAST_CHANCE_MIN_MS = 3_000;
export const ROUND_BREAK_MS = 5_000;
export const DISCONNECTED_TURN_MS = 2_000;
export const MAX_PLAYERS = 12;
const TICK_MS = 250;
const MAX_ANSWER_LEN = 60;
const MAX_NAME_LEN = 16;

const indexCache = new Map();
function indexFor(question) {
  let ix = indexCache.get(question.id);
  if (!ix) indexCache.set(question.id, (ix = new AnswerIndex(question.answers)));
  return ix;
}

function cleanName(name) {
  const s = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LEN);
  return s || "Player";
}

export class Game {
  // io: { send(playerId, msg), broadcast(msg), now(), setTimer(fn, ms), clearTimer(h), random() }
  constructor(questions, io) {
    this.questions = questions;
    this.io = io;
    this.players = [];
    this.hostId = null;
    this.phase = "lobby"; // lobby | turn | lastChance | roundEnd | gameOver
    this.settings = { lives: 3 };
    this.nextId = 1;
    this.deck = [];
    this.round = 0;
    this.question = null;
    this.used = new Map(); // answer index -> { name, by }
    this.currentId = null;
    this.turnDeadline = 0;
    this.turnTotal = TURN_MS;
    this.roundStart = 0;
    this.fuseMs = 0;
    this.winnerId = null;
    this.soloGame = false;
    this.timers = { turn: null, fuse: null, tick: null, next: null };
  }

  // ---- players -------------------------------------------------------------

  join(name, token) {
    const back = token && this.players.find((p) => p.token === token);
    if (back) {
      back.connected = true;
      if (!this.hostConnected()) this.hostId = back.id;
      return { id: back.id, token: back.token };
    }
    if (this.players.length >= MAX_PLAYERS) return { error: "This room is full." };

    let base = cleanName(name);
    let unique = base;
    for (let n = 2; this.players.some((p) => p.name.toLowerCase() === unique.toLowerCase()); n++) {
      unique = `${base.slice(0, MAX_NAME_LEN - 2)} ${n}`;
    }
    const inGame = this.phase !== "lobby";
    const player = {
      id: String(this.nextId++),
      token: Math.floor(this.io.random() * 2 ** 52).toString(36) + this.nextId,
      name: unique,
      lives: inGame ? 0 : this.settings.lives,
      score: 0,
      connected: true,
      alive: !inGame,
      spectator: inGame,
    };
    this.players.push(player);
    if (!this.hostConnected()) this.hostId = player.id;
    return { id: player.id, token: player.token };
  }

  disconnect(id) {
    const p = this.player(id);
    if (!p) return;
    p.connected = false;
    if (this.phase === "lobby") this.players = this.players.filter((x) => x.id !== id);
    if (this.hostId === id || !this.player(this.hostId)) {
      this.hostId = (this.players.find((x) => x.connected) ?? this.players[0])?.id ?? null;
    }
    if (!this.players.some((x) => x.connected)) {
      this.reset();
      this.players = [];
      return;
    }
    // Don't make everyone wait out a full turn for someone who left.
    if (this.currentId === id && (this.phase === "turn" || this.phase === "lastChance")) {
      const left = this.turnDeadline - this.io.now();
      if (left > DISCONNECTED_TURN_MS) this.armTurn(DISCONNECTED_TURN_MS);
    }
    this.broadcastState();
  }

  player(id) {
    return this.players.find((p) => p.id === id);
  }

  hostConnected() {
    return this.player(this.hostId)?.connected ?? false;
  }

  alivePlayers() {
    return this.players.filter((p) => p.alive);
  }

  // ---- messages ------------------------------------------------------------

  handle(id, msg) {
    switch (msg?.t) {
      case "start":
        return this.start(id, msg);
      case "answer":
        return this.answer(id, msg.text);
      case "typing":
        return this.typing(id, msg.text);
      case "settings":
        return this.updateSettings(id, msg);
      case "lobby":
        return this.backToLobby(id);
    }
  }

  updateSettings(id, msg) {
    if (id !== this.hostId || this.phase !== "lobby") return;
    const lives = Math.round(Number(msg.lives));
    if (lives >= 1 && lives <= 5) {
      this.settings.lives = lives;
      for (const p of this.players) p.lives = lives;
    }
    this.broadcastState();
  }

  start(id) {
    if (id !== this.hostId || this.phase !== "lobby") return;
    const ready = this.players.filter((p) => p.connected);
    if (!ready.length) return;
    this.players = ready;
    for (const p of this.players) {
      p.lives = this.settings.lives;
      p.score = 0;
      p.alive = true;
      p.spectator = false;
      p.out = 0;
    }
    this.soloGame = this.players.length === 1;
    this.round = 0;
    this.winnerId = null;
    this.deck = [];
    this.startRound(this.players[Math.floor(this.io.random() * this.players.length)].id);
  }

  backToLobby(id) {
    if (id !== this.hostId || this.phase !== "gameOver") return;
    this.reset();
    this.players = this.players.filter((p) => p.connected);
    for (const p of this.players) {
      p.lives = this.settings.lives;
      p.score = 0;
      p.alive = true;
      p.spectator = false;
    }
    this.broadcastState();
  }

  reset() {
    for (const k of Object.keys(this.timers)) this.stopTimer(k);
    this.phase = "lobby";
    this.question = null;
    this.used.clear();
    this.currentId = null;
    this.winnerId = null;
  }

  typing(id, text) {
    if (id !== this.currentId || (this.phase !== "turn" && this.phase !== "lastChance")) return;
    this.io.broadcast({ t: "typing", id, text: String(text ?? "").slice(0, MAX_ANSWER_LEN) });
  }

  answer(id, raw) {
    if (id !== this.currentId || (this.phase !== "turn" && this.phase !== "lastChance")) return;
    const text = String(raw ?? "").trim().slice(0, MAX_ANSWER_LEN);
    if (!text) return;

    const match = indexFor(this.question).match(text);
    if (!match) {
      this.io.broadcast({ t: "miss", id, text, reason: "nope" });
      return;
    }
    if (this.used.has(match.index)) {
      const first = this.used.get(match.index);
      this.io.broadcast({ t: "miss", id, text, reason: "taken", name: match.name, by: first.by });
      return;
    }

    const p = this.player(id);
    this.used.set(match.index, { name: match.name, by: id });
    p.score += 1;

    if (this.phase === "lastChance") {
      p.score += 2;
      this.io.broadcast({ t: "saved", id, name: match.name, text });
      this.endRound();
      return;
    }

    this.io.broadcast({ t: "accepted", id, name: match.name, text, fuzzy: !match.exact });
    if (this.used.size >= this.question.answers.length) {
      this.pop(); // Somehow used every answer; pop now.
      return;
    }
    this.passTo(this.nextAlive(id));
  }

  // ---- round flow ----------------------------------------------------------

  drawQuestion() {
    if (!this.deck.length) {
      this.deck = this.questions.map((_, i) => i);
      for (let i = this.deck.length - 1; i > 0; i--) {
        const j = Math.floor(this.io.random() * (i + 1));
        [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
      }
    }
    return this.questions[this.deck.pop()];
  }

  startRound(starterId) {
    this.stopTimer("next");
    this.round += 1;
    this.question = this.drawQuestion();
    this.used.clear();
    this.roundStart = this.io.now();
    // Hidden fuse: long enough that the puffer usually makes it around the
    // table, never so long that a round drags.
    const alive = this.alivePlayers().length;
    this.fuseMs = Math.min(90_000, 22_000 + alive * 4_000 + this.io.random() * 25_000);
    this.timers.fuse = this.io.setTimer(() => this.pop(), this.fuseMs);
    this.timers.tick = this.io.setTimer(() => this.tick(), TICK_MS);
    this.phase = "turn";
    this.io.broadcast({ t: "round", round: this.round, prompt: this.question.prompt });
    this.passTo(starterId);
  }

  passTo(id) {
    this.currentId = id;
    this.armTurn(TURN_MS);
    this.broadcastState();
  }

  armTurn(ms) {
    this.stopTimer("turn");
    this.turnTotal = ms;
    this.turnDeadline = this.io.now() + ms;
    const p = this.player(this.currentId);
    const wait = p && !p.connected ? Math.min(ms, DISCONNECTED_TURN_MS) : ms;
    this.timers.turn = this.io.setTimer(() => this.turnExpired(), wait);
  }

  tick() {
    if (this.phase !== "turn") return;
    this.io.broadcast({ t: "puff", level: this.pufferLevel() });
    this.timers.tick = this.io.setTimer(() => this.tick(), TICK_MS);
  }

  pufferLevel() {
    if (this.phase === "lastChance" || this.phase === "roundEnd") return 1;
    if (this.phase !== "turn") return 0;
    return Math.min(1, (this.io.now() - this.roundStart) / this.fuseMs);
  }

  pop() {
    if (this.phase !== "turn") return;
    this.stopTimer("fuse");
    this.stopTimer("tick");
    this.phase = "lastChance";
    const left = Math.max(LAST_CHANCE_MIN_MS, this.turnDeadline - this.io.now());
    this.armTurn(left);
    this.io.broadcast({ t: "pop", id: this.currentId, ms: left });
    this.broadcastState();
  }

  turnExpired() {
    const id = this.currentId;
    if (this.phase === "turn") {
      this.loseLife(id, "timeout");
      if (this.isOver()) return this.endRound();
      this.passTo(this.nextAlive(id));
    } else if (this.phase === "lastChance") {
      this.loseLife(id, "popped");
      this.endRound();
    }
  }

  loseLife(id, reason) {
    const p = this.player(id);
    if (!p || !p.alive) return;
    p.lives -= 1;
    const out = p.lives <= 0;
    if (out) {
      p.lives = 0;
      p.alive = false;
      p.out = this.round;
    }
    this.io.broadcast({ t: "hit", id, reason, out });
  }

  isOver() {
    const alive = this.alivePlayers().length;
    return this.soloGame ? alive === 0 : alive <= 1;
  }

  endRound() {
    this.stopTimer("turn");
    this.stopTimer("fuse");
    this.stopTimer("tick");
    const holder = this.currentId;
    if (this.isOver()) {
      this.phase = "gameOver";
      const alive = this.alivePlayers();
      this.winnerId = alive.length === 1 && !this.soloGame ? alive[0].id : null;
      this.currentId = null;
      this.broadcastState();
      return;
    }
    this.phase = "roundEnd";
    this.broadcastState();
    this.timers.next = this.io.setTimer(() => this.startRound(this.nextAlive(holder)), ROUND_BREAK_MS);
  }

  // Next living player after `id` in seating order (or the first living one).
  nextAlive(id) {
    const n = this.players.length;
    const start = this.players.findIndex((p) => p.id === id);
    for (let step = 1; step <= n; step++) {
      const p = this.players[(start + step + n) % n];
      if (p.alive) return p.id;
    }
    return this.alivePlayers()[0]?.id ?? null;
  }

  stopTimer(name) {
    if (this.timers[name] != null) {
      this.io.clearTimer(this.timers[name]);
      this.timers[name] = null;
    }
  }

  // ---- state ---------------------------------------------------------------

  snapshot() {
    const live = this.phase === "turn" || this.phase === "lastChance";
    return {
      t: "state",
      phase: this.phase,
      hostId: this.hostId,
      settings: this.settings,
      round: this.round,
      prompt: this.question?.prompt ?? null,
      answerCount: this.question?.answers.length ?? 0,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        lives: p.lives,
        score: p.score,
        connected: p.connected,
        alive: p.alive,
        spectator: p.spectator,
        out: p.out ?? 0,
      })),
      currentId: this.currentId,
      turnLeft: live ? Math.max(0, this.turnDeadline - this.io.now()) : 0,
      turnTotal: this.turnTotal,
      puffer: this.pufferLevel(),
      used: [...this.used.values()],
      winnerId: this.winnerId,
      solo: this.soloGame,
    };
  }

  broadcastState() {
    this.io.broadcast(this.snapshot());
  }
}
