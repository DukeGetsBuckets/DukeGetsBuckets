// Lenient answer matching. Each question's answers are strings of the form
// "Canonical|alias|alias". We forgive case, punctuation, accents, spacing,
// leading articles, plurals and typos (scaled by word length).

const ARTICLES = /^(?:the|a|an)\s+/;

export function normalize(text) {
  return String(text)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(ARTICLES, "");
}

function singularWord(w) {
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (/(?:ches|shes|sses|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("oes") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !/(?:ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

// Compact key: normalized, every word singularized, spaces removed.
export function keyOf(text) {
  return normalize(text).split(" ").filter(Boolean).map(singularWord).join("");
}

// Optimal string alignment distance (Levenshtein + adjacent transpositions),
// bailing out early once the distance exceeds `max`.
export function editDistance(a, b, max = Infinity) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = b.length;
  let prev2 = null;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

// How many typos we forgive for a key of this length.
export function allowedTypos(len) {
  if (len <= 3) return 0;
  if (len <= 5) return 1;
  if (len <= 8) return 2;
  return 3;
}

export class AnswerIndex {
  constructor(answers) {
    this.entries = answers.map((raw) => {
      const names = raw.split("|").map((s) => s.trim()).filter(Boolean);
      return { name: names[0], keys: [...new Set(names.map(keyOf).filter(Boolean))] };
    });
    this.exact = new Map();
    this.entries.forEach((e, i) => {
      for (const k of e.keys) if (!this.exact.has(k)) this.exact.set(k, i);
    });
  }

  // Returns { index, name, exact } or null.
  match(input) {
    const key = keyOf(input);
    if (!key) return null;
    const hit = this.exact.get(key);
    if (hit !== undefined) return { index: hit, name: this.entries[hit].name, exact: true };

    const max = allowedTypos(key.length);
    if (max === 0) return null;
    let best = null;
    for (let i = 0; i < this.entries.length; i++) {
      for (const k of this.entries[i].keys) {
        // Never fuzz toward very short answers; "cat" must not accept "cart".
        const limit = Math.min(max, allowedTypos(k.length));
        if (limit === 0) continue;
        const d = editDistance(key, k, limit);
        if (d <= limit && (!best || d < best.d)) best = { d, index: i };
      }
    }
    return best ? { index: best.index, name: this.entries[best.index].name, exact: false } : null;
  }
}
