import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  TooltipProps, LabelList,
} from 'recharts'
import { fmtCurrency } from '../../utils/formatters'
import type { TrendPoint } from '../../api/types'

// ── Tooltip ──────────────────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload as BarPoint
  return (
    <div className="glass-dark rounded-xl px-3.5 py-2.5 shadow-2xl text-left min-w-[140px] border border-white/20">
      <p className="text-[10px] uppercase font-bold tracking-widest mb-1 text-white/50">{label}</p>
      <p className="text-base font-bold text-white">{fmtCurrency(payload[0].value as number)}</p>
      {d.is_projected && <p className="text-[10px] text-white/60 font-bold mt-0.5 italic">Projected</p>}
      {d.delta != null && (
        <p className={`text-[10px] mt-0.5 font-bold ${d.delta >= 0 ? 'text-white/60' : 'text-red-400'}`}>
          {d.delta >= 0 ? '▲' : '▼'} {fmtCurrency(Math.abs(d.delta))}
        </p>
      )}
    </div>
  )
}

// ── Shared label for top-3 annotations ───────────────────────────────────────
function DeltaLabel(props: Record<string, unknown>) {
  const { x, y, width, highlight } = props as {
    x: number; y: number; width: number; value: number; highlight?: 'up' | 'down'
  }
  if (!highlight) return null
  const isUp = highlight === 'up'
  const cx = x + width / 2
  const cy = isUp ? (y as number) - 8 : (y as number) - 8
  return (
    <text x={cx} y={cy} textAnchor="middle" fontSize={11} fontWeight={800}
      fill={isUp ? '#ffffff' : '#f87171'}>
      {isUp ? '▲' : '▼'}
    </text>
  )
}

// ── Data shape used internally ────────────────────────────────────────────────
interface BarPoint {
  label: string
  value: number
  is_projected: boolean
  delta: number | null
  highlight?: 'up' | 'down'
}

function buildBarData(data: TrendPoint[], valueKey: 'value' | 'revenue'): BarPoint[] {
  const mapped: BarPoint[] = data.map((d, i) => {
    const val = (valueKey === 'revenue' ? d.revenue : d.value) ?? 0
    const prev = i > 0 ? ((valueKey === 'revenue' ? data[i - 1].revenue : data[i - 1].value) ?? 0) : null
    return {
      label: d.label || d.period || '',
      value: val,
      is_projected: d.is_projected ?? false,
      delta: prev != null ? val - prev : null,
    }
  })

  // Mark top-3 increases and top-3 drops
  const withDelta = mapped.filter(p => p.delta != null)
  const sorted = [...withDelta].sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))
  const top3up = new Set(sorted.slice(0, 3).map(p => p.label))
  const top3down = new Set(sorted.slice(-3).map(p => p.label))

  return mapped.map(p => ({
    ...p,
    highlight: top3up.has(p.label) ? 'up' : top3down.has(p.label) ? 'down' : undefined,
  }))
}

// ── Inventory column chart ────────────────────────────────────────────────────
export function InventoryTrendChart({ data }: { data: TrendPoint[] }) {
  const bars = buildBarData(data, 'value')

  return (
    <div className="mt-2">
      <div className="flex items-center gap-4 mb-4 text-[10px] font-bold uppercase tracking-wider text-white/70">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px] inline-block" style={{ background: 'rgba(255,255,255,0.7)' }} /> Historical</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px] inline-block" style={{ background: 'rgba(255,255,255,0.3)' }} /> Projected</span>
        <span className="flex items-center gap-1.5 text-white/60">▲ Top 3 increases</span>
        <span className="flex items-center gap-1.5 text-red-400">▼ Top 3 drops</span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={bars} margin={{ top: 18, right: 4, bottom: 0, left: 0 }} barCategoryGap="20%">
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.7)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis hide />
          <Tooltip content={<ChartTooltip />} />
          <Bar dataKey="value" radius={[3, 3, 0, 0]}>
            {bars.map((b, i) => (
              <Cell
                key={i}
                fill={
                  b.highlight === 'up' ? '#ffffff'
                  : b.highlight === 'down' ? '#f87171'
                  : b.is_projected ? 'rgba(255,255,255,0.2)'
                  : 'rgba(255,255,255,0.6)'
                }
              />
            ))}
            <LabelList
              dataKey="value"
              content={(props) => (
                <DeltaLabel
                  {...props}
                  highlight={bars[(props as { index?: number }).index ?? 0]?.highlight}
                />
              )}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Demand column chart ───────────────────────────────────────────────────────
export function DemandTrendChart({ data }: { data: TrendPoint[] }) {
  const bars = buildBarData(data, 'revenue')

  return (
    <div className="mt-2">
      <div className="flex items-center gap-4 mb-4 text-[10px] font-bold uppercase tracking-wider text-white/70">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px] inline-block" style={{ background: 'rgba(255,255,255,0.7)' }} /> Historical</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px] inline-block" style={{ background: 'rgba(255,255,255,0.3)' }} /> Forecasted</span>
        <span className="flex items-center gap-1.5 text-white/60">▲ Top 3 increases</span>
        <span className="flex items-center gap-1.5 text-red-400">▼ Top 3 drops</span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={bars} margin={{ top: 18, right: 4, bottom: 0, left: 0 }} barCategoryGap="20%">
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.7)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis hide />
          <Tooltip content={<ChartTooltip />} />
          <Bar dataKey="value" radius={[3, 3, 0, 0]}>
            {bars.map((b, i) => (
              <Cell
                key={i}
                fill={
                  b.highlight === 'up' ? '#ffffff'
                  : b.highlight === 'down' ? '#f87171'
                  : b.is_projected ? 'rgba(255,255,255,0.2)'
                  : 'rgba(255,255,255,0.6)'
                }
              />
            ))}
            <LabelList
              dataKey="value"
              content={(props) => (
                <DeltaLabel
                  {...props}
                  highlight={bars[(props as { index?: number }).index ?? 0]?.highlight}
                />
              )}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
