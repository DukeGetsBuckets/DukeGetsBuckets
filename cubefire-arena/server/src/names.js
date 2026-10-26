// Blocked words in names (callsigns, account names, party codes). Very strict on purpose. The word
// patterns are ROT13 so they don't sit in the code as plain text. Before checking, a name is cleaned of
// the usual tricks: accents and lookalike letters from other alphabets, numbers and symbols for letters,
// l or | for i, v for u, ph for f, spaces or dots between letters, stretched letters, common misspellings,
// and writing it backwards. A few real words that only look bad are allowed.
const rot13 = w => w.replace(/[a-z]/g, c => String.fromCharCode((c.charCodeAt(0) - 84) % 26 + 97));
const BAD_ANYWHERE = ["a[vl]+[td]+(?:[nrvbhl]|e)", "a[vl]+(?:xx|pp|xp|px|dd)[nrvbhl]", "ar+t+eb", "sn+t+[bv]+g", "sn+tf", "cr+[nrvbhl]*a+[nrvbhl]+f", "q[vl]+p*x(?!raf)", "s+[h]+p*[xd]", "spx", "fu+[vl]+g", "o[vl]+g*pu", "nf+uby", "p[h]+ag", "c[h]+f+[vl]", "frk", "cbea", "int[vl]+a", "obbo", "g[vl]+gf", "g[vl]+gg[vl]", "q[vl]+yqb", "w[vl]+mm?", "enc[vl]+fg", "u[vl]+gyre", "anm[vl]", "ergneq", "genaa[lv]", "pu[vl]+ax", "x[vl]+xr", "juber", "fy[h]+g", "onfgneq", "zbyrfg", "crqb", "xxx", "a[h]+gfnpx", "x[vl]+yylb[h]+efrys", "jrgonpx", "pbpxf[h]+p", "gjng", "phz(?:f|fubg|fyhg)", "frz[r]a", "na[h]+f", "nany", "gubg", "ubeal"].map(p => new RegExp(rot13(p).replace(/l/g, "i")));
const BAD_WORD = new Set(["nff", "gvg", "ubr", "ubzb", "encr", "avt", "phz", "snt", "xlf", "tbbx", "fcvp", "pbba", "pbpx", "jnax", "cevpx"].map(rot13));
const ALLOWED = ["avtry", "qvpxraf", "qvpxfba", "gurencvfg", "rffrk", "fhffrk", "zvqqyrfrk", "frkgnag", "frkgba", "crqbzrgre", "anmve", "fphagubecr", "fuvvgnxr", "nanylfg", "nanybt", "pnany", "onany", "znahf", "wnahf", "henahf", "nanfgnfvn", "nanpbaqn", "gvgfjbegu", "obbobbx", "gubeal", "craavrf", "crbavrf", "zbagrarteb", "orarqvxg", "avtryyn", "qvpxvafba", "pbpxngbb", "pbpxgnvy", "crnpbpx", "fuhggyrpbpx", "fcvpr", "fcvpl", "qrfcvpnoyr", "enppbba", "pbpbba", "glpbba", "yntbba", "zbafbba", "pnegbba", "onyybba", "cyngbba", "pbpbn", "phzzvatf", "npphzhyngr", "pvephzfgnapr", "qbphzragnel", "qbpxlneq", "nffnffva", "onffvfg", "tenffl", "rzonffl", "gvgna", "gvgnavhz", "pbzcrgvgvba", "pbafgvghgvba", "avtugvatnyr", "xavtug", "jnaxry"].map(rot13);
const LOOKALIKE = { "\u0430": "a", "\u0432": "b", "\u0435": "e", "\u0451": "e", "\u043a": "k", "\u043c": "m", "\u043d": "h", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0442": "t", "\u0443": "y", "\u0445": "x", "\u0456": "i", "\u0457": "i", "\u0458": "j", "\u0455": "s", "\u0501": "d", "\u0261": "g", "\u0251": "a", "\u0131": "i",
  "\u03b1": "a", "\u03b2": "b", "\u03b5": "e", "\u03b7": "n", "\u03b9": "i", "\u03ba": "k", "\u03bd": "v", "\u03bf": "o", "\u03c1": "p", "\u03c4": "t", "\u03c5": "u", "\u03c7": "x" };
const LEET = { "0": "o", "1": "i", "!": "i", "|": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "+": "t", "8": "b", "9": "g", "6": "g", "2": "z", "(": "c", "\u20ac": "e" };
const squash = x => x.replace(/(.)\1+/g, "$1");
const strip = x => x.replace(/^(.)\1+/, "").replace(/(.)\1+$/, "");   // drop a repeated border like xX..Xx
function badName(s) {
  let t = String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  t = [...t].map(c => LOOKALIKE[c] || LEET[c] || c).join("").replace(/ph/g, "f").replace(/l/g, "i");   // l and i are the same
  for (const ok of ALLOWED) t = t.split(ok.replace(/l/g, "i")).join(" ");
  const flat = t.replace(/[^a-z]/g, ""), forms = new Set();
  for (const f of [flat, flat.replace(/v/g, "u")]) { forms.add(f); forms.add(squash(f)); forms.add(strip(f)); forms.add(squash(strip(f))); }
  for (const f of [...forms]) forms.add([...f].reverse().join(""));
  for (const f of forms) if (BAD_ANYWHERE.some(re => re.test(f))) return true;
  // whole words: a word on its own (inside normal words too often to block anywhere), matched
  // even when stretched (coonnn) or wrapped in decoration (xXcoonXx)
  const words = t.split(/[^a-z]+/).filter(Boolean);
  for (const w of words) for (const f of [w, squash(w), strip(w), squash(strip(w))]) if (BAD_WORD.has(f)) return true;
  for (const f of forms) if (BAD_WORD.has(squash(f)) || BAD_WORD.has(f)) return true;
  for (const w of [...BAD_WORD]) if (squash(flat) === squash(w) || strip(flat) === w || squash(strip(flat)) === squash(w)) return true;
  return false;
}
export { badName };
