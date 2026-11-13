/**
 * Answer Scan — Cloudflare Worker.
 *
 * Routes
 *   GET  /               install page (bookmarklet, demo quiz, screenshot mode, relay mode)
 *   GET  /bookmarklet.js the bookmarklet body, bound to this deployment's origin
 *   POST /api/answer     { lines: string[] } or { image: { media_type, data } } -> { questions: [...] }
 *   GET  /api/health     which AI backend is active
 *
 * Backend: Claude (Anthropic SDK) when the ANTHROPIC_API_KEY secret is set,
 * otherwise Cloudflare Workers AI, which needs no key.
 */
import Anthropic from "@anthropic-ai/sdk";
import PAGE from "./page.html";
import BOOKMARKLET from "./generated/bookmarklet.min.js.txt";

export interface Env {
  AI: Ai;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  RATE_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

type ImageInput = { media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string };

interface AnswerRequest {
  lines?: unknown;
  image?: { media_type?: string; data?: string };
  url?: string;
  title?: string;
}

interface Question {
  question_line: number;
  question: string;
  answer: string;
  answer_lines: number[];
  explanation: string;
  confidence: number;
}

const MAX_LINES = 700;
const MAX_TEXT_CHARS = 48_000;
const WORKERS_AI_TEXT_CHARS = 30_000; // llama-3.3 has a 24k-token window
const MAX_IMAGE_BASE64 = 6_000_000; // ~4.5 MB image

const SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question_line: { type: "integer", description: "Line number where the question text starts (-1 for screenshots)." },
          question: { type: "string", description: "The question, shortened to one line." },
          answer: { type: "string", description: "The correct answer. For multiple choice, the exact text of the correct choice." },
          answer_lines: {
            type: "array",
            items: { type: "integer" },
            description: "Line numbers of the correct answer choice(s). Empty when the answer is not on the page.",
          },
          explanation: { type: "string", description: "One short sentence on why." },
          confidence: { type: "number", description: "0 to 1." },
        },
        required: ["question_line", "question", "answer", "answer_lines", "explanation", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
} as const;

const SYSTEM = `You are Answer Scan, an expert tutor that solves every question visible on a web page or screenshot.

You receive the page as numbered lines ("12| text") or as a screenshot. Find every question: multiple choice, true/false, select-all, matching, fill-in-the-blank, short answer, math, code output, vocabulary, and anything else being asked. Ignore navigation, menus, ads, timers, progress bars, instructions, and page chrome.

For each question:
- Work the problem out carefully and pick the single best answer (list several only for select-all-that-apply).
- "answer" is the correct answer. For multiple choice copy the choice text exactly as written on the page, without its letter or number prefix.
- "answer_lines" are the line numbers of the lines that contain the correct choice(s). A line that holds several choices should still be listed. Leave it empty when the answer is not written on the page (free response, fill-in, math) or when you are working from a screenshot.
- "question_line" is the line number where the question text begins (-1 for screenshots).
- "explanation" is one short sentence. "confidence" is your honest probability from 0 to 1.

Return only the JSON object described by the schema. If there are no questions, return {"questions": []}.`;

/* ------------------------------------------------------------------ */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    if (path === "/" && request.method === "GET") {
      return html(renderPage(url.origin, env));
    }
    if (path === "/bookmarklet.js") {
      return new Response(bookmarkletFor(url.origin), {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (path === "/api/health") {
      return cors(json({ ok: true, backend: backendName(env) }));
    }
    if (path === "/api/answer" && request.method === "POST") {
      return cors(await handleAnswer(request, env));
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/* ---------- helpers ---------- */

function backendName(env: Env): string {
  return env.ANTHROPIC_API_KEY ? `Claude (${env.ANTHROPIC_MODEL || "claude-opus-5-5"})` : "Workers AI (Llama)";
}

function bookmarkletFor(origin: string): string {
  return "javascript:" + BOOKMARKLET.replace("__APP__", origin);
}

function renderPage(origin: string, env: Env): string {
  const code = JSON.stringify(bookmarkletFor(origin)).replace(/<\//g, "<\\/");
  return PAGE.replace("__BOOKMARKLET_JSON__", code).replace("__BACKEND__", escapeHtml(backendName(env)));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function html(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function cors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "POST, GET, OPTIONS");
  h.set("access-control-allow-headers", "content-type");
  h.set("access-control-max-age", "86400");
  return new Response(res.body, { status: res.status, headers: h });
}

/* ---------- /api/answer ---------- */

async function handleAnswer(request: Request, env: Env): Promise<Response> {
  if (env.RATE_LIMITER) {
    try {
      const key = request.headers.get("cf-connecting-ip") || "anon";
      const { success } = await env.RATE_LIMITER.limit({ key });
      if (!success) return json({ error: "Too many scans in a minute. Wait a little and try again." }, 429);
    } catch {
      /* rate limiter unavailable (local dev) — carry on */
    }
  }

  let body: AnswerRequest;
  try {
    body = (await request.json()) as AnswerRequest;
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  const image = parseImage(body.image);
  const lines = parseLines(body.lines);
  if (!image && !lines.length) return json({ error: "Send either lines[] of page text or an image." }, 400);
  if (body.image && !image) return json({ error: "Image must be a base64 JPEG, PNG, GIF or WebP under 4.5 MB." }, 400);

  try {
    const result = env.ANTHROPIC_API_KEY
      ? await askClaude(env, lines, image, body)
      : await askWorkersAI(env, lines, image, body);
    const questions = normalize(result.raw, lines.length);
    return json({ questions, backend: result.backend, model: result.model });
  } catch (err) {
    console.error("answer failed", err);
    return json({ error: describeError(err) }, 502);
  }
}

function parseLines(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  let total = 0;
  for (const item of v) {
    if (typeof item !== "string") continue;
    const t = item.replace(/\s+/g, " ").trim().slice(0, 2000);
    out.push(t);
    total += t.length;
    if (out.length >= MAX_LINES || total >= MAX_TEXT_CHARS) break;
  }
  return out;
}

function parseImage(v: AnswerRequest["image"]): ImageInput | null {
  if (!v || typeof v.data !== "string" || typeof v.media_type !== "string") return null;
  const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  if (!allowed.includes(v.media_type)) return null;
  const data = v.data.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!data || data.length > MAX_IMAGE_BASE64) return null;
  return { media_type: v.media_type as ImageInput["media_type"], data };
}

function linesPrompt(lines: string[], body: AnswerRequest, limitChars: number): string {
  let text = "";
  for (let i = 0; i < lines.length; i++) {
    const row = `${i}| ${lines[i]}\n`;
    if (text.length + row.length > limitChars) break;
    text += row;
  }
  const where = body.title || body.url ? `Page: ${body.title || ""} ${body.url || ""}`.trim() + "\n\n" : "";
  return `${where}Numbered lines of visible page text:\n\n${text}\nFind every question and answer it. Return JSON only.`;
}

const IMAGE_PROMPT =
  "This is a screenshot. Find every question in it and answer each one. Use -1 for question_line and [] for answer_lines. Return JSON only.";

/* ---------- Claude backend ---------- */

async function askClaude(env: Env, lines: string[], image: ImageInput | null, body: AnswerRequest) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.ANTHROPIC_MODEL || "claude-opus-5-5";

  const content: Anthropic.Beta.BetaContentBlockParam[] = image
    ? [
        { type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } },
        { type: "text", text: IMAGE_PROMPT },
      ]
    : [{ type: "text", text: linesPrompt(lines, body, MAX_TEXT_CHARS) }];

  const response = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined this request" + (response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : "."));
  }
  if (response.stop_reason === "max_tokens") throw new Error("The answer was too long to finish. Try scanning a smaller part of the page.");

  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { raw: parseJson(text), backend: "Claude", model: response.model };
}

/* ---------- Workers AI backend ---------- */

const WAI_TEXT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const WAI_VISION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const WAI_VISION_FALLBACK = "@cf/meta/llama-3.2-11b-vision-instruct";

async function askWorkersAI(env: Env, lines: string[], image: ImageInput | null, body: AnswerRequest) {
  if (!env.AI) throw new Error("No AI backend configured: add the Workers AI binding or an ANTHROPIC_API_KEY secret.");
  const ai = env.AI as unknown as { run(model: string, input: Record<string, unknown>): Promise<unknown> };

  if (image) {
    const dataUrl = `data:${image.media_type};base64,${image.data}`;
    const prompt = SYSTEM + "\n\n" + IMAGE_PROMPT + '\nSchema: {"questions":[{"question_line":-1,"question":"","answer":"","answer_lines":[],"explanation":"","confidence":0.9}]}';
    try {
      const res = await ai.run(WAI_VISION_MODEL, {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: 2048,
      });
      return { raw: parseJson(extractText(res)), backend: "Workers AI", model: WAI_VISION_MODEL };
    } catch (err) {
      console.warn("vision model failed, falling back", err);
      const res = await ai.run(WAI_VISION_FALLBACK, {
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: IMAGE_PROMPT },
        ],
        image: dataUrl,
        max_tokens: 2048,
      });
      return { raw: parseJson(extractText(res)), backend: "Workers AI", model: WAI_VISION_FALLBACK };
    }
  }

  const res = await ai.run(WAI_TEXT_MODEL, {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: linesPrompt(lines, body, WORKERS_AI_TEXT_CHARS) },
    ],
    response_format: { type: "json_schema", json_schema: SCHEMA },
    max_tokens: 3000,
  });
  return { raw: parseJson(extractText(res)), backend: "Workers AI", model: WAI_TEXT_MODEL };
}

function extractText(res: unknown): unknown {
  if (res && typeof res === "object" && "response" in res) return (res as { response: unknown }).response;
  return res;
}

/* ---------- output normalization ---------- */

function parseJson(v: unknown): unknown {
  if (v && typeof v === "object") return v;
  if (typeof v !== "string") throw new Error("The model returned an empty response.");
  let s = v.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      s = s.slice(start, end + 1);
      return JSON.parse(s);
    }
    throw new Error("The model did not return valid JSON.");
  }
}

function normalize(raw: unknown, lineCount: number): Question[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { questions?: unknown }).questions)
    ? ((raw as { questions: unknown[] }).questions)
    : [];
  const out: Question[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;
    const toLine = (n: unknown) => {
      const i = typeof n === "number" ? Math.trunc(n) : typeof n === "string" ? parseInt(n, 10) : NaN;
      return Number.isFinite(i) && i >= 0 && i < lineCount ? i : -1;
    };
    const answerLines = Array.isArray(q.answer_lines) ? q.answer_lines.map(toLine).filter((i) => i >= 0) : [];
    const conf = typeof q.confidence === "number" ? Math.max(0, Math.min(1, q.confidence)) : 0.5;
    out.push({
      question_line: toLine(q.question_line),
      question: String(q.question ?? "").slice(0, 500),
      answer: String(q.answer ?? "").slice(0, 1000),
      answer_lines: [...new Set(answerLines)],
      explanation: String(q.explanation ?? "").slice(0, 600),
      confidence: conf,
    });
  }
  return out;
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key was rejected. Check the ANTHROPIC_API_KEY secret.";
  if (err instanceof Anthropic.RateLimitError) return "Claude is rate limited right now. Try again in a moment.";
  if (err instanceof Anthropic.BadRequestError) return `Claude rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
