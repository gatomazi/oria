// Sparkline mínimo (SVG puro, sem lib de gráfico) da célula de KPI — só aparece quando há série
// real o bastante pra dizer algo (ver KpiCard). Traço em `info` (DESIGN.md › KPI Strip).
interface MiniSparklineProps {
  values: number[];
  width?: number;
  height?: number;
}

export function MiniSparkline({ values, width = 56, height = 18 }: MiniSparklineProps) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = width / (values.length - 1);
  const points = values.map((v, i) => `${i * step},${height - ((v - min) / range) * (height - 2) - 1}`).join(' ');

  return (
    <svg className="ds-sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <polyline points={points} fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
