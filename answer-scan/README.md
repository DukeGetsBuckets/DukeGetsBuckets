# ejlnab (Answer Scan)

A Safari bookmark that scans whatever page you are on, finds the questions, and
highlights the answers. Works on iPhone, iPad and Mac. Hosted as a Cloudflare
Worker named `ejlnab`.

**Live:** https://ejlnab.launch2.workers.dev

The landing page is deliberately bare: a black screen with the name and a
"Copy link" button at the bottom. Everything else lives in the bookmark.

## How it works

1. "Copy link" copies a *bookmarklet*: a bookmark whose address is a small
   JavaScript program instead of a URL. On a Mac you can also drag the button
   onto the Favorites bar.
2. Tapping the bookmark on any page collects the visible text as numbered
   lines and sends it to `/api/answer`.
3. The worker asks an AI model to find every question and pick the answer,
   returning the line numbers of the correct choices.
4. The bookmarklet highlights those lines green, tags each question, and shows
   a black panel at the bottom with the answers and a one-line explanation.
   **Rescan** runs it again; **✕** removes the panel and every highlight.

Sites that block outside requests (strict Content Security Policy) get a
fallback: the panel offers "Open results in a new tab", the scan runs in a tab
on this app's origin (`/?relay=1`) and the answers are posted back to the
original page, which still highlights them.

**Screenshot mode** is at `/?shot=1` (not linked from the home page): pick or
paste a screenshot and the questions are answered from the image. Useful for
apps, PDFs and pages where a bookmark cannot run.

## Install the bookmark

- **Mac Safari:** drag the "Copy link" button onto the Favorites bar.
- **iPhone / iPad:** tap "Copy link", add any bookmark via Share → Add
  Bookmark, then Bookmarks → Edit → tap it → paste into the address field →
  Done.

## AI backend

| Setting | Backend | Notes |
| --- | --- | --- |
| default | Cloudflare Workers AI (Llama 3.3 70B for text, Llama 4 Scout for screenshots) | No key needed. Free tier covers roughly 10k neurons a day. |
| `ANTHROPIC_API_KEY` secret set | Claude via the Anthropic SDK (`claude-opus-5-5`, effort `high`, server-side refusal fallbacks on) | Best accuracy. Override the model with an `ANTHROPIC_MODEL` var. |

Switch to Claude:

```bash
cd answer-scan
npx wrangler secret put ANTHROPIC_API_KEY
```

## Develop and deploy

```bash
cd answer-scan
npm install
npm run dev      # local server on http://127.0.0.1:8787 (AI binding still calls Cloudflare)
npm run deploy   # builds the bookmarklet, then deploys the worker
```

Needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment
(or `npx wrangler login`). To rename the site, change `name` in
`wrangler.toml` and the `<title>`/`<h1>` in `src/page.html`, then deploy.

## Layout

```
answer-scan/
  wrangler.toml                 worker config: name, AI binding, rate limit, text imports, prebuild
  src/index.ts                  routes, Claude + Workers AI backends, output normalization
  src/bookmarklet.js            the in-page scanner (collect lines → call API → highlight)
  src/page.html                 bare landing page, relay mode (?relay=1), screenshot mode (?shot=1)
  scripts/build-bookmarklet.mjs minifies the bookmarklet and rejects characters that break javascript: URLs
```

## Limits and notes

- Each scan sends at most 700 lines / 48k characters of page text.
- Scans are rate limited to 30 per minute per IP.
- Text inside cross-origin iframes cannot be read by a bookmarklet; use
  screenshot mode for those.
- Built for studying and checking your own work. Do not use it where outside
  help is not allowed.
