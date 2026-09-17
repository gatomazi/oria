import { Bar, BarChart, ResponsiveContainer } from 'recharts';
import { CHART } from '../../../lib/chartTheme';

export function RecoveryChart({ dados }: { dados: { data: string; mensagens: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={56}>
      <BarChart data={dados} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
        <Bar dataKey="mensagens" fill={CHART.serie} radius={[2, 2, 0, 0]} maxBarSize={6} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}
