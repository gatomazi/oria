import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatValor, plural } from '../../../lib/format';
import { CHART, formatMoedaCurta, formatNumeroCurto } from '../../../lib/chartTheme';

// Só o que o gráfico de fato desenha — assim a série da aba Performance (por combinação de UTM) e a
// do panorama do Analytics (loja inteira) usam o mesmo componente sem um tipo servir de molde pro outro.
interface PontoSerie {
  data: string;
  sessions: number;
  revenue: number;
}

function formatarDataCurta(iso: string): string {
  const [, mes, dia] = iso.split('-');
  return `${dia}/${mes}`;
}

function TooltipContent({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="ad-chart-tooltip">
      <strong>{formatarDataCurta(label || '')}</strong>
      <div>{plural(payload[0]?.value ?? 0, 'sessão', 'sessões')}</div>
      <div>{formatValor(payload[1]?.value ?? 0)}</div>
    </div>
  );
}

// Sessões (barra, cinza de comparação) + receita (linha na cor de série) — mesmo padrão de
// OrdersRevenueChart no dashboard, pro detalhe diário de 1 combinação de UTM não inventar um
// visual novo pro painel.
export function GaSerieDiariaChart({ dados }: { dados: PontoSerie[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={dados} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={CHART.grade} vertical={false} />
        <XAxis dataKey="data" tickFormatter={formatarDataCurta} tick={CHART.tick} axisLine={{ stroke: CHART.eixo }} tickLine={false} interval="preserveStartEnd" minTickGap={16} />
        {/* width menor que o rótulo corta o número no eixo (o 28px herdado do dashboard só servia
            pra contagem de 3 dígitos; aqui a sessão diária passa de mil). */}
        <YAxis yAxisId="sessoes" tick={CHART.tick} axisLine={false} tickLine={false} width={52} allowDecimals={false} tickFormatter={formatNumeroCurto} />
        <YAxis yAxisId="receita" orientation="right" tick={CHART.tick} axisLine={false} tickLine={false} width={64} tickFormatter={formatMoedaCurta} />
        <Tooltip content={<TooltipContent />} cursor={{ fill: CHART.cursor }} />
        <Bar yAxisId="sessoes" dataKey="sessions" fill={CHART.comparacao} radius={[3, 3, 0, 0]} maxBarSize={18} name="Sessões" isAnimationActive={false} />
        <Line yAxisId="receita" type="monotone" dataKey="revenue" stroke={CHART.serie} strokeWidth={2} dot={false} name="Receita" isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
