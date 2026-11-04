import React from 'react';

export function Button({ children, className = '', variant = 'default', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' | 'danger' }) {
  const v = variant === 'primary' ? 'btn-primary' : variant === 'ghost' ? 'btn-ghost' : variant === 'danger' ? 'btn-danger' : '';
  return <button className={`btn ${v} rounded-xl px-5 py-3 text-sm md:text-base ${className}`} {...rest}>{children}</button>;
}

export function Panel({ children, className = '', title, onBack, right }: { children: React.ReactNode; className?: string; title?: string; onBack?: () => void; right?: React.ReactNode }) {
  return (
    <div className={`panel rounded-2xl p-4 md:p-6 ${className}`}>
      {(title || onBack) && (
        <div className="flex items-center gap-3 mb-4">
          {onBack && <button onClick={onBack} className="btn btn-ghost rounded-lg px-3 py-2 text-xs">← Back</button>}
          {title && <h2 className="font-display text-xl md:text-3xl font-black tracking-wider gradient-text">{title}</h2>}
          <div className="ml-auto">{right}</div>
        </div>
      )}
      {children}
    </div>
  );
}

export function Pill({ children, color = '#22d3ee', className = '' }: { children: React.ReactNode; color?: string; className?: string }) {
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-bold tracking-wider uppercase ${className}`} style={{ background: `${color}22`, color, border: `1px solid ${color}66` }}>{children}</span>;
}

export function Spinner() {
  return <div className="w-10 h-10 rounded-full border-4 border-cyan-400/30 border-t-cyan-400 anim-spin" />;
}

export function Stat({ label, value, color = '#fff' }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div className="flex flex-col items-center px-3">
      <div className="text-[10px] uppercase tracking-widest text-white/50 font-bold">{label}</div>
      <div className="font-display text-lg md:text-2xl font-bold" style={{ color }}>{value}</div>
    </div>
  );
}

export function CarColorDot({ color, size = 12 }: { color: string; size?: number }) {
  return <span className="inline-block rounded-full" style={{ width: size, height: size, background: color, boxShadow: `0 0 8px ${color}` }} />;
}

export function Overlay({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`absolute inset-0 flex items-center justify-center p-4 ${className}`} style={{ paddingTop: 'calc(var(--safe-top) + 1rem)', paddingBottom: 'calc(var(--safe-bottom) + 1rem)' }}>{children}</div>;
}
