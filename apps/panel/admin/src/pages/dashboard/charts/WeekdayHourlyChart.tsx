import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { plural } from '../../../lib/format';
import { CHART } from '../../../lib/chartTheme';

interface Ponto {
  label: string;
  orders: number;
}

// Mesmo gráfico de barra serve pra "Pedidos por dia da semana" e "Melhores horários" — só muda a
// série (ver dashboardData.serieDiaSemana/serieHorario). Série única, então cor única (`info`).
export function WeekdayHourlyChart({ dados }: { dados: Ponto[] }) {
  return (
    <ResponsiveContainer width="100%" height={150}>
      <BarChart data={dados} margin={{ top: 16, right: 4, left: 4, bottom: 0 }}>
        <XAxis dataKey="label" tick={CHART.tick} axisLine={{ stroke: CHART.eixo }} tickLine={false} />
        <Tooltip
          cursor={{ fill: CHART.cursor }}
          content={({ active, payload, label }) =>
            active && payload && payload.length ? (
              <div className="ad-chart-tooltip">
                <strong>{label}</strong>
                <div>{plural(Number(payload[0]?.value ?? 0), 'pedido', 'pedidos')}</div>
              </div>
            ) : null
          }
        />
        <Bar dataKey="orders" fill={CHART.serie} radius={[3, 3, 0, 0]} maxBarSize={22} isAnimationActive={false} label={{ position: 'top', fill: 'var(--text-muted)', fontSize: 11 }} />
      </BarChart>
    </ResponsiveContainer>
  );
}
