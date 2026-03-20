import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer, TooltipProps,
} from 'recharts'
import { fmtNumber } from '../../utils/formatters'
import type { ProjectionWeek } from '../../api/types'

function ChartTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#1e3a5f' }} className="rounded-xl px-3.5 py-2.5 shadow-xl">
      <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: '#bfdbfe' }}>Week {label}</p>
      <p className="text-sm font-semibold text-white">{fmtNumber(payload[0].value as number)} units</p>
    </div>
  )
}

export function InventoryProjectionChart({ data }: { data: ProjectionWeek[] }) {
  const ss = data[0]?.safety_stock
  const rop = data[0]?.reorder_point

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 10, right: 52, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="posGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#60a5fa" stopOpacity={0.25} />
            <stop offset="100%" stopColor="#60a5fa" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="week" tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.7)' }} tickLine={false} axisLine={false}
          tickFormatter={v => `W${v}`} />
        <YAxis tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.7)' }} tickLine={false} axisLine={false}
          tickFormatter={v => fmtNumber(v)} width={45} />
        <Tooltip content={<ChartTooltip />} />
        <Area dataKey="position" name="Projected Balance" stroke="#60a5fa" strokeWidth={2.5}
          fill="url(#posGrad)" type="monotone" dot={false}
          activeDot={{ r: 5, fill: '#60a5fa', stroke: '#dbeafe', strokeWidth: 2 }} />
        {ss != null && (
          <ReferenceLine y={ss} stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="5 3"
            label={{ value: 'Safety Stock', position: 'insideTopRight', fontSize: 9, fill: '#f59e0b', fontWeight: 600 }} />
        )}
        {rop != null && (
          <ReferenceLine y={rop} stroke="#ef4444" strokeWidth={1.5} strokeDasharray="5 3"
            label={{ value: 'ROP', position: 'insideTopRight', fontSize: 9, fill: '#ef4444', fontWeight: 600 }} />
        )}
      </AreaChart>
    </ResponsiveContainer>
  )
}
