import { Area, Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatValor, plural } from '../../../lib/format';
import { CHART, formatMoedaCurta } from '../../../lib/chartTheme';
import { formatarDataCurta, type DiaSerie } from '../dashboardData';

function TooltipContent({ active, payload, label, ocultarValores }: { active?: boolean; payload?: { payload: DiaSerie }[]; label?: string; ocultarValores?: boolean }) {
  const dia = payload?.[0]?.payload;
  if (!active || !dia) return null;
  return (
    <div className="ad-chart-tooltip">
      <strong>{formatarDataCurta(label || '')}</strong>
      <div>{plural(dia.pedidos, 'pedido', 'pedidos')}</div>
      {!ocultarValores && <div>{dia.lucro != null ? `Faturamento ${formatValor(dia.receita)}` : formatValor(dia.receita)}</div>}
      {!ocultarValores && dia.lucro != null && <div>Lucro bruto {formatValor(dia.lucro)}</div>}
    </div>
  );
}

// Volume (barras, cinza de comparação) + receita (linha na cor de série) e, quando a série vem do
// cache financeiro, lucro bruto — campo lucroOperacional, venda − custo de produção, antes da mídia
// (linha em success). Modo discreto (`ocultarValores`): só o volume de pedidos fica; linhas, área,
// eixo em reais e valores do tooltip nem são renderizados (o traçado também revelaria o negócio). Legenda fica no cabeçalho do painel (ver
// DashboardPage) pra não roubar altura do gráfico.
export function OrdersRevenueChart({ dados, ocultarValores = false }: { dados: DiaSerie[]; ocultarValores?: boolean }) {
  const comLucro = !ocultarValores && dados.some((d) => d.lucro != null);
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={dados} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
        {/* Evolução visual (Fase 1): área suave sob o faturamento — dá peso à série principal sem
            virar decoração (some em direção ao eixo, 16% → 0%). */}
        <defs>
          <linearGradient id="ad-area-receita" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--info)" stopOpacity={0.22} />
            <stop offset="100%" stopColor="var(--info)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={CHART.grade} vertical={false} />
        <XAxis dataKey="data" tickFormatter={formatarDataCurta} tick={CHART.tick} axisLine={{ stroke: CHART.eixo }} tickLine={false} interval="preserveStartEnd" minTickGap={16} />
        <YAxis yAxisId="pedidos" tick={CHART.tick} axisLine={false} tickLine={false} width={28} allowDecimals={false} />
        {!ocultarValores && <YAxis yAxisId="receita" orientation="right" tick={CHART.tick} axisLine={false} tickLine={false} width={72} tickFormatter={formatMoedaCurta} />}
        <Tooltip content={<TooltipContent ocultarValores={ocultarValores} />} cursor={{ fill: CHART.cursor }} />
        <Bar yAxisId="pedidos" dataKey="pedidos" fill={CHART.comparacao} radius={[3, 3, 0, 0]} maxBarSize={18} name="Pedidos" isAnimationActive={false} />
        {!ocultarValores && <Area yAxisId="receita" type="monotone" dataKey="receita" stroke="none" fill="url(#ad-area-receita)" isAnimationActive={false} legendType="none" tooltipType="none" />}
        {!ocultarValores && <Line yAxisId="receita" type="monotone" dataKey="receita" stroke={CHART.serie} strokeWidth={2} dot={false} name="Receita" isAnimationActive={false} />}
        {comLucro && (
          <Line yAxisId="receita" type="monotone" dataKey="lucro" stroke={CHART.lucro} strokeWidth={2} dot={false} name="Lucro bruto" isAnimationActive={false} />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
