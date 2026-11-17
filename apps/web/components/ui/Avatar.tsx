import { cn } from "@/lib/cn";

const palette = ["#f0a53a", "#5b9bff", "#3fcf7f", "#ef5f57", "#b47aff", "#2dd4bf", "#f472b6", "#fb923c"];

function hue(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length]!;
}

export function Avatar({ name, src, size = 40, className, status }: { name: string; src?: string | null; size?: number; className?: string; status?: "online" | "offline" | "playing" | null }) {
  const initials = name.slice(0, 2).toUpperCase();
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      {src ? (
        <img src={src} alt="" width={size} height={size} className="h-full w-full rounded-full object-cover" />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center rounded-full font-semibold text-white"
          style={{ background: hue(name), fontSize: Math.max(10, size * 0.38) }}
          aria-hidden
        >
          {initials}
        </span>
      )}
      {status ? (
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-surface",
            status === "online" && "bg-success",
            status === "playing" && "bg-accent",
            status === "offline" && "bg-fg-faint",
          )}
          style={{ width: Math.max(10, size * 0.3), height: Math.max(10, size * 0.3) }}
          title={status}
        />
      ) : null}
    </span>
  );
}
