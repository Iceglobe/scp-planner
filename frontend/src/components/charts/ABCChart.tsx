import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, TooltipProps } from 'recharts'
import { ABC_COLORS, fmtCurrency } from '../../utils/formatters'

interface AbcSummary { A: number; B: number; C: number }

function ChartTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#1a4731' }} className="rounded-xl shadow-xl px-3.5 py-2.5">
      <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: '#86efac' }}>{payload[0].name}</p>
      <p className="text-sm font-semibold text-white">{payload[0].value} SKUs</p>
    </div>
  )
}

export function ABCPieChart({ counts }: { counts: AbcSummary }) {
  const total = counts.A + counts.B + counts.C
  const data = [
    { name: 'Class A', value: counts.A, color: ABC_COLORS.A },
    { name: 'Class B', value: counts.B, color: ABC_COLORS.B },
    { name: 'Class C', value: counts.C, color: ABC_COLORS.C },
  ].filter(d => d.value > 0)

  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={160}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%"
            innerRadius={50} outerRadius={72} paddingAngle={3} strokeWidth={0}
          >
            {data.map((d, i) => <Cell key={i} fill={d.color} />)}
          </Pie>
          <Tooltip content={<ChartTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      {/* Center stat */}
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="text-2xl font-serif font-normal text-white">{total}</span>
        <span className="text-[10px] uppercase tracking-widest text-white/70">SKUs</span>
      </div>
    </div>
  )
}

export function ABCRevenueBar({ items }: { items: { abc_class?: string; revenue: number }[] }) {
  const agg = { A: 0, B: 0, C: 0 }
  for (const item of items) {
    const cls = item.abc_class as 'A' | 'B' | 'C' || 'C'
    agg[cls] += item.revenue
  }
  const data = [
    { class: 'A', revenue: agg.A, color: ABC_COLORS.A },
    { class: 'B', revenue: agg.B, color: ABC_COLORS.B },
    { class: 'C', revenue: agg.C, color: ABC_COLORS.C },
  ]

  function BarTooltip({ active, payload }: TooltipProps<number, string>) {
    if (!active || !payload?.length) return null
    return (
      <div style={{ background: '#1e3a5f' }} className="rounded-xl shadow-xl px-3.5 py-2.5">
        <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: '#bfdbfe' }}>Class {payload[0].payload.class}</p>
        <p className="text-sm font-semibold text-white">{fmtCurrency(payload[0].value as number)}</p>
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={140}>
      <BarChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
        <XAxis dataKey="class" tick={{ fontSize: 11, fill: 'rgba(255,255,255,0.7)' }} tickLine={false} axisLine={false} />
        <YAxis tickFormatter={v => fmtCurrency(v)} tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.7)' }} tickLine={false} axisLine={false} width={60} />
        <Tooltip content={<BarTooltip />} />
        <Bar dataKey="revenue" name="Revenue" radius={[4, 4, 0, 0]}>
          {data.map((d, i) => <Cell key={i} fill={d.color} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
