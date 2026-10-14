import { useId } from 'react';

/** Inline SVG sparkline: soft area + line, scales to its container. */
export function Sparkline({ values, color = 'var(--accent)', height = 34 }: { values: number[]; color?: string; height?: number }) {
  const id = useId().replace(/:/g, '');
  const w = 100;
  const h = 32;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [values.length === 1 ? w / 2 : (i / (values.length - 1)) * w, h - 2 - ((v - min) / span) * (h - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  const flat = values.every((v) => v === 0);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" width="100%" height={height} aria-hidden="true" className="block">
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity={flat ? 0 : 0.22} />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#g${id})`} />
      <path d={line} fill="none" stroke={flat ? 'var(--line-strong)' : color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={flat ? '3 3' : undefined} />
    </svg>
  );
}
