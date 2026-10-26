# 🐡 Puffer Party

A multiplayer category game in the style of Krillion's *Puffer Party* mode, built
to run on Cloudflare Workers.

## How it plays

- Everyone in the room gets the same category (for example *"Name an animal"*).
- When the puffer points at you, you have **10 seconds** to type an answer
  nobody has used yet this round. A good answer passes the puffer on.
- If your 10 seconds run out, you lose a life and the puffer moves on.
- The puffer swells on a hidden fuse. There's no countdown, only the animation.
  When it **pops**, whoever is holding it gets the rest of their turn (at least
  3 seconds) for one last answer. Answer and you're saved (+3 points). Miss
  and you lose a life.
- A new round starts with a new category. The last player with lives left wins.
  Playing alone is a practice mode that runs until you're out of lives.

## Lenient answers

Every category has 100–140 accepted answers, and each answer can have aliases
(`"Dog|puppy|pup|doggy|hound"`). On top of that, the matcher in
[`src/match.js`](src/match.js) forgives:

- capital letters, punctuation, accents and extra spaces
- a leading *the / a / an*
- plurals (*puppies* → Dog, *butterflies* → Butterfly)
- typos: 1 for words of 4–5 letters, 2 for 6–8 letters and 3 for longer
  words (*hipopotamus*, *girafe*)

Answers are checked on the server, so players can't see the answer lists.

## Project layout

| Path | What it is |
| --- | --- |
| `src/index.js` | Worker entry point and the `PufferRoom` Durable Object (one per room code) |
| `src/game.js` | Game rules and timers, with no networking so it can be unit tested |
| `src/match.js` | Lenient answer matching |
| `questions/part-*.json` | The 100 categories and their answers |
| `public/` | The browser client (HTML, CSS, JS), served as static assets |
| `scripts/validate.mjs` | Checks every category has 100–140 answers with no duplicates |
| `test/` | Unit tests for the rules and the matcher |

## Commands

```sh
npm install
npm test           # game rules + matcher tests
npm run validate   # check the question files
npm run dev        # local server at http://localhost:8787
npm run deploy     # deploy to Cloudflare (needs CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID)
```

### Adding a category

Add an object to any `questions/part-*.json` file:

```json
{ "id": "my-category", "prompt": "Name a …", "answers": ["Canonical|alias|alias", "…"] }
```

Then run `npm run validate`.
