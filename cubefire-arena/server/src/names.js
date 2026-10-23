// Blocked words in names (callsigns, account names, party codes). The lists are ROT13 so the
// words don't sit in the code as plain text. Names are checked after undoing the usual tricks:
// numbers and symbols for letters (n1gg@), spaces or dots between letters, stretched letters (fuuuck).
const rot13 = w => w.replace(/[a-z]/g, c => String.fromCharCode((c.charCodeAt(0) - 84) % 26 + 97));
const BAD_ANYWHERE = "nffubyr onfgneq ovgpu obbo puvax phag qvpx qvyqb snttbg sntbg spx shpx shx uvgyre wvmm xvxr xvyylbhefrys xxx zbyrfg anmv avtn avtt avttn avttre avte ahgfnpx crqb cravf cbea chffl encvfg ergneq frk fuvg fyhg gvgf gvggl genaal intvan jrgonpx juber".split(" ").map(rot13);          // anywhere in the name
const BAD_WORD = "nff pbpx pbba phz snt tbbx ubr ubzb xlf arteb avt avtre encr fcvp gvg".split(" ").map(rot13);            // only as a whole word (they're inside ordinary words)
const LEET = { "0": "o", "1": "i", "!": "i", "|": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "+": "t", "8": "b", "9": "g" };
function badName(s) {
  const leet = String(s || "").toLowerCase().replace(/[0-9@$!|+]/g, c => LEET[c] || c);
  const flat = leet.replace(/[^a-z]/g, ""), squash = flat.replace(/(.)\1+/g, "$1");
  if (BAD_ANYWHERE.some(w => flat.includes(w) || squash.includes(w))) return true;
  const words = leet.split(/[^a-z]+/).filter(Boolean), sq = words.map(t => t.replace(/(.)\1+/g, "$1"));
  return BAD_WORD.some(w => words.includes(w) || sq.includes(w) || flat === w || squash === w);
}
export { badName };
