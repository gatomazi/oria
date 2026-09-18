import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import type { StatusPoint } from '../dashboardData';

// Legenda só com estágios que têm pedido (estágio zerado é ruído — ver auditoria §11); o total no
// centro continua contando todos.
export function OrderStatusDonut({ dados }: { dados: StatusPoint[] }) {
  const total = dados.reduce((acc, d) => acc + d.count, 0);
  const comDado = dados.filter((d) => d.count > 0);

  return (
    <div className="ad-donut">
      <div className="ad-donut__chart" role="img" aria-label={`${total} pedidos por estágio: ${comDado.map((d) => `${d.label} ${d.count}`).join(', ')}`}>
        <ResponsiveContainer width="100%" height={168}>
          <PieChart>
            <Pie data={comDado} dataKey="count" nameKey="label" innerRadius={52} outerRadius={74} paddingAngle={comDado.length > 1 ? 2 : 0} stroke="none" isAnimationActive={false}>
              {comDado.map((d) => (
                <Cell key={d.status} fill={d.color} fillOpacity={d.opacidade} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="ad-donut__centro">
          <strong>{total.toLocaleString('pt-BR')}</strong>
          <span>{total === 1 ? 'pedido' : 'pedidos'}</span>
        </div>
      </div>
      <ul className="ad-donut__legenda">
        {comDado.map((d) => (
          <li key={d.status}>
            <span className="ad-donut__dot" style={{ background: d.color, opacity: d.opacidade }} />
            <span className="ad-donut__label">{d.label}</span>
            <span className="ad-donut__valor">
              {d.count} <em>{Math.round((d.count / total) * 100)}%</em>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
