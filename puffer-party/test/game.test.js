import { test } from "node:test";
import assert from "node:assert/strict";
import { Game, TURN_MS, LAST_CHANCE_MIN_MS, ROUND_BREAK_MS } from "../src/game.js";
import { AnswerIndex } from "../src/match.js";

const QUESTIONS = [
  { id: "animals", prompt: "Name an animal", answers: ["Dog|puppy|doggy", "Cat|kitten", "Hippopotamus|hippo", "Giraffe", "Elephant"] },
  { id: "fruits", prompt: "Name a fruit", answers: ["Apple", "Banana", "Orange", "Grape", "Mango"] },
];

// Deterministic clock and timers.
function harness(randomValue = 0) {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const log = [];
  const io = {
    send: (id, msg) => log.push({ to: id, ...msg }),
    broadcast: (msg) => log.push(msg),
    now: () => now,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    random: () => randomValue,
  };
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  };
  return { io, log, advance, events: (t) => log.filter((m) => m.t === t) };
}

function startGame(names, randomValue = 0) {
  const h = harness(randomValue);
  const game = new Game(QUESTIONS, h.io);
  const ids = names.map((n) => game.join(n).id);
  game.handle(ids[0], { t: "start" });
  return { ...h, game, ids };
}

test("lenient matching: plurals, synonyms, typos, articles", () => {
  const ix = new AnswerIndex(QUESTIONS[0].answers);
  assert.equal(ix.match("puppies")?.name, "Dog");
  assert.equal(ix.match("The Dog")?.name, "Dog");
  assert.equal(ix.match("hipopotamus")?.name, "Hippopotamus");
  assert.equal(ix.match("girafe")?.name, "Giraffe");
  assert.equal(ix.match("elefant")?.name, "Elephant");
  assert.equal(ix.match("car"), null);
  assert.equal(ix.match("zebra"), null);
});

test("good answers pass the puffer and repeats are rejected", () => {
  const { game, ids, events } = startGame(["Ann", "Ben", "Cal"]);
  assert.equal(game.phase, "turn");
  const first = game.currentId;
  game.handle(first, { t: "answer", text: "puppy" });
  assert.equal(events("accepted")[0].name, "Dog");
  const second = game.currentId;
  assert.notEqual(second, first);
  game.handle(second, { t: "answer", text: "dogs" });
  assert.equal(events("miss")[0].reason, "taken");
  assert.equal(game.currentId, second, "a rejected answer keeps the turn");
  game.handle(first, { t: "answer", text: "cat" });
  assert.equal(events("accepted").length, 1, "only the holder may answer");
  assert.ok(ids.includes(second));
});

test("running out of turn time costs a life and passes the puffer", () => {
  const { game, advance, events } = startGame(["Ann", "Ben"]);
  const first = game.currentId;
  advance(TURN_MS);
  assert.equal(events("hit")[0].id, first);
  assert.equal(game.player(first).lives, 2);
  assert.notEqual(game.currentId, first);
});

test("the pop gives the holder their remaining time as a last chance", () => {
  const { game, advance, events } = startGame(["Ann", "Ben", "Cal"]);
  // Keep answering so nobody times out until the hidden fuse runs out.
  const answers = ["dog", "cat", "hippo", "giraffe"];
  let i = 0;
  while (game.phase === "turn") {
    advance(TURN_MS - 1000);
    if (game.phase !== "turn") break;
    game.handle(game.currentId, { t: "answer", text: answers[i++ % answers.length] });
    if (i > 50) break;
  }
  assert.equal(game.phase, "lastChance");
  const pop = events("pop")[0];
  assert.ok(pop.ms >= LAST_CHANCE_MIN_MS);
  const holder = game.currentId;
  const livesBefore = game.player(holder).lives;
  advance(pop.ms);
  assert.equal(game.player(holder).lives, livesBefore - 1);
  assert.equal(events("hit").at(-1).reason, "popped");
  assert.equal(game.phase, "roundEnd");
  advance(ROUND_BREAK_MS);
  assert.equal(game.phase, "turn");
  assert.equal(game.round, 2);
  assert.equal(game.used.size, 0);
});

test("answering during the last chance saves you", () => {
  const { game, advance, events } = startGame(["Ann", "Ben"]);
  game.pop();
  assert.equal(game.phase, "lastChance");
  const holder = game.currentId;
  const before = game.player(holder).lives;
  game.handle(holder, { t: "answer", text: "elephant" });
  assert.equal(events("saved").length, 1);
  assert.equal(game.player(holder).lives, before);
  assert.equal(game.player(holder).score, 3);
  assert.equal(game.phase, "roundEnd");
  advance(TURN_MS);
  assert.equal(game.phase, "turn");
});

test("last player standing wins", () => {
  const { game, advance } = startGame(["Ann", "Ben"]);
  game.handle(game.hostId, { t: "settings", lives: 1 }); // ignored mid-game
  for (let n = 0; n < 20 && game.phase !== "gameOver"; n++) advance(TURN_MS);
  assert.equal(game.phase, "gameOver");
  assert.equal(game.alivePlayers().length, 1);
  assert.equal(game.winnerId, game.alivePlayers()[0].id);
});

test("solo practice runs until you run out of lives", () => {
  const { game, advance } = startGame(["Solo"]);
  assert.equal(game.phase, "turn");
  advance(TURN_MS);
  assert.equal(game.phase, "turn", "solo keeps going after the first miss");
  for (let n = 0; n < 10 && game.phase !== "gameOver"; n++) advance(TURN_MS);
  assert.equal(game.phase, "gameOver");
  assert.equal(game.winnerId, null);
});

test("late joiners spectate, reconnects keep their seat, host can reset", () => {
  const { game, ids, advance } = startGame(["Ann", "Ben"]);
  const late = game.join("Zed");
  assert.equal(game.player(late.id).spectator, true);
  assert.equal(game.player(late.id).alive, false);

  const ben = game.player(ids[1]);
  game.disconnect(ben.id);
  assert.equal(game.player(ben.id).connected, false);
  const back = game.join("whatever", ben.token);
  assert.equal(back.id, ben.id);
  assert.equal(game.player(ben.id).connected, true);

  for (let n = 0; n < 20 && game.phase !== "gameOver"; n++) advance(TURN_MS);
  game.handle(ids[0], { t: "lobby" });
  assert.equal(game.phase, "lobby");
  assert.equal(game.player(late.id).spectator, false);
});

test("a disconnected holder only stalls the table briefly", () => {
  const { game, advance, events } = startGame(["Ann", "Ben", "Cal"]);
  const holder = game.currentId;
  game.disconnect(holder);
  advance(2_000);
  assert.equal(events("hit")[0].id, holder);
});
