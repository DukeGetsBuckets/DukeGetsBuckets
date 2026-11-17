import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AnalysisSummary, CoachingReport, MoveAnalysisDTO } from "@tempo/shared";
import { env } from "../env";
import { logger } from "../logger";
import type { GameFacts } from "./deterministic";

const reportSchema = z.object({
  didWell: z.array(z.string().min(1).max(300)).min(1).max(4),
  practice: z.array(z.string().min(1).max(300)).min(1).max(3),
  openingInsight: z.string().min(1).max(600),
  lesson: z.string().min(1).max(300),
  turningPointText: z.string().max(600).nullable(),
  mistakeExplanations: z.array(z.object({ ply: z.number().int(), explanation: z.string().min(1).max(500) })).max(3),
});

const SAN_TOKEN = /\b(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)\b/g;

/**
 * Optionally rewrites the deterministic coaching with a language model for clearer prose.
 * The model only sees verified engine facts and may not introduce moves that are not in the
 * provided data; any output that mentions an unknown move is rejected and the deterministic
 * report is kept. Returns null when no API key is configured.
 */
export async function enhanceCoachingWithAI(
  base: { white: CoachingReport; black: CoachingReport },
  moves: MoveAnalysisDTO[],
  summary: AnalysisSummary,
  game: GameFacts,
): Promise<{ white: CoachingReport; black: CoachingReport } | null> {
  if (!env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 45_000, maxRetries: 1 });
  const allowed = new Set<string>();
  for (const m of moves) {
    allowed.add(m.playedSan);
    if (m.bestSan) allowed.add(m.bestSan);
    for (const s of m.pvSan) allowed.add(s);
    for (const a of m.altLines) allowed.add(a.san);
  }
  const out: { white: CoachingReport; black: CoachingReport } = { white: base.white, black: base.black };
  for (const color of ["white", "black"] as const) {
    const report = base[color];
    const facts = {
      player: color === "white" ? game.whiteName : game.blackName,
      color,
      result: game.result,
      endReason: game.endReason,
      timeControl: game.category,
      accuracy: color === "white" ? summary.white.accuracy : summary.black.accuracy,
      counts: color === "white" ? summary.white.counts : summary.black.counts,
      opening: summary.opening,
      mistakes: report.biggestMistakes.map((m) => {
        const full = moves.find((x) => x.ply === m.ply);
        return { ply: m.ply, moveNumber: Math.ceil(m.ply / 2), played: m.san, best: m.bestSan, classification: m.classification, winDrop: m.winDrop, theme: m.theme, engineLine: full?.pvSan.slice(0, 5), engineExplanation: m.explanation };
      }),
      turningPoint: report.turningPoint,
      deterministicReport: { didWell: report.didWell, practice: report.practice, openingInsight: report.openingInsight, lesson: report.lesson },
    };
    const prompt = `You are a chess coach writing a short, encouraging but honest post-game summary for ${facts.player} (playing ${color}).
Use ONLY the facts in the JSON below. Every chess move you mention must appear verbatim in the JSON (played, best, or engineLine moves). Do not invent variations, opening names, or evaluations. Keep each item to one or two sentences.
Respond with JSON only, matching this TypeScript type:
{ didWell: string[1-4]; practice: string[1-3]; openingInsight: string; lesson: string; turningPointText: string | null; mistakeExplanations: { ply: number; explanation: string }[] }

FACTS:
${JSON.stringify(facts)}`;
    try {
      const response = await client.beta.messages.create({
        model: env.ANTHROPIC_MODEL,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        messages: [{ role: "user", content: prompt }],
      });
      if (response.stop_reason === "refusal") {
        logger.warn({ color }, "coaching request refused; keeping deterministic report");
        continue;
      }
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const json = extractJson(text);
      if (!json) continue;
      const parsed = reportSchema.safeParse(json);
      if (!parsed.success) continue;
      const prose = [...parsed.data.didWell, ...parsed.data.practice, parsed.data.openingInsight, parsed.data.lesson, parsed.data.turningPointText ?? "", ...parsed.data.mistakeExplanations.map((m) => m.explanation)].join(" ");
      const unknown = (prose.match(SAN_TOKEN) ?? []).filter((tok) => !allowed.has(tok) && !allowed.has(tok.replace(/[+#]$/, "")));
      if (unknown.length) {
        logger.warn({ color, unknown: unknown.slice(0, 5) }, "AI coaching mentioned unverified moves; keeping deterministic report");
        continue;
      }
      out[color] = {
        ...report,
        didWell: parsed.data.didWell,
        practice: parsed.data.practice,
        openingInsight: parsed.data.openingInsight,
        lesson: parsed.data.lesson,
        turningPoint: report.turningPoint ? { ...report.turningPoint, text: parsed.data.turningPointText ?? report.turningPoint.text } : null,
        biggestMistakes: report.biggestMistakes.map((m) => {
          const better = parsed.data.mistakeExplanations.find((x) => x.ply === m.ply);
          return better ? { ...m, explanation: better.explanation } : m;
        }),
        source: "ai",
      };
    } catch (err) {
      if (err instanceof Anthropic.APIError) logger.warn({ status: err.status, message: err.message }, "AI coaching API error");
      else logger.warn({ err }, "AI coaching failed");
    }
  }
  return out.white.source === "ai" || out.black.source === "ai" ? out : null;
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
