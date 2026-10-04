import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import type { StatusPoint } from '../dashboardData';

// Legenda só com estágios que têm pedido (estágio zerado é ruído — ver auditoria §11); o total no
// centro continua contando todos.
export function OrderStatusDonut({ dados }: { dados: StatusPoint[] }) {
  const total = dados.reduce((acc, d) => acc + d.count, 0);
  const comDado = dados.filter((d) => d.count > 0);

  return (
    <div className="oa-donut">
      <div className="oa-donut__chart" role="img" aria-label={`${total} pedidos por estágio: ${comDado.map((d) => `${d.label} ${d.count}`).join(', ')}`}>
        <ResponsiveContainer width="100%" height={168}>
          <PieChart>
            <Pie data={comDado} dataKey="count" nameKey="label" innerRadius={52} outerRadius={74} paddingAngle={comDado.length > 1 ? 2 : 0} stroke="none" isAnimationActive={false}>
              {comDado.map((d) => (
                <Cell key={d.status} fill={d.color} fillOpacity={d.opacidade} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="oa-donut__centro">
          <strong>{total.toLocaleString('pt-BR')}</strong>
          <span>{total === 1 ? 'pedido' : 'pedidos'}</span>
        </div>
      </div>
      <ul className="oa-donut__legenda">
        {comDado.map((d) => (
          <li key={d.status}>
            <span className="oa-donut__dot" style={{ background: d.color, opacity: d.opacidade }} />
            <span className="oa-donut__label">{d.label}</span>
            <span className="oa-donut__valor">
              {d.count} <em>{Math.round((d.count / total) * 100)}%</em>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
