"use client";

import * as React from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from "recharts";
import { TIME_CONTROLS, type RatingCategory } from "@tempo/shared";
import { Segmented } from "@/components/ui/Segmented";
import type { RatingPoint } from "@/lib/queries/profile";

const COLORS: Record<RatingCategory, string> = { BULLET: "#ef5f57", BLITZ: "#f0a53a", RAPID: "#5b9bff" };

export function RatingChart({ points, startRating }: { points: RatingPoint[]; startRating: number }) {
  const available = (["BULLET", "BLITZ", "RAPID"] as RatingCategory[]).filter((c) => points.some((p) => p.category === c));
  const [category, setCategory] = React.useState<RatingCategory>(available[0] ?? "BLITZ");
  const data = React.useMemo(() => {
    const series = points.filter((p) => p.category === category);
    if (!series.length) return [];
    return [{ t: series[0]!.t - 1, rating: startRating }, ...series].map((p, i) => ({ i, t: p.t, rating: p.rating }));
  }, [points, category, startRating]);

  if (!available.length) return <p className="py-8 text-center text-sm text-fg-muted">Rating history appears after the first rated game.</p>;
  const min = Math.min(...data.map((d) => d.rating)) - 30;
  const max = Math.max(...data.map((d) => d.rating)) + 30;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <Segmented size="sm" value={category} onChange={setCategory} options={available.map((c) => ({ value: c, label: TIME_CONTROLS[c].name }))} />
        <span className="text-xs text-fg-faint">{data.length - 1} rated games</span>
      </div>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="i" tick={{ fill: "var(--fg-faint)", fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v) => (v === 0 ? "" : String(v))} />
            <YAxis domain={[Math.floor(min / 50) * 50, Math.ceil(max / 50) * 50]} tick={{ fill: "var(--fg-faint)", fontSize: 11 }} tickLine={false} axisLine={false} width={48} />
            <Tooltip
              contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 12 }}
              labelFormatter={(v) => (Number(v) === 0 ? "Start" : `Game ${v}`)}
              formatter={(value) => [String(value), "Rating"]}
            />
            <Line type="monotone" dataKey="rating" stroke={COLORS[category]} strokeWidth={2.5} dot={data.length < 40} activeDot={{ r: 5 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
