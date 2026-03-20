import {
  ComposedChart, Bar, Line, Area, XAxis, YAxis,
  Tooltip, Legend, ResponsiveContainer, TooltipProps,
} from 'recharts'
import { fmtNumber } from '../../utils/formatters'

interface DataPoint {
  label: string
  actual?: number
  forecast?: number
  lower?: number
  upper?: number
  safety_stock?: number
}

function ChartTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null
  const entries = payload.filter(p => p.dataKey !== 'upper' && p.dataKey !== 'lower' && p.value != null)
  if (!entries.length) return null
  return (
    <div style={{ background: 'rgba(0,0,0,0.72)', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(16px)' }} className="rounded-xl shadow-2xl px-3.5 py-2.5 min-w-[130px]">
      <p className="text-[10px] uppercase tracking-widest mb-2" style={{ color: 'rgba(255,255,255,0.4)', letterSpacing: '0.12em' }}>{label}</p>
      {entries.map((p, i) => (
        <div key={i} className="flex items-center justify-between gap-4 text-xs mb-1 last:mb-0">
          <span className="flex items-center gap-1.5" style={{ color: 'rgba(255,255,255,0.6)' }}>
            <span className="w-1.5 h-1.5 rounded-full inline-block shrink-0" style={{ background: p.color }} />
            {p.name}
          </span>
          <span className="font-semibold" style={{ color: 'rgba(255,255,255,0.95)' }}>{fmtNumber(p.value as number)}</span>
        </div>
      ))}
    </div>
  )
}

export function ForecastChart({
  data, title,
}: {
  data: DataPoint[]; title?: string;
}) {
  return (
    <div>
      {title && <p className="text-[11px] font-medium uppercase tracking-widest text-white/60 mb-3">{title}</p>}
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#34d399" stopOpacity={0.55} />
              <stop offset="100%" stopColor="#059669" stopOpacity={0.18} />
            </linearGradient>
            <linearGradient id="ciGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6ee7b7" stopOpacity={0.07} />
              <stop offset="100%" stopColor="#6ee7b7" stopOpacity={0} />
            </linearGradient>
          </defs>

          <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.3)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.3)' }} tickLine={false} axisLine={false}
            tickFormatter={v => fmtNumber(v)} width={45} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
          <Legend
            wrapperStyle={{ fontSize: 10, paddingTop: 14 }}
            formatter={(value) => <span style={{ color: 'rgba(255,255,255,0.8)', letterSpacing: '0.05em' }}>{value}</span>}
          />

          {/* Confidence band */}
          <Area dataKey="upper" fill="url(#ciGrad)" stroke="none" legendType="none" />
          <Area dataKey="lower" fill="transparent" stroke="none" legendType="none" />

          {/* Actuals — gradient bars */}
          <Bar dataKey="actual" name="Actual" fill="url(#barGrad)"
            radius={[2, 2, 0, 0]} barSize={10} />

          {/* Forecast — dashed mint line */}
          <Line dataKey="forecast" name="Forecast" stroke="rgba(110,231,183,0.7)" strokeWidth={1.5}
            type="monotone" dot={false}
            activeDot={{ r: 3, fill: '#6ee7b7', stroke: 'rgba(255,255,255,0.2)', strokeWidth: 1 }}
            strokeDasharray="5 4" />

        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
