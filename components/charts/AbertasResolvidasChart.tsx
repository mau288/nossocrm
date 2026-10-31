import React from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

interface AbertasResolvidasChartProps {
  data: Array<{ dia: string; abertas: number; resolvidas: number }>;
}

const diaCurto = (iso: string) => {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
};

/**
 * ARK Onda 3: conversas abertas x resolvidas por dia (Relatorios > Gestao).
 * Mesmo visual do grafico de tendencia (variaveis --chart-*).
 */
export const AbertasResolvidasChart: React.FC<AbertasResolvidasChartProps> = ({ data }) => (
  <ResponsiveContainer width="100%" height="100%" debounce={50}>
    <BarChart data={data} barGap={2}>
      <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
      <XAxis
        dataKey="dia"
        tickFormatter={diaCurto}
        axisLine={false}
        tickLine={false}
        tick={{ fill: 'var(--chart-text)', fontSize: 11 }}
        minTickGap={18}
        dy={8}
      />
      <YAxis
        allowDecimals={false}
        axisLine={false}
        tickLine={false}
        tick={{ fill: 'var(--chart-text)', fontSize: 11 }}
        width={34}
      />
      <Tooltip
        labelFormatter={(v) => diaCurto(String(v))}
        contentStyle={{
          backgroundColor: 'var(--chart-tooltip-bg)',
          border: '1px solid var(--chart-tooltip-border)',
          borderRadius: '12px',
          color: 'var(--chart-tooltip-text)',
          boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
        }}
        labelStyle={{ color: 'var(--chart-text)' }}
      />
      <Legend wrapperStyle={{ fontSize: 12 }} />
      <Bar dataKey="abertas" name="Abertas" fill="#0ea5e9" radius={[4, 4, 0, 0]} />
      <Bar dataKey="resolvidas" name="Resolvidas" fill="#22c55e" radius={[4, 4, 0, 0]} />
    </BarChart>
  </ResponsiveContainer>
);

export default AbertasResolvidasChart;
