"use client";

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export function AccuracyTrend({ points }: { points: { gameId: string; date: string; accuracy: number; result: "win" | "loss" | "draw" }[] }) {
  const data = points.slice(-30).map((p, i) => ({ ...p, i: i + 1, label: new Date(p.date).toLocaleDateString(undefined, { month: "short", day: "numeric" }) }));
  const color = (r: string) => (r === "win" ? "#3fcf7f" : r === "loss" ? "#ef5f57" : "#9aa3b0");
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="i" tick={{ fill: "var(--fg-faint)", fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis domain={[0, 100]} tick={{ fill: "var(--fg-faint)", fontSize: 11 }} tickLine={false} axisLine={false} />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 12 }}
            formatter={(v, _n, item) => [`${Number(v).toFixed(1)}% (${(item.payload as { result: string }).result})`, "Accuracy"]}
            labelFormatter={(_l, payload) => (payload?.[0]?.payload as { label?: string } | undefined)?.label ?? ""}
          />
          <Bar dataKey="accuracy" radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.gameId} fill={color(d.result)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
