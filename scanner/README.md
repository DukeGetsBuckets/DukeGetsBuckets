# Question Scanner (iPad bookmarklet)

A bookmarklet for Safari on iPad (it also works in desktop browsers). Tap it on any web page and it:

1. **Finds the questions** on the page: text ending in `?`, numbered items (`3.`, `Q3`, `Question 3`), fill-in-the-blank lines, and anything paired with answer options (radio buttons, checkboxes, dropdowns, lettered lists, choice buttons, inline `A. / B. / C.` text).
2. **Finds answers already in the page**: options marked with `data-correct` / `data-answer` / `correct` classes, hidden inputs, hidden "Answer: …" text, quiz JSON inside `<script>` tags, and global JavaScript quiz data. Same-origin iframes are scanned too.
3. **Asks Claude** (optional, with your own API key) to answer every question, sending the page text as context so reading-passage questions work. Answers come back as structured JSON and are shown next to each question with a confidence level and a one-line reason.
4. Gives you **Search**, **Show** (jump to the question), **Copy for Claude** (paste into the Claude app when a site blocks API calls), and **Copy answers**.

Everything renders in a floating panel inside a Shadow DOM, so the page's own CSS cannot break it, and the panel never touches the page's form fields.

## Install on iPad

1. Open `install.html` in Safari (host it anywhere, or open it from the Claude app link you were given).
2. Optionally paste a Claude API key and pick a model, then tap **Build bookmarklet** and **Copy code**.
3. Share → **Add Bookmark**, name it `Scan`, Save.
4. Bookmarks → **Edit** → tap `Scan` → replace the address with the copied code → **Done**.
5. On any quiz page, open Bookmarks and tap `Scan` (or type `scan` in the address bar and pick the bookmark).

Without a key, `bookmarklet.txt` is the ready-made code. A key can also be entered later from the panel's ⚙︎ settings, but that saves it per website only; the install page bakes it into the bookmark so it works everywhere.

## Files

| File | Purpose |
| --- | --- |
| `scanner.js` | Readable source for the whole bookmarklet. |
| `build.mjs` | Minifies `scanner.js` with terser and writes `bookmarklet.txt` and `install.html`. |
| `install.template.html` | Template for the install page; `__QSCAN_CODE__` is replaced with the minified code. |
| `bookmarklet.txt` | Generated: the `javascript:` URL with no key embedded. |
| `install.html` | Generated: the install page. |
| `test/sample-quiz.html` | A quiz page covering every question/option/answer pattern the scanner knows. |
| `test/run.cjs` | Playwright end-to-end test (tablet viewport, mocked Claude API). |

## Build and test

```bash
cd scanner
npm install
npm run build
npm test
```

The test loads the built bookmarklet into the sample quiz the same way Safari would (by evaluating the decoded `javascript:` URL), checks that all eight questions and their page answers are found, then exercises the AI path against a mocked `api.anthropic.com` and writes screenshots to `test/out/`.

## How the AI call works

The bookmarklet calls `POST https://api.anthropic.com/v1/messages` directly from the browser with raw `fetch` (a bookmarklet cannot bundle the SDK), so it sends:

- `anthropic-dangerous-direct-browser-access: true`, which the API requires for cross-origin browser requests;
- `anthropic-beta: server-side-fallback-2026-07-01` with `"fallbacks": "default"`, so a refused request is retried on Anthropic's recommended fallback model;
- `output_config.format` with a JSON schema, so the answers always parse;
- `output_config.effort` (default `high`) and the model you chose (default `claude-opus-5-5`).

Questions go up in batches of 12. A `429` is retried once after the `retry-after` delay. Organizations with zero data retention or the Compliance API cannot call the API from a browser and get a 401 CORS error; the panel explains this and offers **Copy for Claude** instead.

## Limits

- Cross-origin iframes (a quiz from another domain embedded in the page) cannot be read. Open the frame's own URL and scan there.
- Sites that check answers only on their server have nothing in the page to find; use Ask AI or Search.
- Pages with a strict Content Security Policy may block the API request; the panel detects this and suggests **Copy for Claude**.
- Detection is heuristic. Stray matches can appear on text-heavy pages; use **Show** to confirm where a question came from.
