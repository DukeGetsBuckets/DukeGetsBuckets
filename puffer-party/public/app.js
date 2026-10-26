// Puffer Party client. The server is authoritative; this file renders its
// state snapshots and plays the effects for its events.

const $ = (id) => document.getElementById(id);
const screens = ["home", "lobby", "game", "over"];
const COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#0ea5e9", "#6366f1", "#a855f7", "#ec4899", "#84cc16", "#06b6d4", "#f43f5e"];

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  sget(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  sset(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
  sdel(k) { try { sessionStorage.removeItem(k); } catch {} },
};

let ws = null;
let me = null;
let code = null;
let state = null;
let lastPhase = null;
let lastRound = 0;
let lastCurrent = null;
let deadline = 0; // performance.now() when the current turn ends
let turnTotal = 10000;
let leaving = false;
let retries = 0;
let typingTimer = null;
let lastBeep = -1;
let muted = store.get("pp-muted") === "1";
const seatEls = new Map();
const bubbleTimers = new Map();

// ---- screens ----------------------------------------------------------------

function show(name) {
  for (const s of screens) $(s).hidden = s !== name;
}

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2200);
}

function colorFor(id) {
  return COLORS[(Number(id) - 1) % COLORS.length];
}

function avatar(p) {
  const el = document.createElement("span");
  el.className = "avatar";
  el.style.setProperty("--c", colorFor(p.id));
  el.textContent = [...p.name][0]?.toUpperCase() ?? "?";
  return el;
}

function pts(n) {
  return `${n} ${n === 1 ? "pt" : "pts"}`;
}

function nameOf(id) {
  return state?.players.find((p) => p.id === id)?.name ?? "Someone";
}

// ---- connection -------------------------------------------------------------

function connect(roomCode) {
  code = roomCode.toUpperCase();
  leaving = false;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws/${code}`);
  ws.addEventListener("open", () => {
    retries = 0;
    ws.send(JSON.stringify({ t: "join", name: $("name-input").value.trim(), token: store.sget(`pp-token-${code}`) }));
  });
  ws.addEventListener("message", (e) => onMessage(JSON.parse(e.data)));
  ws.addEventListener("close", (e) => {
    if (leaving) return;
    if (e.code === 4000) {
      backHome(e.reason || "Couldn't join that room.");
      return;
    }
    if (retries++ < 8) {
      toast("Reconnecting…");
      setTimeout(() => connect(code), Math.min(4000, 500 * retries));
    } else {
      backHome("Lost connection to the room.");
    }
  });
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

setInterval(() => send({ t: "ping" }), 20000);

function backHome(error = "") {
  leaving = true;
  ws?.close();
  ws = null;
  state = null;
  lastPhase = null;
  history.replaceState(null, "", location.pathname);
  $("home-error").textContent = error;
  show("home");
}

// ---- messages ---------------------------------------------------------------

function onMessage(msg) {
  switch (msg.t) {
    case "welcome":
      me = msg.you;
      store.sset(`pp-token-${msg.code}`, msg.token);
      history.replaceState(null, "", `?room=${msg.code}`);
      break;
    case "state":
      return onState(msg);
    case "round":
      sound("round");
      break;
    case "puff":
      return setPuffer(msg.level);
    case "typing":
      if (msg.id !== me) setBubble(msg.id, msg.text);
      break;
    case "accepted":
      return onAccepted(msg);
    case "miss":
      return onMiss(msg);
    case "pop":
      return onPop(msg);
    case "saved":
      return onSaved(msg);
    case "hit":
      return onHit(msg);
    case "error":
      $("home-error").textContent = msg.message;
      break;
  }
}

function onState(s) {
  const prev = state;
  state = s;
  if (s.phase === "lobby") {
    renderLobby();
    show("lobby");
  } else if (s.phase === "gameOver") {
    renderOver();
    show("over");
    if (lastPhase !== "gameOver") sound("win");
  } else {
    show("game");
    renderGame(prev);
  }
  lastPhase = s.phase;
}

// ---- lobby ------------------------------------------------------------------

function renderLobby() {
  $("room-code").textContent = code;
  const list = $("lobby-players");
  list.replaceChildren(
    ...state.players.map((p) => {
      const li = document.createElement("li");
      li.append(avatar(p), document.createTextNode(p.name + (p.id === me ? " (you)" : "")));
      if (p.id === state.hostId) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = "HOST";
        li.append(tag);
      }
      return li;
    }),
  );
  const n = state.players.length;
  $("player-count").textContent = `(${n}/12)`;
  const host = state.hostId === me;
  $("host-controls").hidden = !host;
  $("wait-host").hidden = host;
  $("lives-select").value = String(state.settings.lives);
  $("start-btn").textContent = n === 1 ? "Start solo practice" : `Start game (${n} players)`;
}

// ---- game -------------------------------------------------------------------

function renderGame(prev) {
  const s = state;
  const newRound = s.round !== lastRound;
  if (newRound) {
    lastRound = s.round;
    const prompt = $("prompt");
    prompt.textContent = s.prompt;
    prompt.classList.remove("flash");
    void prompt.offsetWidth;
    prompt.classList.add("flash");
    resetPuffer();
    centerText("");
    $("feedback").textContent = "";
  }
  $("round-tag").textContent = `Round ${s.round}`;

  renderSeats();
  renderUsed(prev);

  const live = s.phase === "turn" || s.phase === "lastChance";
  if (live) {
    deadline = performance.now() + s.turnLeft;
    turnTotal = s.turnTotal;
  }
  setPuffer(s.puffer);

  const mine = live && s.currentId === me;
  const input = $("answer-input");
  const row = $("answer-form");
  const wasMine = input.disabled === false;
  input.disabled = !mine;
  $("answer-btn").disabled = !mine;
  row.classList.toggle("myturn", mine);
  if (mine) {
    input.placeholder = s.phase === "lastChance" ? "LAST CHANCE! Type fast!" : "Your turn! Type an answer…";
    if (!wasMine || s.currentId !== lastCurrent) {
      input.value = "";
      input.focus();
      sound("turn");
    }
  } else {
    input.placeholder = live ? `${nameOf(s.currentId)} is answering…` : "Next round coming up…";
    if (wasMine) input.value = "";
  }

  if (s.currentId !== lastCurrent) {
    if (lastCurrent) setBubble(lastCurrent, "", null, 0);
    lastCurrent = s.currentId;
    lastBeep = -1;
  }

  if (newRound && s.players.find((p) => p.id === me)?.spectator) {
    feedback("You joined mid-game, so you're watching. You'll play next game!");
  }
  pointAt(live ? s.currentId : null);
}

function seatPosition(i, n) {
  const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
  return { angle, x: 50 + Math.cos(angle) * 40, y: 50 + Math.sin(angle) * 40 };
}

function seated() {
  return state.players.filter((p) => !p.spectator);
}

function renderSeats() {
  const players = seated();
  const host = $("seats");
  const keep = new Set(players.map((p) => p.id));
  for (const [id, el] of seatEls) {
    if (!keep.has(id)) {
      el.remove();
      seatEls.delete(id);
    }
  }
  players.forEach((p, i) => {
    let el = seatEls.get(p.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "seat";
      el.innerHTML = `<div class="bubble"></div><div class="ring"></div><div class="name"></div><div class="lives"></div><div class="score"></div>`;
      el.querySelector(".ring").append(avatar(p));
      host.append(el);
      seatEls.set(p.id, el);
    }
    const pos = seatPosition(i, players.length);
    el.style.left = `${pos.x}%`;
    el.style.top = `${pos.y}%`;
    el.dataset.angle = pos.angle;
    el.querySelector(".name").textContent = p.name + (p.id === me ? " (you)" : "");
    el.querySelector(".lives").textContent = p.alive ? "❤️".repeat(p.lives) : "💀 out";
    el.querySelector(".score").textContent = pts(p.score);
    el.classList.toggle("current", p.id === state.currentId && p.alive);
    el.classList.toggle("out", !p.alive);
    el.classList.toggle("away", !p.connected);
    if (p.id !== state.currentId) el.querySelector(".ring").style.setProperty("--p", 0);
  });
}

function renderUsed(prev) {
  const before = new Set((prev?.round === state.round ? prev.used : []).map((u) => u.name));
  $("used-count").textContent = `(${state.used.length})`;
  $("used-list").replaceChildren(
    ...state.used
      .slice()
      .reverse()
      .map((u) => {
        const li = document.createElement("li");
        li.textContent = u.name;
        li.title = `said by ${nameOf(u.by)}`;
        li.style.setProperty("--c", colorFor(u.by));
        if (!before.has(u.name)) li.classList.add("new");
        return li;
      }),
  );
}

function pointAt(id) {
  const pointer = $("pointer");
  const el = id && seatEls.get(id);
  if (!el) {
    pointer.classList.add("hidden");
    return;
  }
  pointer.classList.remove("hidden");
  const deg = (Number(el.dataset.angle) * 180) / Math.PI + 90;
  // Rotate the short way round from wherever the arrow is now.
  const cur = Number(pointer.dataset.deg ?? deg);
  let next = deg;
  while (next - cur > 180) next -= 360;
  while (next - cur < -180) next += 360;
  pointer.dataset.deg = next;
  pointer.style.transform = `rotate(${next}deg)`;
  pointer.style.setProperty("--reach", `${$("arena").clientWidth * 0.255}px`);
}

function setBubble(id, text, kind = null, hideAfter = 0) {
  const el = seatEls.get(id)?.querySelector(".bubble");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("good", kind === "good");
  el.classList.toggle("bad", kind === "bad");
  clearTimeout(bubbleTimers.get(id));
  if (hideAfter) bubbleTimers.set(id, setTimeout(() => setBubble(id, ""), hideAfter));
}

function centerText(html) {
  const el = $("center-text");
  el.innerHTML = html;
  el.classList.remove("show");
  if (html) {
    void el.offsetWidth;
    el.classList.add("show");
  }
}

function feedback(text, kind) {
  const el = $("feedback");
  el.textContent = text;
  el.className = `feedback ${kind ?? ""}`;
}

// ---- puffer -----------------------------------------------------------------

function mix(a, b, t) {
  const pa = a.match(/\w\w/g).map((h) => parseInt(h, 16));
  const pb = b.match(/\w\w/g).map((h) => parseInt(h, 16));
  return "#" + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

function setPuffer(level) {
  if (state?.phase === "lastChance" || state?.phase === "roundEnd") return;
  const lv = Math.max(0, Math.min(1, level));
  const eased = lv * lv * (3 - 2 * lv) * 0.6 + lv * 0.4;
  const puffer = $("puffer");
  puffer.style.setProperty("--s", (0.62 + eased * 1.05).toFixed(3));
  puffer.style.setProperty("--spike", (0.8 + eased * 0.45).toFixed(3));
  puffer.style.setProperty("--wob", `${(2.4 - eased * 1.9).toFixed(2)}s`);
  puffer.classList.toggle("danger", lv > 0.82);
  const root = document.documentElement.style;
  root.setProperty("--puff-light", mix("fff3b0", "ffd0c2", eased));
  root.setProperty("--puff-mid", mix("ffc93c", "ff6b3d", eased));
  root.setProperty("--puff-dark", mix("c97a00", "b4231a", eased));
}

function resetPuffer() {
  const puffer = $("puffer");
  puffer.classList.remove("popped", "danger");
  $("burst").replaceChildren();
  setPuffer(0);
}

function burst() {
  const box = $("burst");
  const bits = [];
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + Math.random() * 0.3;
    const d = 90 + Math.random() * 120;
    const b = document.createElement("i");
    b.style.setProperty("--x", `${Math.cos(a) * d}px`);
    b.style.setProperty("--y", `${Math.sin(a) * d}px`);
    b.style.background = i % 3 ? "var(--puff-mid)" : "#fff";
    b.style.width = b.style.height = `${6 + Math.random() * 10}px`;
    bits.push(b);
  }
  box.replaceChildren(...bits);
  $("puffer").classList.add("popped");
  const arena = $("arena");
  arena.classList.remove("shake");
  void arena.offsetWidth;
  arena.classList.add("shake");
}

// ---- events -----------------------------------------------------------------

function onAccepted(msg) {
  const fixed = msg.text.trim().toLowerCase() !== msg.name.toLowerCase();
  setBubble(msg.id, `✓ ${msg.name}`, "good", 1600);
  if (msg.id === me) {
    feedback(fixed ? `✓ “${msg.text}” counts as ${msg.name}!` : `✓ ${msg.name}!`, "good");
    $("answer-input").value = "";
  } else {
    feedback(`${nameOf(msg.id)}: ${msg.name}`, "good");
  }
  sound("good");
}

function onMiss(msg) {
  const why = msg.reason === "taken" ? `${msg.name} was already said` : "not on the list";
  if (msg.id === me) {
    feedback(`✗ “${msg.text}”: ${why}. Try again!`, "bad");
    const row = $("answer-form");
    row.classList.remove("wrong");
    void row.offsetWidth;
    row.classList.add("wrong");
    $("answer-input").select();
    sound("bad");
  } else {
    setBubble(msg.id, `✗ ${msg.text}`, "bad", 1200);
  }
}

function onPop(msg) {
  burst();
  sound("pop");
  const who = msg.id === me ? "YOU" : nameOf(msg.id);
  centerText(`POP!<small>${escapeHtml(who)} ${msg.id === me ? "have" : "has"} one last chance!</small>`);
}

function onSaved(msg) {
  setBubble(msg.id, `✓ ${msg.name}`, "good", 2500);
  centerText(`SAVED!<small>${escapeHtml(nameOf(msg.id))} answered ${escapeHtml(msg.name)} just in time</small>`);
  if (msg.id === me) feedback(`Clutch! ${msg.name} saved you (+3)`, "good");
  sound("good");
}

function onHit(msg) {
  const el = seatEls.get(msg.id);
  if (el) {
    el.classList.remove("hit");
    void el.offsetWidth;
    el.classList.add("hit");
  }
  const who = nameOf(msg.id);
  if (msg.reason === "popped") {
    centerText(`${escapeHtml(who)}<small>${msg.out ? "is OUT! 💀" : "got puffed! −1 ❤️"}</small>`);
  } else {
    setBubble(msg.id, msg.out ? "💀 out!" : "⏰ −1 ❤️", "bad", 1500);
    if (msg.id === me) feedback(msg.out ? "Time's up. You're out!" : "Time's up! You lost a life.", "bad");
  }
  sound("hit");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---- turn timer -------------------------------------------------------------

function frame() {
  requestAnimationFrame(frame);
  if (!state || $("game").hidden) return;
  const line = $("turn-line");
  const live = state.phase === "turn" || state.phase === "lastChance";
  if (!live) {
    if (state.phase === "roundEnd") line.textContent = "Next round coming up…";
    line.classList.remove("urgent");
    return;
  }
  const left = Math.max(0, deadline - performance.now());
  const secs = Math.ceil(left / 1000);
  const ring = seatEls.get(state.currentId)?.querySelector(".ring");
  if (ring) {
    ring.style.setProperty("--p", (left / Math.max(1, turnTotal)).toFixed(4));
    ring.style.setProperty("--ring", left < 3000 ? "var(--bad)" : "var(--accent)");
  }
  const mine = state.currentId === me;
  const label = state.phase === "lastChance" ? "💥 Last chance" : mine ? "Your turn" : `${escapeHtml(nameOf(state.currentId))}'s turn`;
  line.innerHTML = `${label} <span class="secs">${secs}</span>`;
  line.classList.toggle("urgent", left < 3000);
  if (mine && secs <= 3 && secs > 0 && secs !== lastBeep) {
    lastBeep = secs;
    sound("tick");
  }
}
requestAnimationFrame(frame);

// ---- sound ------------------------------------------------------------------

let audio = null;
function sound(kind) {
  if (muted) return;
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch {
    return;
  }
  const notes = {
    good: [[660, 0.06], [990, 0.09]],
    bad: [[200, 0.12, "square"]],
    turn: [[520, 0.08], [780, 0.08]],
    tick: [[880, 0.05, "square"]],
    hit: [[180, 0.18, "sawtooth"]],
    round: [[392, 0.08], [523, 0.08], [659, 0.12]],
    win: [[523, 0.1], [659, 0.1], [784, 0.1], [1047, 0.25]],
  }[kind];
  if (kind === "pop") return noiseBurst();
  if (!notes) return;
  let t = audio.currentTime;
  for (const [f, d, type = "triangle"] of notes) {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = type;
    o.frequency.value = f;
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + d);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + d + 0.02);
    t += d * 0.9;
  }
}

function noiseBurst() {
  const len = audio.sampleRate * 0.35;
  const buf = audio.createBuffer(1, len, audio.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = audio.createBufferSource();
  const g = audio.createGain();
  g.gain.value = 0.5;
  src.buffer = buf;
  src.connect(g).connect(audio.destination);
  src.start();
}

function syncMute() {
  $("mute-btn").textContent = muted ? "🔇" : "🔊";
}

// ---- game over --------------------------------------------------------------

function renderOver() {
  const players = seated().slice();
  // Survivors first, then by how long they lasted, then by points.
  players.sort((a, b) => (b.alive - a.alive) || (b.out - a.out) || (b.score - a.score));
  const winner = state.players.find((p) => p.id === state.winnerId);
  $("winner-title").textContent = state.solo
    ? `You scored ${players[0]?.score ?? 0} points!`
    : winner
      ? `${winner.id === me ? "You win" : `${winner.name} wins`}! 🏆`
      : "Game over!";
  $("standings").replaceChildren(
    ...players.map((p, i) => {
      const li = document.createElement("li");
      const rank = document.createElement("span");
      rank.className = "rank";
      rank.textContent = `${i + 1}`;
      const score = document.createElement("span");
      score.className = "pts";
      score.textContent = pts(p.score);
      li.append(rank, avatar(p), document.createTextNode(p.name + (p.id === me ? " (you)" : "")), score);
      return li;
    }),
  );
  const host = state.hostId === me;
  $("again-btn").hidden = !host;
  $("wait-again").hidden = host;
  lastRound = 0;
}

// ---- wiring -----------------------------------------------------------------

function needName() {
  const input = $("name-input");
  const name = input.value.trim();
  if (!name) {
    $("home-error").textContent = "Pick a name first!";
    input.focus();
    return true;
  }
  store.set("pp-name", name);
  $("home-error").textContent = "";
  return false;
}

$("create-btn").addEventListener("click", async () => {
  if (needName()) return;
  try {
    const res = await fetch("/api/new");
    const { code: fresh } = await res.json();
    connect(fresh);
  } catch {
    $("home-error").textContent = "Couldn't reach the server. Try again.";
  }
});

$("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (needName()) return;
  const c = $("code-input").value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(c)) {
    $("home-error").textContent = "Room codes are 4 letters.";
    return;
  }
  connect(c);
});

$("code-input").addEventListener("input", (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, "");
});

$("copy-btn").addEventListener("click", async () => {
  const link = `${location.origin}/?room=${code}`;
  try {
    await navigator.clipboard.writeText(link);
    toast("Invite link copied!");
  } catch {
    toast(link);
  }
});

$("lives-select").addEventListener("change", (e) => send({ t: "settings", lives: Number(e.target.value) }));
$("start-btn").addEventListener("click", () => {
  sound("round"); // unlocks audio on iOS while we have a user gesture
  send({ t: "start" });
});
$("again-btn").addEventListener("click", () => send({ t: "lobby" }));
$("leave-btn").addEventListener("click", () => {
  store.sdel(`pp-token-${code}`);
  backHome();
});

$("answer-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("answer-input").value.trim();
  if (text) send({ t: "answer", text });
});

$("answer-form").addEventListener("animationend", (e) => e.currentTarget.classList.remove("wrong"));

$("answer-input").addEventListener("input", (e) => {
  clearTimeout(typingTimer);
  const text = e.target.value;
  typingTimer = setTimeout(() => send({ t: "typing", text }), 60);
});

$("mute-btn").addEventListener("click", () => {
  muted = !muted;
  store.set("pp-muted", muted ? "1" : "0");
  syncMute();
});

// Ambient bubbles.
{
  const box = document.querySelector(".bubbles");
  for (let i = 0; i < 18; i++) {
    const b = document.createElement("span");
    const size = 6 + Math.random() * 22;
    b.style.width = b.style.height = `${size}px`;
    b.style.left = `${Math.random() * 100}%`;
    b.style.animationDuration = `${9 + Math.random() * 14}s`;
    b.style.animationDelay = `${-Math.random() * 20}s`;
    b.style.setProperty("--drift", `${(Math.random() - 0.5) * 80}px`);
    box.append(b);
  }
}

// Boot.
{
  $("name-input").value = store.get("pp-name") ?? "";
  syncMute();
  const room = new URLSearchParams(location.search).get("room");
  if (room && /^[A-Za-z]{4}$/.test(room)) {
    $("code-input").value = room.toUpperCase();
    if ($("name-input").value.trim() && store.sget(`pp-token-${room.toUpperCase()}`)) connect(room);
    else $("name-input").focus();
  }
  show("home");
}
