import { useEffect, useState, useCallback, useMemo } from 'react'
import { Play, CheckCheck, RefreshCw, X } from 'lucide-react'
import { useSidebarActionsEffect } from '../context/SidebarActionsContext'
import { useFilters } from '../context/FilterContext'
import { MultiSelect } from '../components/ui/MultiSelect'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine, CartesianGrid,
} from 'recharts'
import type { TooltipProps } from 'recharts'
import { getPurchaseOrders, runMrp, getMrpRuns, confirmAllPos, getMrpPivot, updatePo, createPo, getKpis } from '../api'
import type { PurchaseOrder, MrpRun, MrpPivotData, MrpRow, Kpis } from '../api/types'
import { MrpPivotTable } from '../components/tables/MrpPivotTable'
import { Card, CardHeader, CardTitle, PageHeader, Button, Select, Spinner } from '../components/ui'
import { fmtCurrency, fmtDate, fmtNumber, statusLabel } from '../utils/formatters'

interface DateFilter { label: string; from: string; to: string; field: 'due_date' | 'order_date' }

const CHART_COLORS: Record<string, string> = {
  on_hand_bar: '#8fb5c7',
  customer_orders: '#208663',
  forecast: '#2aae81',
  confirmed_po: '#3b7386',
  suggested_po: '#6aaac0',
  proj_inv: '#7a90a4',
}

function SupplyChartTooltip({ active, payload, label, valueFormatter }: TooltipProps<number, string> & { valueFormatter?: (v: number) => string }) {
  if (!active || !payload?.length) return null
  const entries = payload.filter(p => p.value != null && Number(p.value) !== 0)
  if (!entries.length) return null
  const fmt = valueFormatter ?? fmtNumber
  return (
    <div style={{ background: 'rgba(0,0,0,0.8)', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(16px)' }} className="rounded-xl shadow-2xl px-3.5 py-2.5 min-w-[160px]">
      <p className="text-[10px] uppercase tracking-widest mb-2" style={{ color: 'rgba(255,255,255,0.4)' }}>{label}</p>
      {entries.map((p, i) => (
        <div key={i} className="flex items-center justify-between gap-4 text-xs mb-1 last:mb-0">
          <span className="flex items-center gap-1.5" style={{ color: 'rgba(255,255,255,0.6)' }}>
            <span className="w-1.5 h-1.5 rounded-full inline-block shrink-0" style={{ background: CHART_COLORS[p.dataKey as string] ?? p.color }} />
            {p.name}
          </span>
          <span className="font-semibold" style={{ color: 'rgba(255,255,255,0.95)' }}>{fmt(p.value as number)}</span>
        </div>
      ))}
    </div>
  )
}

function weekRangeFromDate(dateStr: string): { from: string; to: string } {
  const d = new Date(dateStr + 'T00:00:00')
  const day = d.getDay() // 0=Sun
  const diff = day === 0 ? -6 : 1 - day // shift to Monday
  const mon = new Date(d); mon.setDate(d.getDate() + diff)
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
  const fmt = (x: Date) => x.toISOString().split('T')[0]
  return { from: fmt(mon), to: fmt(sun) }
}

const HORIZON_OPTIONS = [
  { value: '8', label: '8 weeks' },
  { value: '12', label: '12 weeks' },
  { value: '16', label: '16 weeks' },
  { value: '26', label: '26 weeks' },
]

const CONSOLIDATION_OPTIONS = [
  { value: 'day', label: 'Consolidate: same day' },
  { value: 'week', label: 'Consolidate: same week' },
  { value: 'month', label: 'Consolidate: same month' },
]


type RiskLevel = 'all' | 'red' | 'amber' | 'orange' | 'green' | 'grey'

function RiskFilter({ value, onChange }: { value: RiskLevel; onChange: (v: RiskLevel) => void }) {
  const opts: { key: RiskLevel; label: string; dot: string; active: string; inactive?: string }[] = [
    { key: 'all',   label: 'All',            dot: '',               active: 'bg-brand-700 text-white' },
    { key: 'red',   label: 'Stockout',       dot: 'bg-red-500',     active: 'bg-red-600 text-white' },
    { key: 'amber', label: 'Proj. Stockout', dot: 'bg-orange-400',  active: 'bg-orange-500 text-white' },
    { key: 'orange',label: 'Below SS',       dot: 'bg-yellow-400',  active: 'bg-yellow-500 text-white' },
    { key: 'green', label: 'Healthy',        dot: 'bg-green-500',   active: 'bg-green-600 text-white' },
    { key: 'grey',  label: 'Excess',         dot: 'bg-zinc-300',    active: 'bg-white/[0.06] text-zinc-300', inactive: 'text-zinc-300' },
  ]
  return (
    <div className="flex items-center gap-1 mb-2">
      <span className="text-xs text-white/80 mr-1">Risk:</span>
      {opts.map(o => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-full transition-colors ${value === o.key ? o.active : `${o.inactive ?? 'text-white/80'} hover:bg-white/[0.06]`}`}
        >
          {o.dot && <span className={`w-1.5 h-1.5 rounded-full inline-block ${o.dot}`} />}
          {o.label}
        </button>
      ))}
    </div>
  )
}


export default function SupplyPlanning() {
  const [pos, setPos] = useState<PurchaseOrder[]>([])
  const [mrpRuns, setMrpRuns] = useState<MrpRun[]>([])
  const [kpis, setKpis] = useState<Kpis | null>(null)
  const [mrpPivot, setMrpPivot] = useState<MrpPivotData | null>(null)
  const [horizon, setHorizon] = useState('12')
  const [consolidation, setConsolidation] = useState('week')
  const [loading, setLoading] = useState(true)
  const [pivotLoading, setPivotLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [statusFilters, setStatusFilters] = useState<string[]>([])
  const [productFilter, setProductFilter] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<'explosion' | 'purchase_orders' | 'production_orders' | 'orders'>('explosion')
  const [itemTypeFilter, setItemTypeFilter] = useState<'all' | 'purchased' | 'produced'>('all')
  const [riskFilter, setRiskFilter] = useState<RiskLevel>('all')
  const [dateFilter, setDateFilter] = useState<DateFilter | null>(null)
  const [selectedProduct, setSelectedProduct] = useState<{ product_id: number; sku: string; description: string } | null>(null)
  const [vendorFilter, setVendorFilter] = useState<string[]>([])
  const [machineFilter, setMachineFilter] = useState<string[]>([])
  const [selectedPoIds, setSelectedPoIds] = useState<Set<number>>(new Set())
  const [viewUnit, setViewUnit] = useState<'qty' | 'revenue'>('qty')
  const [tableSelectedIds, setTableSelectedIds] = useState<Set<number>>(new Set())
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [orderConfirmOpen, setOrderConfirmOpen] = useState(false)
  const [placing, setPlacing] = useState(false)
  const { itemIds, productNames } = useFilters()

  // Reset to a visible tab if itemTypeFilter hides the current one
  useEffect(() => {
    if (itemTypeFilter === 'produced' && activeTab === 'purchase_orders') setActiveTab('production_orders')
    if (itemTypeFilter === 'purchased' && activeTab === 'production_orders') setActiveTab('purchase_orders')
  }, [itemTypeFilter])

  const loadPivot = useCallback(() => {
    setPivotLoading(true)
    getMrpPivot(parseInt(horizon))
      .then(setMrpPivot)
      .finally(() => setPivotLoading(false))
  }, [horizon])

  const load = useCallback(async () => {
    setLoading(true)
    const params: Record<string, string> = {}
    if (productFilter != null) params.product_id = String(productFilter)
    Promise.all([getPurchaseOrders(params), getMrpRuns(), getKpis()])
      .then(([p, r, k]) => { setPos(p); setMrpRuns(r); setKpis(k) })
      .finally(() => setLoading(false))
  }, [productFilter])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadPivot() }, [loadPivot])

  const handleRunMrp = async () => {
    setRunning(true)
    try {
      const healthThresholds = (() => { try { const s = localStorage.getItem('inventory_health_thresholds'); return s ? JSON.parse(s) : { upper: 5 } } catch { return { upper: 5 } } })()
      const lower: number = healthThresholds.lower ?? 1
      const upper: number = healthThresholds.upper ?? 4
      const min_weeks_cover: number = healthThresholds.min_weeks_cover ?? 0
      const result = await runMrp({ horizon_weeks: parseInt(horizon), consolidation, health_target_multiplier: (lower + upper) / 2, min_weeks_cover })
      alert(`MRP complete: ${result.po_count} POs recommended · ${fmtCurrency(result.total_value)}`)
      load()
      loadPivot()
    } catch (err: any) {
      alert(`MRP failed: ${err?.message ?? 'Unknown error'}`)
    } finally {
      setRunning(false)
    }
  }

  const handleExplosionDblClick = useCallback((rowType: string, productId: number) => {
    setSelectedPoIds(new Set())
    setProductFilter(productId)
    setActiveTab('orders')
  }, [])

  const handlePeriodClick = useCallback((_periodKey: string, periodLabel: string, periodDate: string) => {
    const { from, to } = weekRangeFromDate(periodDate)
    setDateFilter(f => f?.field === 'due_date' && f.from === from ? null : { label: periodLabel, from, to, field: 'due_date' })
    setActiveTab('orders')
  }, [])

  const handleProductDblClick = useCallback((productId: number, sku: string, description: string) => {
    setSelectedProduct(p => p?.product_id === productId ? null : { product_id: productId, sku, description })
  }, [])

  const handleSuggestedPoClick = useCallback((poIds: number[], productId: number) => {
    setSelectedPoIds(new Set(poIds))
    setProductFilter(productId)
    setDateFilter(null)
    const row = mrpPivot?.rows.find(r => r.product_id === productId && r.row_type === 'on_hand')
    setActiveTab(row?.item_type === 'produced' ? 'production_orders' : 'purchase_orders')
  }, [mrpPivot])

  const handleSuggestedPoEdit = useCallback(async (
    productId: number, periodKey: string, newQty: number, poIds: number[]
  ) => {
    // Create or update PO(s)
    let newPoId: number | null = null
    if (poIds.length === 0) {
      if (newQty <= 0) return
      const created = await createPo({ product_id: productId, quantity: newQty, period_key: periodKey })
      newPoId = created.id
    } else if (poIds.length === 1) {
      await updatePo(poIds[0], { quantity: newQty })
    } else {
      const perPo = Math.max(0, Math.round(newQty / poIds.length))
      await Promise.all(poIds.map(id => updatePo(id, { quantity: perPo })))
    }

    // Update mrpPivot state locally — no full reload so table doesn't flash or scroll to top
    setMrpPivot(prev => {
      if (!prev) return prev

      // Update suggested_po row and spo_ids
      const rows = prev.rows.map(r => {
        if (r.product_id !== productId) return r
        if (r.row_type === 'suggested_po') {
          const updated = { ...r, [periodKey]: newQty }
          if (newPoId != null) {
            const newSpoIds = { ...(r.spo_ids as Record<string, number[]> || {}) }
            newSpoIds[periodKey] = [newPoId]
            updated.spo_ids = newSpoIds
          }
          return updated
        }
        return r
      })

      // Recompute ending_inv for this product locally
      const onHandRow = rows.find(r => r.product_id === productId && r.row_type === 'on_hand')
      const confirmedRow = rows.find(r => r.product_id === productId && r.row_type === 'confirmed_po')
      const forecastRow = rows.find(r => r.product_id === productId && r.row_type === 'forecast')
      const custRow = rows.find(r => r.product_id === productId && r.row_type === 'customer_orders')
      const suggRow = rows.find(r => r.product_id === productId && r.row_type === 'suggested_po')

      if (!onHandRow) return { ...prev, rows }

      const ltWeeks = Math.round(((onHandRow.lead_time_days as number) || 0) / 7)
      let balance = (onHandRow.on_hand_today as number) || 0
      const updatedEndRow = { ...rows.find(r => r.product_id === productId && r.row_type === 'ending_inv')! }

      for (let i = 0; i < prev.periods.length; i++) {
        const k = prev.periods[i].key
        const cust = Number(custRow?.[k] ?? 0) || 0
        const forecast = Number(forecastRow?.[k] ?? 0) || 0
        const confirmed = Number(confirmedRow?.[k] ?? 0) || 0
        // suggested_po is keyed by ORDER week; arrival = order week + ltWeeks
        const orderIdx = i - ltWeeks
        const suggestedArrival = orderIdx >= 0
          ? Number(suggRow?.[prev.periods[orderIdx].key] ?? 0) || 0
          : 0
        balance = balance + confirmed + suggestedArrival - cust - forecast
        updatedEndRow[k] = Math.round(balance * 10) / 10
      }

      const finalRows = rows.map(r =>
        r.product_id === productId && r.row_type === 'ending_inv' ? updatedEndRow : r
      )
      return { ...prev, rows: finalRows }
    })

    // Refresh PO list in background for the orders tab (doesn't touch pivot)
    load()
  }, [load])

  const handleConfirmAll = async (filter?: DateFilter) => {
    setConfirming(true)
    try {
      // Only pass due date range to backend — order_date filters are display-only
      const dueDateFrom = filter?.field === 'due_date' ? filter.from : undefined
      const dueDateTo = filter?.field === 'due_date' ? filter.to : undefined
      const result = await confirmAllPos(undefined, dueDateFrom, dueDateTo)
      alert(`${result.confirmed} POs confirmed`)
      if (filter) setDateFilter(null)
      load()
      loadPivot()
    } finally {
      setConfirming(false)
    }
  }

  const statusColors: Record<string, { color: string; bg: string }> = useMemo(() => ({
    recommended: { color: '#c4b5fd', bg: 'rgba(124,58,237,0.15)' },
    planned:     { color: '#93c5fd', bg: 'rgba(29,78,216,0.15)' },
    confirmed:   { color: '#6ee7b7', bg: 'rgba(5,150,105,0.15)' },
    in_transit:  { color: '#fcd34d', bg: 'rgba(217,119,6,0.15)' },
    received:    { color: 'rgba(255,255,255,0.5)', bg: 'rgba(82,82,91,0.15)' },
  }), [])

  const latestRun = mrpRuns[0]
  const recommendedCount = pos.filter(p => p.status === 'recommended').length


  // Item-type filter — derive filtered pivot + filtered POs
  const filteredMrpPivot: MrpPivotData | null = mrpPivot && itemTypeFilter !== 'all'
    ? (() => {
        const allowedIds = new Set(
          mrpPivot.rows
            .filter(r => r.row_type === 'on_hand' && r.item_type === itemTypeFilter)
            .map(r => r.product_id)
        )
        return { ...mrpPivot, rows: mrpPivot.rows.filter(r => allowedIds.has(r.product_id)) }
      })()
    : mrpPivot

  // Risk filter — classify each product using the 5-tier risk model:
  // red=Stockout (on_hand=0), amber=Proj.Stockout (within LT <=0),
  // orange=Below SS (within LT <=SS), grey=Excess (any period >MAX), green=Healthy
  const riskFilteredMrpPivot: MrpPivotData | null = (() => {
    const base = filteredMrpPivot
    if (!base || riskFilter === 'all') return base
    const periods = base.periods
    const healthThresholds = (() => { try { const s = localStorage.getItem('inventory_health_thresholds'); return s ? JSON.parse(s) : { upper: 4 } } catch { return { upper: 4 } } })()
    const upperMult: number = healthThresholds.upper ?? 4
    const minWeeksCover: number = healthThresholds.min_weeks_cover ?? 0
    const allowedIds = new Set<number>()
    const productIds = [...new Set(base.rows.map(r => r.product_id))]
    for (const pid of productIds) {
      const endRow = base.rows.find(r => r.product_id === pid && r.row_type === 'ending_inv')
      const onHandRow = base.rows.find(r => r.product_id === pid && r.row_type === 'on_hand')
      if (!endRow) continue
      const baseSs    = (onHandRow?.safety_stock as number) || 0
      const avgWeekly = (onHandRow?.avg_weekly_demand as number) || 0
      const ss        = minWeeksCover > 0 ? Math.max(baseSs, minWeeksCover * avgWeekly) : baseSs
      const onHandQty = Number(onHandRow?.on_hand_today) || 0
      // Lead-time window + 1 week buffer to allow reaction time
      const ltDays   = Number(onHandRow?.lead_time_days) || 0
      const ltWeeks  = Math.max(1, Math.round(ltDays / 7)) + 1
      const ltPeriods = periods.slice(0, ltWeeks)
      const valsWithinLT = ltPeriods.map(p => Number(endRow[p.key] ?? 0))
      const minValWithinLT = Math.min(...valsWithinLT)
      // All periods
      const allVals   = periods.map(p => Number(endRow[p.key] ?? 0))
      const maxValAll = Math.max(...allVals)
      let risk: RiskLevel
      if (onHandQty === 0) risk = 'red'
      else if (minValWithinLT <= 0) risk = 'amber'
      else if (minValWithinLT <= ss) risk = 'orange'
      else if (ss > 0 && maxValAll > ss * upperMult) risk = 'grey'
      else risk = 'green'
      if (risk === riskFilter) allowedIds.add(pid)
    }
    return { ...base, rows: base.rows.filter(r => allowedIds.has(r.product_id)) }
  })()

  // Derive vendor/machine options from pivot data
  const vendorOptions = mrpPivot
    ? [...new Set(mrpPivot.rows.filter(r => r.row_type === 'on_hand').map(r => r.supplier as string | undefined).filter(Boolean))].sort() as string[]
    : []
  const machineOptions = mrpPivot
    ? [...new Set(mrpPivot.rows.filter(r => r.row_type === 'on_hand').map(r => r.work_center as string | undefined).filter(Boolean))].sort() as string[]
    : []

  // Apply text filters (item, name, vendor, machine) on top of risk-filtered pivot
  const textFilteredMrpPivot: MrpPivotData | null = (() => {
    const base = riskFilteredMrpPivot
    if (!base) return base
    if (!itemIds.length && !productNames.length && !vendorFilter.length && !machineFilter.length) return base
    const allowedIds = new Set(
      base.rows
        .filter(r => r.row_type === 'on_hand')
        .filter(r => {
          if (itemIds.length > 0 && !itemIds.includes(r.sku ?? '')) return false
          if (productNames.length > 0 && !productNames.includes(r.description ?? '')) return false
          if (vendorFilter.length > 0 && !vendorFilter.includes(r.supplier as string ?? '')) return false
          if (machineFilter.length > 0 && !machineFilter.includes(r.work_center as string ?? '')) return false
          return true
        })
        .map(r => r.product_id)
    )
    return { ...base, rows: base.rows.filter(r => allowedIds.has(r.product_id)) }
  })()

  // When "Order this week" is active, also filter explosion to products with a suggested PO this week
  const fullyFilteredMrpPivot: MrpPivotData | null = (() => {
    const base = textFilteredMrpPivot
    if (!base) return base
    if (dateFilter?.field !== 'order_date') return base
    const weekPeriodKeys = base.periods
      .filter(p => p.date >= dateFilter.from && p.date <= dateFilter.to)
      .map(p => p.key)
    if (weekPeriodKeys.length === 0) return base
    const allowedIds = new Set(
      base.rows
        .filter(r => r.row_type === 'suggested_po')
        .filter(r => weekPeriodKeys.some(k => Number(r[k] ?? 0) > 0))
        .map(r => r.product_id)
    )
    return { ...base, rows: base.rows.filter(r => allowedIds.has(r.product_id)) }
  })()

  // 5-tier risk counts from mrpPivot (mirrors Dashboard classification)
  const mrpRiskCounts = useMemo(() => {
    const counts = { stockout: 0, projected_stockout: 0, below_ss: 0, healthy: 0, excess: 0 }
    if (!mrpPivot) return counts
    const ht = (() => { try { const s = localStorage.getItem('inventory_health_thresholds'); return s ? JSON.parse(s) : {} } catch { return {} } })()
    const upperMult: number = ht.upper ?? 4
    const minWks: number    = ht.min_weeks_cover ?? 0
    const productIds = [...new Set(mrpPivot.rows.map(r => r.product_id))]
    for (const pid of productIds) {
      const onHandRow = mrpPivot.rows.find(r => r.product_id === pid && r.row_type === 'on_hand')
      const endRow    = mrpPivot.rows.find(r => r.product_id === pid && r.row_type === 'ending_inv')
      if (!endRow || !onHandRow) continue
      const baseSs    = (onHandRow.safety_stock as number) || 0
      const avgWeekly = (onHandRow.avg_weekly_demand as number) || 0
      const ss        = minWks > 0 ? Math.max(baseSs, minWks * avgWeekly) : baseSs
      const onHandQty = Number(onHandRow.on_hand_today) || 0
      const ltDays    = Number(onHandRow.lead_time_days) || 0
      const ltWeeks   = Math.max(1, Math.round(ltDays / 7)) + 1
      const valsWithinLT = mrpPivot.periods.slice(0, ltWeeks).map(p => Number(endRow[p.key] ?? 0))
      const minValWithinLT = Math.min(...valsWithinLT)
      const maxValAll = Math.max(...mrpPivot.periods.map(p => Number(endRow[p.key] ?? 0)))
      if (onHandQty === 0) counts.stockout++
      else if (minValWithinLT <= 0) counts.projected_stockout++
      else if (minValWithinLT <= ss) counts.below_ss++
      else if (ss > 0 && maxValAll > ss * upperMult) counts.excess++
      else counts.healthy++
    }
    return counts
  }, [mrpPivot])

  const purchasedProductIds: Set<number> = mrpPivot
    ? new Set(mrpPivot.rows.filter(r => r.row_type === 'on_hand' && r.item_type === 'purchased').map(r => r.product_id))
    : new Set()
  const producedProductIds: Set<number> = mrpPivot
    ? new Set(mrpPivot.rows.filter(r => r.row_type === 'on_hand' && r.item_type === 'produced').map(r => r.product_id))
    : new Set()

  // Aggregate chart: sum all filtered products per period
  const aggregateChartData = useMemo(() => {
    const base = fullyFilteredMrpPivot
    if (!base) return []
    const priceMap: Record<number, number> = {}
    for (const row of base.rows) {
      if (row.row_type === 'on_hand') {
        priceMap[row.product_id] = viewUnit === 'revenue' ? ((row.unit_cost as number) || 0) : 1
      }
    }
    let totalOnHand = 0
    for (const row of base.rows) {
      if (row.row_type === 'on_hand') totalOnHand += (Number(row.on_hand_today) || 0) * (priceMap[row.product_id] || 1)
    }
    return [
      { label: 'On Hand', on_hand_bar: totalOnHand, customer_orders: 0, forecast: 0, confirmed_po: 0, suggested_po: 0, proj_inv: totalOnHand },
      ...base.periods.map(p => {
        let customer_orders = 0, forecast = 0, confirmed_po = 0, suggested_po = 0, proj_inv = 0
        const productIds = [...new Set(base.rows.map(r => r.product_id))]
        for (const pid of productIds) {
          const price = priceMap[pid] || 1
          const rows = base.rows.filter(r => r.product_id === pid)
          const byType = Object.fromEntries(rows.map(r => [r.row_type, r])) as Record<string, MrpRow>
          customer_orders += (Number(byType.customer_orders?.[p.key] ?? 0) || 0) * price
          forecast += (Number(byType.forecast?.[p.key] ?? 0) || 0) * price
          confirmed_po += (Number(byType.confirmed_po?.[p.key] ?? 0) || 0) * price
          suggested_po += (Number(byType.suggested_po?.[p.key] ?? 0) || 0) * price
          proj_inv += (Number(byType.ending_inv?.[p.key] ?? 0) || 0) * price
        }
        return { label: p.label, on_hand_bar: 0, customer_orders, forecast, confirmed_po, suggested_po, proj_inv }
      }),
    ]
  }, [fullyFilteredMrpPivot, viewUnit])

  // typeFilteredPos: used for the active tab's PO list
  const tabItemType = activeTab === 'purchase_orders' ? 'purchased' : activeTab === 'production_orders' ? 'produced' : null
  const typeFilteredPos = tabItemType === 'purchased'
    ? pos.filter(p => purchasedProductIds.has(p.product_id))
    : tabItemType === 'produced'
      ? pos.filter(p => producedProductIds.has(p.product_id))
      : pos

  const filteredPos = (() => {
    let result = dateFilter
      ? typeFilteredPos.filter(p => {
          const val = dateFilter.field === 'order_date' ? p.order_date : p.due_date
          return val != null && val >= dateFilter.from && val <= dateFilter.to
        })
      : typeFilteredPos
    if (itemIds.length > 0) result = result.filter(p => itemIds.includes(p.sku ?? ''))
    if (productNames.length > 0) result = result.filter(p => productNames.includes(p.description ?? ''))
    if (vendorFilter.length > 0) result = result.filter(p => vendorFilter.includes(p.supplier_name ?? ''))
    if (statusFilters.length > 0) result = result.filter(p => statusFilters.includes(p.status ?? ''))
    return result
  })()


  // Reset row selections when tab changes
  useEffect(() => { setTableSelectedIds(new Set()) }, [activeTab])

  const handleSortClick = (col: string) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const sortedFilteredPos = useMemo(() => {
    if (!sortCol) return filteredPos
    return [...filteredPos].sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[sortCol]
      const bv = (b as unknown as Record<string, unknown>)[sortCol]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      const aStr = typeof av === 'string' ? av.toLowerCase() : av
      const bStr = typeof bv === 'string' ? bv.toLowerCase() : bv
      if (aStr < bStr) return sortDir === 'asc' ? -1 : 1
      if (aStr > bStr) return sortDir === 'asc' ? 1 : -1
      return 0
    })
  }, [filteredPos, sortCol, sortDir])

  const handlePlaceOrders = async () => {
    setPlacing(true)
    try {
      const selected = sortedFilteredPos.filter(p => tableSelectedIds.has(p.id))
      await Promise.all(selected.map(p => updatePo(p.id, { status: 'confirmed' })))
      setTableSelectedIds(new Set())
      setOrderConfirmOpen(false)
      load()
      loadPivot()
    } finally {
      setPlacing(false)
    }
  }

  const handleStatusChange = async (poId: number, newStatus: string) => {
    await updatePo(poId, { status: newStatus })
    load()
  }

  useSidebarActionsEffect(
    <div className="flex flex-col gap-2 items-start">
      <p className="w-3/4 text-[9px] font-medium uppercase tracking-widest text-white/80 mb-1">View</p>
      <div className="flex rounded overflow-hidden border border-white/20 text-xs w-3/4">
        {(['qty', 'revenue'] as const).map(u => (
          <button key={u} onClick={() => setViewUnit(u)}
            className={`flex-1 py-1.5 font-medium ${viewUnit === u ? 'bg-brand-600 text-white' : 'bg-white/[0.08] text-white hover:bg-white/15'}`}>
            {u === 'qty' ? 'Qty' : 'Currency'}
          </button>
        ))}
      </div>
      <p className="w-3/4 text-[9px] font-medium uppercase tracking-widest text-white/80 mt-5 mb-1">Supply Filters</p>
      <MultiSelect
        options={vendorOptions}
        value={vendorFilter}
        onChange={setVendorFilter}
        placeholder="Vendor…"
      />
      <MultiSelect
        options={machineOptions}
        value={machineFilter}
        onChange={setMachineFilter}
        placeholder="Machine / work center…"
      />
      <MultiSelect
        options={['recommended', 'planned', 'confirmed', 'in_transit', 'received', 'cancelled']}
        value={statusFilters}
        onChange={setStatusFilters}
        placeholder="Status…"
      />
      <div className="w-3/4 flex flex-col gap-2 mt-6">
        <span className="text-[9px] font-medium uppercase tracking-widest text-white/80">Show</span>
        <div className="flex flex-nowrap items-center gap-1">
        {(['all', 'purchased', 'produced'] as const).map(key => (
          <button
            key={key}
            onClick={() => setItemTypeFilter(key)}
            className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
              itemTypeFilter === key ? 'bg-brand-700 text-white border-brand-700' : 'text-white/80 border-white/20 hover:bg-white/[0.06]'
            }`}
          >
            {key === 'all' ? 'All' : key === 'purchased' ? 'Purchase' : 'Production'}
          </button>
        ))}
        </div>
      </div>
      <p className="w-3/4 text-[9px] font-medium uppercase tracking-widest text-white/80 mt-5 mb-1">MRP Settings</p>
      <div className="w-full flex flex-col gap-2 items-start">
      <Select value={horizon} onChange={setHorizon} options={HORIZON_OPTIONS} className="w-3/4" />
      <Select value={consolidation} onChange={setConsolidation} options={CONSOLIDATION_OPTIONS} className="w-3/4" />
      <Button variant="primary" size="sm" onClick={handleRunMrp} disabled={running} className="w-3/4 justify-center mt-3">
        <Play className="w-3.5 h-3.5" />
        {running ? 'Running MRP...' : 'Run MRP'}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => { load(); loadPivot() }} className="w-3/4 justify-center">
        <RefreshCw className="w-3.5 h-3.5" />
        Refresh
      </Button>
      </div>
    </div>,
    [statusFilters, horizon, consolidation, running, confirming, recommendedCount, dateFilter, vendorFilter, machineFilter, itemTypeFilter, vendorOptions, machineOptions, viewUnit],
  )

  return (
    <div>
      <PageHeader
        title="Supply Planning"
        description="MRP-driven purchase and production order recommendations"
      />

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-10">
        <Card className="py-3">
          <p className="text-xs text-white/80">Last MRP Run</p>
          <p className="text-sm font-semibold text-white mt-0.5">
            {latestRun ? new Date(latestRun.run_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
          </p>
          <p className="text-[11px] text-white/50 mt-0.5">{latestRun ? `${latestRun.po_count} orders generated` : ''}</p>
        </Card>
        <Card className="py-3 flex flex-col gap-2">
          <p className="text-xs text-white/80 mb-1">Inventory Status</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-red-400">Stockout</span>
              <span className="text-sm font-semibold text-white">{mrpRiskCounts.stockout}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-orange-400">Proj. Stockout</span>
              <span className="text-sm font-semibold text-white">{mrpRiskCounts.projected_stockout}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-yellow-400">Below SS</span>
              <span className="text-sm font-semibold text-white">{mrpRiskCounts.below_ss}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-green-400">Healthy</span>
              <span className="text-sm font-semibold text-white">{mrpRiskCounts.healthy}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-zinc-300">Excess</span>
              <span className="text-sm font-semibold text-white">{mrpRiskCounts.excess}</span>
            </div>
          </div>
        </Card>
        <Card className="py-3 flex flex-col justify-center">
          <p className="text-xs text-white/80">Total Inventory</p>
          <p className="text-xl font-semibold text-white mt-0.5">{fmtCurrency(kpis?.inventory_value)}</p>
        </Card>
        <Card className="py-3 flex flex-col justify-center">
          <p className="text-xs text-white/80">Confirmed POs</p>
          <p className="text-xl font-semibold text-white mt-0.5">{fmtCurrency(kpis?.confirmed_po_value)}</p>
        </Card>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4">
        {([
          { key: 'explosion', label: 'Material Requirements Plan', show: true },
          { key: 'purchase_orders', label: 'Purchase Orders', show: itemTypeFilter !== 'produced' },
          { key: 'production_orders', label: 'Production Orders', show: itemTypeFilter !== 'purchased' },
        ] as const).filter(t => t.show).map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              activeTab === tab.key
                ? 'bg-brand-600 text-white'
                : 'text-white/70 hover:text-white hover:bg-white/[0.08]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Material Requirements Plan Tab */}
      {activeTab === 'explosion' && (
        <>
          <div className="flex items-center justify-between mb-2">
            <RiskFilter value={riskFilter} onChange={setRiskFilter} />
            {(() => {
              const thisWeek = weekRangeFromDate(new Date().toISOString().split('T')[0])
              const isActive = dateFilter?.field === 'order_date' && dateFilter.from === thisWeek.from
              const weekPeriodKeys = mrpPivot?.periods.filter(p => p.date >= thisWeek.from && p.date <= thisWeek.to).map(p => p.key) ?? []
              const thisWeekCount = mrpPivot
                ? new Set(mrpPivot.rows.filter(r => r.row_type === 'suggested_po' && weekPeriodKeys.some(k => Number(r[k] ?? 0) > 0)).map(r => r.product_id)).size
                : 0
              return (
                <button
                  onClick={() => setDateFilter(f => f?.field === 'order_date' && f.from === thisWeek.from ? null : { label: 'Order this week', from: thisWeek.from, to: thisWeek.to, field: 'order_date' })}
                  className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full transition-colors ${isActive ? 'bg-emerald-500 text-white' : 'bg-emerald-900/60 text-emerald-300 hover:bg-emerald-800/70'}`}
                >
                  Order this week
                  {thisWeekCount > 0 && (
                    <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${isActive ? 'bg-white/20 text-white' : 'bg-emerald-700/60 text-emerald-200'}`}>
                      {thisWeekCount}
                    </span>
                  )}
                </button>
              )
            })()}
          </div>
          {/* Table — capped height so chart is always visible below */}
          <Card className="p-0 overflow-hidden mb-4">
            {pivotLoading ? (
              <Spinner className="h-64" />
            ) : fullyFilteredMrpPivot ? (
              <MrpPivotTable data={fullyFilteredMrpPivot} viewUnit={viewUnit === 'revenue' ? 'currency' : 'qty'} maxHeight={520} onCellDoubleClick={handleExplosionDblClick} onProductDoubleClick={handleProductDblClick} onPeriodClick={handlePeriodClick} onSuggestedPoClick={handleSuggestedPoClick} onSuggestedPoEdit={handleSuggestedPoEdit} />
            ) : (
              <p className="text-sm text-white/60 p-8 text-center">Run MRP first to see the explosion view</p>
            )}
          </Card>

          {/* Chart panel — always visible, updates on product click */}
          <Card className="p-5">
            {(() => {
              const uc = viewUnit === 'revenue'
              const valueFormatter = uc ? fmtCurrency : fmtNumber
              const isAggregate = !selectedProduct || !mrpPivot
              const chartData = isAggregate ? aggregateChartData : (() => {
                const productRows = mrpPivot!.rows.filter(r => r.product_id === selectedProduct!.product_id)
                const byType = Object.fromEntries(productRows.map(r => [r.row_type, r])) as Record<MrpRow['row_type'], MrpRow>
                const dp = uc ? ((byType.on_hand?.unit_cost as number) || 0) : 1
                const cp = uc ? ((byType.on_hand?.unit_cost as number) || 0) : 1
                const onHandToday = ((byType.on_hand?.on_hand_today as number) || 0) * cp
                return [
                  { label: 'On Hand', on_hand_bar: onHandToday, customer_orders: 0, forecast: 0, confirmed_po: 0, suggested_po: 0, proj_inv: onHandToday },
                  ...mrpPivot!.periods.map(p => ({
                    label: p.label,
                    on_hand_bar: 0,
                    customer_orders: (Number(byType.customer_orders?.[p.key] ?? 0) || 0) * dp,
                    forecast: (Number(byType.forecast?.[p.key] ?? 0) || 0) * dp,
                    confirmed_po: (Number(byType.confirmed_po?.[p.key] ?? 0) || 0) * cp,
                    suggested_po: (Number(byType.suggested_po?.[p.key] ?? 0) || 0) * cp,
                    proj_inv: (Number(byType.ending_inv?.[p.key] ?? 0) || 0) * cp,
                  })),
                ]
              })()

              const productRows = !isAggregate ? mrpPivot!.rows.filter(r => r.product_id === selectedProduct!.product_id) : []
              const byType = !isAggregate ? Object.fromEntries(productRows.map(r => [r.row_type, r])) as Record<MrpRow['row_type'], MrpRow> : {} as Record<MrpRow['row_type'], MrpRow>
              const sp = uc ? ((byType.on_hand?.unit_cost as number) || 0) : 1
              const ht = (() => { try { const s = localStorage.getItem('inventory_health_thresholds'); return s ? JSON.parse(s) : {} } catch { return {} } })()
              const lowerMult: number = ht.lower ?? 1
              const upperMult: number = ht.upper ?? 4
              const minWks: number = ht.min_weeks_cover ?? 0
              let lowerLimit: number | null = null
              let upperLimit: number | null = null
              if (isAggregate && fullyFilteredMrpPivot) {
                let totalLower = 0, totalUpper = 0, hasSs = false
                for (const row of fullyFilteredMrpPivot.rows) {
                  if (row.row_type !== 'on_hand') continue
                  const rawSs2 = row.safety_stock as number | null
                  if (!rawSs2) continue
                  const avgW2 = (row.avg_weekly_demand as number | null) ?? 0
                  const ss2 = minWks > 0 ? Math.max(rawSs2, minWks * avgW2) : rawSs2
                  const sp2 = uc ? ((row.unit_cost as number) || 0) : 1
                  totalLower += ss2 * lowerMult * sp2
                  totalUpper += ss2 * upperMult * sp2
                  hasSs = true
                }
                if (hasSs) { lowerLimit = totalLower; upperLimit = totalUpper }
              } else {
                const rawSs = byType.on_hand?.safety_stock as number | null
                const avgWeekly = (byType.on_hand?.avg_weekly_demand as number | null) ?? 0
                const ss = rawSs ? (minWks > 0 ? Math.max(rawSs, minWks * avgWeekly) : rawSs) : null
                lowerLimit = ss != null ? ss * lowerMult * sp : null
                upperLimit = ss != null ? ss * upperMult * sp : null
              }

              return (
                <>
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <p className="text-[10px] font-medium uppercase tracking-widest text-white/40 mb-1">Inventory Projection</p>
                      {isAggregate ? (
                        <p className="text-sm font-semibold text-white">All Items — Aggregate {uc ? 'Currency' : 'Quantity'}</p>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-bold text-blue-300 bg-blue-400/10 px-2 py-0.5 rounded">{selectedProduct!.sku}</span>
                          <span className="text-sm font-semibold text-white">{selectedProduct!.description}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <ResponsiveContainer width="100%" height={220}>
                    <ComposedChart data={chartData} margin={{ top: 8, right: 32, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id="onHandGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#8fb5c7" stopOpacity={0.85} />
                          <stop offset="100%" stopColor="#7aa3b8" stopOpacity={0.75} />
                        </linearGradient>
                        <linearGradient id="custOrdGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#208663" stopOpacity={0.95} />
                          <stop offset="100%" stopColor="#1a7055" stopOpacity={0.85} />
                        </linearGradient>
                        <linearGradient id="forecastGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#2aae81" stopOpacity={0.85} />
                          <stop offset="100%" stopColor="#239970" stopOpacity={0.75} />
                        </linearGradient>
                        <linearGradient id="confPoGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#3b7386" stopOpacity={0.95} />
                          <stop offset="100%" stopColor="#2e5c6b" stopOpacity={0.85} />
                        </linearGradient>
                        <linearGradient id="suggPoGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#6aaac0" stopOpacity={0.85} />
                          <stop offset="100%" stopColor="#5a96ac" stopOpacity={0.75} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />
                      <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.4)', fontWeight: 500 }} tickLine={false} axisLine={false} interval="preserveStartEnd" dy={8} />
                      <YAxis tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.4)', fontWeight: 500 }} tickLine={false} axisLine={false} width={uc ? 75 : 45} tickFormatter={v => valueFormatter(v)} domain={[0, upperLimit != null && upperLimit > 0 ? (dataMax: number) => Math.max(dataMax, upperLimit) * 1.08 : (dataMax: number) => dataMax * 1.08]} />
                      <Tooltip content={<SupplyChartTooltip valueFormatter={valueFormatter} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                      <Legend content={() => (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: '14px', paddingTop: 16, fontSize: 10, letterSpacing: '0.05em', fontWeight: 500 }}>
                          {([
                            { label: 'On Hand', color: '#8fb5c7', type: 'bar' },
                            { label: 'Customer Orders', color: '#208663', type: 'bar' },
                            { label: 'Forecast', color: '#2aae81', type: 'bar' },
                            { label: 'Confirmed PO', color: '#3b7386', type: 'bar' },
                            { label: 'Suggested PO', color: '#6aaac0', type: 'bar' },
                            { label: 'Proj. Inventory', color: '#7a90a4', type: 'line' },
                          ] as { label: string; color: string; type: 'bar' | 'line' }[]).map(({ label, color, type }) => (
                            <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'rgba(255,255,255,0.8)' }}>
                              {type === 'bar' ? (
                                <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
                              ) : (
                                <svg width="18" height="10" style={{ display: 'inline-block', flexShrink: 0 }}>
                                  <line x1="0" y1="5" x2="18" y2="5" stroke={color} strokeWidth="1.5" strokeDasharray="4 2" />
                                  <circle cx="9" cy="5" r="2.5" fill="none" stroke={color} strokeWidth="1.5" />
                                </svg>
                              )}
                              {label}
                            </span>
                          ))}
                        </div>
                      )} />
                      <Bar dataKey="on_hand_bar" name="On Hand" fill="url(#onHandGrad)" radius={[2,2,0,0]} barSize={10} />
                      <Bar dataKey="customer_orders" name="Customer Orders" fill="url(#custOrdGrad)" radius={[1,1,0,0]} barSize={10} stackId="demand" />
                      <Bar dataKey="forecast" name="Forecast" fill="url(#forecastGrad)" radius={[1,1,0,0]} barSize={10} stackId="demand" />
                      <Bar dataKey="confirmed_po" name="Confirmed PO" fill="url(#confPoGrad)" radius={[2,2,0,0]} barSize={10} stackId="conf" />
                      <Bar dataKey="suggested_po" name="Suggested PO" fill="url(#suggPoGrad)" radius={[2,2,0,0]} barSize={10} stackId="sugg" />
                      <Line dataKey="proj_inv" name="Proj. Inventory" stroke="#9ab4c8" strokeWidth={1} strokeDasharray="5 3" type="monotone" dot={false} activeDot={{ r: 3, fill: '#9ab4c8', stroke: 'rgba(154,180,200,0.3)', strokeWidth: 1.5 }} />
                      {lowerLimit != null && lowerLimit > 0 && <ReferenceLine y={lowerLimit} stroke="rgba(180,70,70,0.65)" strokeDasharray="4 4" strokeWidth={1} label={{ content: (p: any) => { const rx = (p.viewBox?.x ?? 0) + (p.viewBox?.width ?? 0) + 4; const ry = p.viewBox?.y ?? 0; return (<g><text x={rx} y={ry - 2} fontSize={9} fill="rgba(180,70,70,0.85)" fontWeight={600}>Min</text><text x={rx} y={ry + 9} fontSize={10} fill="rgba(180,70,70,0.7)">{valueFormatter(lowerLimit)}</text></g>) } }} />}
                      {upperLimit != null && upperLimit > 0 && <ReferenceLine y={upperLimit} stroke="rgba(180,70,70,0.65)" strokeDasharray="4 4" strokeWidth={1} label={{ content: (p: any) => { const rx = (p.viewBox?.x ?? 0) + (p.viewBox?.width ?? 0) + 4; const ry = p.viewBox?.y ?? 0; return (<g><text x={rx} y={ry - 2} fontSize={9} fill="rgba(180,70,70,0.85)" fontWeight={600}>Max</text><text x={rx} y={ry + 9} fontSize={10} fill="rgba(180,70,70,0.7)">{valueFormatter(upperLimit)}</text></g>) } }} />}
                    </ComposedChart>
                  </ResponsiveContainer>
                </>
              )
            })()}
          </Card>
        </>
      )}

      {/* Purchase / Production Orders Tab */}
      {(activeTab === 'purchase_orders' || activeTab === 'production_orders') && (
        <>
          {(() => {
            const thisWeek = weekRangeFromDate(new Date().toISOString().split('T')[0])
            const isThisWeekActive = dateFilter?.field === 'order_date' && dateFilter.from === thisWeek.from
            const thisWeekCount = typeFilteredPos.filter(p => p.order_date != null && p.order_date >= thisWeek.from && p.order_date <= thisWeek.to).length
            return (
              <div className="flex items-center justify-end gap-3 mb-3">
                {tableSelectedIds.size > 0 && (
                  <Button variant="primary" size="sm" onClick={() => setOrderConfirmOpen(true)}>
                    Place {tableSelectedIds.size} Order{tableSelectedIds.size !== 1 ? 's' : ''}
                  </Button>
                )}
                <button
                  onClick={() => setDateFilter(f => f?.field === 'order_date' && f.from === thisWeek.from ? null : { label: 'Order this week', from: thisWeek.from, to: thisWeek.to, field: 'order_date' })}
                  className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full transition-colors ${
                    isThisWeekActive
                      ? 'bg-emerald-500 text-white'
                      : 'bg-emerald-900/60 text-emerald-300 hover:bg-emerald-800/70'
                  }`}
                >
                  Order this week
                  {thisWeekCount > 0 && (
                    <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${isThisWeekActive ? 'bg-white/20 text-white' : 'bg-emerald-700/60 text-emerald-200'}`}>
                      {thisWeekCount}
                    </span>
                  )}
                </button>
              </div>
            )
          })()}
          {dateFilter && (() => {
            const filtCount = filteredPos.length
            const filtRecommended = filteredPos.filter(p => p.status === 'recommended').length
            const isDueDateFilter = dateFilter.field === 'due_date'
            return (
              <div className="flex items-center gap-2 mb-3 text-xs bg-white/[0.06] border border-white/20 rounded-lg px-3 py-2 text-white">
                <span>
                  {isDueDateFilter ? 'Due' : 'Order'} date: <span className="font-semibold">{dateFilter.label}</span>
                  {' '}— <span className="font-semibold">{filtCount}</span> orders
                </span>
                {isDueDateFilter && filtRecommended > 0 && (
                  <button
                    onClick={() => handleConfirmAll(dateFilter)}
                    disabled={confirming}
                    className="ml-2 flex items-center gap-1 px-2 py-0.5 bg-brand-700 text-white rounded font-medium hover:bg-brand-600 disabled:opacity-50"
                  >
                    <CheckCheck className="w-3 h-3" />
                    Confirm {filtRecommended} for {dateFilter.label}
                  </button>
                )}
                <button className="ml-auto underline text-white/80" onClick={() => setDateFilter(null)}>
                  Show all
                </button>
              </div>
            )
          })()}
          {productFilter != null && (() => {
            const productRow = mrpPivot?.rows.find(r => r.product_id === productFilter && r.row_type === 'on_hand')
            return (
              <div className="flex items-center gap-2 mb-3 text-xs bg-white/[0.06] border border-white/20 rounded-lg px-3 py-2 text-white">
                Showing POs for
                <span className="font-mono font-semibold">{productRow?.sku ?? `#${productFilter}`}</span>
                {productRow?.description && <span className="text-white/70">{productRow.description}</span>}
                <button className="ml-auto underline text-white/80" onClick={() => { setProductFilter(null); setSelectedPoIds(new Set()) }}>
                  Show all
                </button>
              </div>
            )
          })()}
          {loading ? (
            <Spinner className="h-40" />
          ) : (
          <Card className="p-0 overflow-hidden mb-4">
            {(() => {
              const minW = viewUnit === 'revenue' ? 1260 : 1160
              const ucW = viewUnit === 'revenue' ? 120 : 88
              const tcW = viewUnit === 'revenue' ? 130 : 96
              const colgroup = (
                <colgroup>
                  <col style={{ width: 40 }} />
                  <col style={{ width: 100 }} />
                  <col style={{ width: 65 }} />
                  <col />
                  <col style={{ width: 65 }} />
                  <col style={{ width: 170 }} />
                  <col style={{ width: 65 }} />
                  <col style={{ width: ucW }} />
                  <col style={{ width: tcW }} />
                  <col style={{ width: 105 }} />
                  <col style={{ width: 100 }} />
                  <col style={{ width: 105 }} />
                </colgroup>
              )
              return (
                <div className="overflow-auto">
                  <div style={{ minWidth: minW }}>
                    <table className="w-full text-white border-collapse" style={{ tableLayout: 'fixed', fontSize: 13 }}>
                      {colgroup}
                      <thead>
                        <tr style={{ borderBottom: '2px solid rgba(255,255,255,0.15)' }}>
                          <th className="px-3" style={{ height: 52, verticalAlign: 'middle' }}>
                            <input
                              type="checkbox"
                              checked={sortedFilteredPos.length > 0 && sortedFilteredPos.every(p => tableSelectedIds.has(p.id))}
                              ref={el => { if (el) el.indeterminate = sortedFilteredPos.some(p => tableSelectedIds.has(p.id)) && !sortedFilteredPos.every(p => tableSelectedIds.has(p.id)) }}
                              onChange={e => {
                                if (e.target.checked) setTableSelectedIds(new Set(sortedFilteredPos.map(p => p.id)))
                                else setTableSelectedIds(new Set())
                              }}
                              style={{ cursor: 'pointer', accentColor: '#7c3aed' }}
                            />
                          </th>
                          {([
                            { label: 'PO #', field: 'po_number', right: false },
                            { label: 'SKU', field: 'sku', right: false },
                            { label: 'Description', field: 'description', right: false },
                            { label: 'ABC', field: 'abc_class', right: false },
                            { label: 'Supplier', field: 'supplier_name', right: false },
                            { label: 'Qty', field: 'quantity', right: true },
                            { label: 'Unit Cost', field: 'unit_cost', right: true },
                            { label: 'Total', field: 'total_cost', right: true },
                            { label: 'Order Date', field: 'order_date', right: false },
                            { label: 'Due Date', field: 'due_date', right: false },
                            { label: 'Status', field: 'status', right: false },
                          ]).map(col => (
                            <th
                              key={col.field}
                              onClick={() => handleSortClick(col.field)}
                              className="px-3 whitespace-nowrap cursor-pointer select-none hover:bg-white/[0.06] transition-colors"
                              style={{
                                fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em',
                                color: sortCol === col.field ? '#fff' : 'rgba(255,255,255,0.75)',
                                height: 52, verticalAlign: 'middle', textAlign: col.right ? 'right' : 'left',
                              }}
                            >
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                {col.label}
                                <span style={{ fontSize: 9, opacity: sortCol === col.field ? 1 : 0.35 }}>
                                  {sortCol === col.field ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
                                </span>
                              </span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                    </table>
                    <div style={{ maxHeight: 408, overflowY: 'auto', overflowX: 'hidden' }}>
                      <table className="w-full text-white border-collapse" style={{ tableLayout: 'fixed', fontSize: 13 }}>
                        {colgroup}
                        <tbody>
                          {sortedFilteredPos.map(po => {
                            const isChecked = tableSelectedIds.has(po.id)
                            const isHighlighted = selectedPoIds.has(po.id)
                            const isRecommended = po.status === 'recommended'
                            const rowBg = isChecked ? 'rgba(124,58,237,0.1)' : isHighlighted ? 'rgba(245,158,11,0.1)' : isRecommended ? 'rgba(124,58,237,0.06)' : undefined
                            const borderLeft = isHighlighted ? '3px solid #f59e0b' : undefined
                            const orderDateActive = dateFilter?.field === 'order_date' && dateFilter.from === po.order_date
                            const dueDateRange = po.due_date ? weekRangeFromDate(po.due_date) : null
                            const dueDateActive = dueDateRange && dateFilter?.field === 'due_date' && dateFilter.from === dueDateRange.from
                            const duePeriod = dueDateRange && mrpPivot?.periods.find(pr => pr.date >= dueDateRange.from && pr.date <= dueDateRange.to)
                            const sc = statusColors[po.status ?? ''] ?? { color: '#a1a1aa', bg: 'transparent' }
                            const abcColors: Record<string,string> = { A:'#f87171', B:'#fbbf24', C:'#6ee7b7' }
                            return (
                              <tr key={po.id} style={{ background: rowBg, borderLeft, height: 48 }} className="border-b border-white/5 hover:bg-white/[0.03] transition-colors">
                                <td className="px-3">
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={e => {
                                      setTableSelectedIds(prev => {
                                        const next = new Set(prev)
                                        if (e.target.checked) next.add(po.id)
                                        else next.delete(po.id)
                                        return next
                                      })
                                    }}
                                    style={{ cursor: 'pointer', accentColor: '#7c3aed' }}
                                  />
                                </td>
                                <td className="px-3 font-mono" style={{ fontSize: 11 }}>{po.po_number ?? '—'}</td>
                                <td className="px-3 font-mono" style={{ fontSize: 11 }}>{po.sku ?? '—'}</td>
                                <td className="px-3 truncate">{po.description ?? '—'}</td>
                                <td className="px-3">
                                  {po.abc_class ? (
                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ color: abcColors[po.abc_class] ?? '#fff', background: 'rgba(255,255,255,0.07)' }}>
                                      {po.abc_class}
                                    </span>
                                  ) : '—'}
                                </td>
                                <td className="px-3 truncate">{po.supplier_name ?? '—'}</td>
                                <td className="px-3 text-right">{po.quantity ?? '—'}</td>
                                <td className="px-3 text-right">{fmtCurrency(po.unit_cost)}</td>
                                <td className="px-3 text-right">{fmtCurrency(po.total_cost)}</td>
                                <td className="px-3">
                                  {po.order_date ? (
                                    <button
                                      onClick={() => setDateFilter(f => f?.field === 'order_date' && f.from === po.order_date ? null : { label: fmtDate(po.order_date!), from: po.order_date!, to: po.order_date!, field: 'order_date' })}
                                      className="px-1.5 py-0.5 rounded font-medium"
                                      style={{ fontSize: 11, background: orderDateActive ? '#7c3aed' : 'rgba(124,58,237,0.15)', color: orderDateActive ? '#fff' : '#c4b5fd', textDecoration: 'underline' }}
                                    >{fmtDate(po.order_date)}</button>
                                  ) : <span style={{ color: 'rgba(255,255,255,0.25)' }}>—</span>}
                                </td>
                                <td className="px-3">
                                  {po.due_date && dueDateRange ? (
                                    <button
                                      onClick={() => setDateFilter(f => f?.field === 'due_date' && f.from === dueDateRange.from ? null : { label: duePeriod?.label ?? fmtDate(po.due_date!), from: dueDateRange.from, to: dueDateRange.to, field: 'due_date' })}
                                      className="px-1.5 py-0.5 rounded font-medium"
                                      style={{ fontSize: 11, background: dueDateActive ? '#1d4ed8' : 'rgba(29,78,216,0.15)', color: dueDateActive ? '#fff' : '#93c5fd', textDecoration: 'underline' }}
                                    >{fmtDate(po.due_date)}</button>
                                  ) : <span style={{ color: 'rgba(255,255,255,0.25)' }}>—</span>}
                                </td>
                                <td className="px-3">
                                  <select
                                    value={po.status ?? ''}
                                    onChange={e => handleStatusChange(po.id, e.target.value)}
                                    style={{
                                      fontSize: 11, color: sc.color, background: sc.bg,
                                      border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4,
                                      padding: '2px 6px', cursor: 'pointer', outline: 'none',
                                      fontFamily: 'inherit', fontWeight: 500,
                                    }}
                                  >
                                    {(['recommended', 'planned', 'confirmed', 'in_transit', 'received', 'cancelled'] as const).map(s => (
                                      <option key={s} value={s} style={{ background: '#1a1a24', color: '#fff' }}>
                                        {statusLabel(s)}
                                      </option>
                                    ))}
                                  </select>
                                </td>
                              </tr>
                            )
                          })}
                          {sortedFilteredPos.length === 0 && (
                            <tr><td colSpan={12} className="px-3 py-8 text-center text-white/40">No orders found</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )
            })()}
          </Card>
          )}

          {/* Place Orders confirmation modal */}
          {orderConfirmOpen && (
            <>
              <div className="fixed inset-0 z-40 bg-black/60" onClick={() => !placing && setOrderConfirmOpen(false)} />
              <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
                <div className="bg-[#14141c] border border-white/20 rounded-2xl shadow-2xl max-w-lg w-full p-6 pointer-events-auto">
                  <h3 className="text-base font-semibold text-white mb-1">
                    Place {tableSelectedIds.size} Order{tableSelectedIds.size !== 1 ? 's' : ''}?
                  </h3>
                  <p className="text-xs text-white/50 mb-4">These orders will be marked as Confirmed.</p>
                  <div className="border border-white/10 rounded-lg overflow-hidden mb-5" style={{ maxHeight: 260, overflowY: 'auto' }}>
                    <table className="w-full text-white">
                      <thead>
                        <tr style={{ background: 'rgba(255,255,255,0.06)', position: 'sticky', top: 0 }}>
                          <th className="px-3 py-2 text-left" style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.5)' }}>PO #</th>
                          <th className="px-3 py-2 text-left" style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.5)' }}>SKU</th>
                          <th className="px-3 py-2 text-left" style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.5)' }}>Description</th>
                          <th className="px-3 py-2 text-right" style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.5)' }}>Qty</th>
                          <th className="px-3 py-2 text-right" style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.5)' }}>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedFilteredPos.filter(p => tableSelectedIds.has(p.id)).map(p => (
                          <tr key={p.id} className="border-t border-white/5">
                            <td className="px-3 py-2 font-mono" style={{ fontSize: 11 }}>{p.po_number ?? '—'}</td>
                            <td className="px-3 py-2 font-mono" style={{ fontSize: 11 }}>{p.sku ?? '—'}</td>
                            <td className="px-3 py-2 max-w-[180px] truncate" style={{ fontSize: 12 }}>{p.description ?? '—'}</td>
                            <td className="px-3 py-2 text-right" style={{ fontSize: 12 }}>{p.quantity}</td>
                            <td className="px-3 py-2 text-right" style={{ fontSize: 12 }}>{fmtCurrency(p.total_cost)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setOrderConfirmOpen(false)} disabled={placing}>Cancel</Button>
                    <Button variant="primary" size="sm" onClick={handlePlaceOrders} disabled={placing}>
                      {placing ? 'Placing...' : 'Confirm Orders'}
                    </Button>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* MRP Run History */}
          {mrpRuns.length > 0 && (
            <Card>
              <CardHeader><CardTitle>MRP Run History</CardTitle></CardHeader>
              <div className="space-y-2">
                {mrpRuns.map(r => (
                  <div key={r.run_id} className="flex items-center justify-between text-xs py-2 border-b border-white/5">
                    <div>
                      <p className="text-white">{new Date(r.run_date).toLocaleString()}</p>
                      <p className="text-white/70">{r.horizon_weeks} weeks horizon</p>
                    </div>
                    <div className="text-right">
                      <p className="font-medium text-white">{r.po_count} POs</p>
                      <p className="text-white/70">{fmtCurrency(r.total_po_value)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
