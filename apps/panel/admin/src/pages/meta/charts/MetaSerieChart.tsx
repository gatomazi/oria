import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART, formatMoedaCurta } from '../../../lib/chartTheme';
import { metaReais, metaRoas } from '../../../lib/meta';

// Investimento (barra, cinza de comparação) × receita atribuída (linha na cor de série), por dia.
// Mesmo desenho do OrdersRevenueChart e do GaSerieDiariaChart — a terceira tela de análise do painel
// não inventa um visual próprio.
//
// As duas séries são dinheiro e compartilham o MESMO eixo de propósito: é a comparação entre elas
// que responde "o dia se pagou?". Dois eixos com escalas diferentes deixariam as linhas visualmente
// empatadas num dia de ROAS 0,5 e num de ROAS 5 (spec §42).
interface PontoSerieMeta {
  data: string;
  spend: number;
  purchaseValue: number;
  purchases: number;
  roas: number | null;
}

function formatarDataCurta(iso: string): string {
  const [, mes, dia] = iso.split('-');
  return `${dia}/${mes}`;
}

function TooltipContent({ active, payload, label }: { active?: boolean; payload?: { payload: PontoSerieMeta }[]; label?: string }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0].payload;
  return (
    <div className="ad-chart-tooltip">
      <strong>{formatarDataCurta(label || '')}</strong>
      <div>Investimento {metaReais(p.spend)}</div>
      <div>Receita Meta {metaReais(p.purchaseValue)}</div>
      <div>ROAS {metaRoas(p.roas)}</div>
    </div>
  );
}

export function MetaSerieChart({ dados }: { dados: PontoSerieMeta[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={dados} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={CHART.grade} vertical={false} />
        <XAxis
          dataKey="data"
          tickFormatter={formatarDataCurta}
          tick={CHART.tick}
          axisLine={{ stroke: CHART.eixo }}
          tickLine={false}
          interval="preserveStartEnd"
          minTickGap={16}
        />
        <YAxis tick={CHART.tick} axisLine={false} tickLine={false} width={64} tickFormatter={formatMoedaCurta} />
        <Tooltip content={<TooltipContent />} cursor={{ fill: CHART.cursor }} />
        <Bar dataKey="spend" fill={CHART.comparacao} radius={[3, 3, 0, 0]} maxBarSize={18} name="Investimento" isAnimationActive={false} />
        <Line type="monotone" dataKey="purchaseValue" stroke={CHART.serie} strokeWidth={2} dot={false} name="Receita Meta" isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
