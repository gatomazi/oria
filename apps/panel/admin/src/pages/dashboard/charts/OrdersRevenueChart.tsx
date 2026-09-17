import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatValor, plural } from '../../../lib/format';
import { CHART, formatMoedaCurta } from '../../../lib/chartTheme';
import { formatarDataCurta, type DiaSerie } from '../dashboardData';

function TooltipContent({ active, payload, label }: { active?: boolean; payload?: { payload: DiaSerie }[]; label?: string }) {
  const dia = payload?.[0]?.payload;
  if (!active || !dia) return null;
  return (
    <div className="ad-chart-tooltip">
      <strong>{formatarDataCurta(label || '')}</strong>
      <div>{plural(dia.pedidos, 'pedido', 'pedidos')}</div>
      <div>{dia.lucro != null ? `Faturamento ${formatValor(dia.receita)}` : formatValor(dia.receita)}</div>
      {dia.lucro != null && <div>Lucro operacional {formatValor(dia.lucro)}</div>}
    </div>
  );
}

// Volume (barras, cinza de comparação) + receita (linha na cor de série) e, quando a série vem do
// cache financeiro, lucro operacional (linha em success). Legenda fica no cabeçalho do painel (ver
// DashboardPage) pra não roubar altura do gráfico.
export function OrdersRevenueChart({ dados }: { dados: DiaSerie[] }) {
  const comLucro = dados.some((d) => d.lucro != null);
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={dados} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={CHART.grade} vertical={false} />
        <XAxis dataKey="data" tickFormatter={formatarDataCurta} tick={CHART.tick} axisLine={{ stroke: CHART.eixo }} tickLine={false} interval="preserveStartEnd" minTickGap={16} />
        <YAxis yAxisId="pedidos" tick={CHART.tick} axisLine={false} tickLine={false} width={28} allowDecimals={false} />
        <YAxis yAxisId="receita" orientation="right" tick={CHART.tick} axisLine={false} tickLine={false} width={64} tickFormatter={formatMoedaCurta} />
        <Tooltip content={<TooltipContent />} cursor={{ fill: CHART.cursor }} />
        <Bar yAxisId="pedidos" dataKey="pedidos" fill={CHART.comparacao} radius={[3, 3, 0, 0]} maxBarSize={18} name="Pedidos" isAnimationActive={false} />
        <Line yAxisId="receita" type="monotone" dataKey="receita" stroke={CHART.serie} strokeWidth={2} dot={false} name="Receita" isAnimationActive={false} />
        {comLucro && (
          <Line yAxisId="receita" type="monotone" dataKey="lucro" stroke={CHART.lucro} strokeWidth={2} dot={false} name="Lucro operacional" isAnimationActive={false} />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
