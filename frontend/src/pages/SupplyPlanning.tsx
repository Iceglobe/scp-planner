import { useEffect, useState, useCallback, createElement } from 'react'
import { Play, CheckCheck, RefreshCw, X } from 'lucide-react'
import { useSidebarActionsEffect } from '../context/SidebarActionsContext'
import { useFilters } from '../context/FilterContext'
import { MultiSelect } from '../components/ui/MultiSelect'
import { ColDef } from 'ag-grid-community'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { getPurchaseOrders, runMrp, getMrpRuns, confirmAllPos, getMrpPivot, updatePo, createPo } from '../api'
import type { PurchaseOrder, MrpRun, MrpPivotData, MrpRow } from '../api/types'
import { DataTable } from '../components/tables/DataTable'
import { MrpPivotTable } from '../components/tables/MrpPivotTable'
import { abcCellRenderer } from '../components/tables/cellRenderers'
import { Card, CardHeader, CardTitle, PageHeader, Button, Select, Spinner } from '../components/ui'
import { fmtCurrency, fmtDate, statusLabel } from '../utils/formatters'

interface DateFilter { label: string; from: string; to: string; field: 'due_date' | 'order_date' }

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


type RiskLevel = 'all' | 'red' | 'orange' | 'green' | 'grey'

function RiskFilter({ value, onChange }: { value: RiskLevel; onChange: (v: RiskLevel) => void }) {
  const opts: { key: RiskLevel; label: string; dot: string; active: string }[] = [
    { key: 'all',    label: 'All',      dot: '',                  active: 'bg-brand-700 text-white' },
    { key: 'red',    label: 'Stockout', dot: 'bg-red-500',        active: 'bg-red-600 text-white' },
    { key: 'orange', label: 'Below SS', dot: 'bg-orange-400',     active: 'bg-orange-500 text-white' },
    { key: 'green',  label: 'Healthy',  dot: 'bg-green-500',      active: 'bg-green-600 text-white' },
    { key: 'grey',   label: 'Excess',   dot: 'bg-zinc-400',       active: 'bg-white/[0.06]0 text-white' },
  ]
  return (
    <div className="flex items-center gap-1 mb-2">
      <span className="text-xs text-white/80 mr-1">Risk:</span>
      {opts.map(o => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-full transition-colors ${value === o.key ? o.active : 'text-white/80 hover:bg-white/[0.06]'}`}
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
  const [mrpPivot, setMrpPivot] = useState<MrpPivotData | null>(null)
  const [horizon, setHorizon] = useState('12')
  const [consolidation, setConsolidation] = useState('week')
  const [loading, setLoading] = useState(true)
  const [pivotLoading, setPivotLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [statusFilter, setStatusFilter] = useState('all')
  const [productFilter, setProductFilter] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<'explosion' | 'purchase_orders' | 'production_orders' | 'orders'>('explosion')
  const [itemTypeFilter, setItemTypeFilter] = useState<'all' | 'purchased' | 'produced'>('all')
  const [riskFilter, setRiskFilter] = useState<RiskLevel>('all')
  const [dateFilter, setDateFilter] = useState<DateFilter | null>(null)
  const [selectedProduct, setSelectedProduct] = useState<{ product_id: number; sku: string; description: string } | null>(null)
  const [vendorFilter, setVendorFilter] = useState<string[]>([])
  const [machineFilter, setMachineFilter] = useState<string[]>([])
  const [selectedPoIds, setSelectedPoIds] = useState<Set<number>>(new Set())
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
    if (statusFilter !== 'all') params.status = statusFilter
    if (productFilter != null) params.product_id = String(productFilter)
    Promise.all([getPurchaseOrders(params), getMrpRuns()])
      .then(([p, r]) => { setPos(p); setMrpRuns(r) })
      .finally(() => setLoading(false))
  }, [statusFilter, productFilter])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadPivot() }, [loadPivot])

  const handleRunMrp = async () => {
    setRunning(true)
    try {
      const result = await runMrp({ horizon_weeks: parseInt(horizon), consolidation })
      alert(`MRP complete: ${result.po_count} POs recommended · ${fmtCurrency(result.total_value)}`)
      load()
      loadPivot()
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

  const poCols: ColDef[] = [
    { field: 'po_number', headerName: 'PO #', width: 120, cellStyle: { fontFamily: 'monospace', fontSize: 11 } },
    { field: 'sku', headerName: 'SKU', width: 90, cellStyle: { fontFamily: 'monospace', fontSize: 11 } },
    { field: 'description', headerName: 'Description', flex: 1, minWidth: 180 },
    { field: 'abc_class', headerName: 'ABC', width: 58, cellRenderer: abcCellRenderer },
    { field: 'supplier_name', headerName: 'Supplier', width: 160 },
    { field: 'quantity', headerName: 'Qty', width: 75, type: 'numericColumn' },
    { field: 'unit_cost', headerName: 'Unit Cost', width: 90, valueFormatter: p => fmtCurrency(p.value), type: 'numericColumn' },
    { field: 'total_cost', headerName: 'Total', width: 100, valueFormatter: p => fmtCurrency(p.value), type: 'numericColumn' },
    {
      field: 'order_date', headerName: 'Order Date', width: 110,
      cellRenderer: (p: { value: string }) => {
        if (!p.value) return createElement('span', { style: { color: 'rgba(255,255,255,0.25)' } }, '—')
        const isActive = dateFilter?.field === 'order_date' && dateFilter.from === p.value
        return createElement('button', {
          onClick: () => setDateFilter(f => f?.field === 'order_date' && f.from === p.value ? null : { label: fmtDate(p.value), from: p.value, to: p.value, field: 'order_date' }),
          style: {
            display: 'inline-flex', alignItems: 'center', padding: '1px 6px',
            borderRadius: 4, fontSize: 11, fontWeight: 500, border: 'none', cursor: 'pointer',
            background: isActive ? '#7c3aed' : 'rgba(124,58,237,0.15)',
            color: isActive ? '#fff' : '#c4b5fd',
            textDecoration: 'underline',
          },
        }, fmtDate(p.value))
      },
    },
    {
      field: 'due_date', headerName: 'Due Date', width: 110,
      cellRenderer: (p: { value: string }) => {
        if (!p.value) return createElement('span', { style: { color: 'rgba(255,255,255,0.25)' } }, '—')
        const { from, to } = weekRangeFromDate(p.value)
        const isActive = dateFilter?.field === 'due_date' && dateFilter.from === from
        const period = mrpPivot?.periods.find(pr => pr.date >= from && pr.date <= to)
        const label = period?.label ?? fmtDate(p.value)
        return createElement('button', {
          onClick: () => setDateFilter(f => f?.field === 'due_date' && f.from === from ? null : { label, from, to, field: 'due_date' }),
          style: {
            display: 'inline-flex', alignItems: 'center', padding: '1px 6px',
            borderRadius: 4, fontSize: 11, fontWeight: 500, border: 'none', cursor: 'pointer',
            background: isActive ? '#1d4ed8' : 'rgba(29,78,216,0.15)',
            color: isActive ? '#fff' : '#93c5fd',
            textDecoration: 'underline',
          },
        }, fmtDate(p.value))
      },
    },
    {
      field: 'status', headerName: 'Status', width: 115,
      cellRenderer: (p: { value: string }) => {
        const colors: Record<string, string> = {
          recommended: '#c4b5fd', planned: '#93c5fd', confirmed: '#6ee7b7',
          in_transit: '#fcd34d', received: 'rgba(255,255,255,0.5)',
        }
        const bg: Record<string, string> = {
          recommended: 'rgba(124,58,237,0.15)', planned: 'rgba(29,78,216,0.15)', confirmed: 'rgba(5,150,105,0.15)',
          in_transit: 'rgba(217,119,6,0.15)', received: 'rgba(82,82,91,0.15)',
        }
        return createElement('span', {
          style: {
            display: 'inline-flex', padding: '1px 6px', borderRadius: 4,
            fontSize: 11, fontWeight: 500,
            color: colors[p.value] ?? '#52525b',
            background: bg[p.value] ?? '#f4f4f5',
          },
        }, statusLabel(p.value))
      },
    },
  ]

  const latestRun = mrpRuns[0]
  const recommendedCount = pos.filter(p => p.status === 'recommended').length
  const totalValue = pos.reduce((s, p) => s + (p.total_cost || 0), 0)

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

  // Risk filter — classify each product by worst projected inventory across all periods
  const riskFilteredMrpPivot: MrpPivotData | null = (() => {
    const base = filteredMrpPivot
    if (!base || riskFilter === 'all') return base
    const periods = base.periods
    const allowedIds = new Set<number>()
    const productIds = [...new Set(base.rows.map(r => r.product_id))]
    for (const pid of productIds) {
      const endRow = base.rows.find(r => r.product_id === pid && r.row_type === 'ending_inv')
      const onHandRow = base.rows.find(r => r.product_id === pid && r.row_type === 'on_hand')
      if (!endRow) continue
      const ss = (onHandRow?.safety_stock as number) || 0
      const rop = (onHandRow?.reorder_point as number) || 0
      const minVal = Math.min(...periods.map(p => Number(endRow[p.key] ?? 0)))
      let risk: RiskLevel
      if (minVal <= 0) risk = 'red'
      else if (minVal < ss) risk = 'orange'
      else if (minVal < rop * 1.5) risk = 'green'
      else risk = 'grey'
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

  const purchasedProductIds: Set<number> = mrpPivot
    ? new Set(mrpPivot.rows.filter(r => r.row_type === 'on_hand' && r.item_type === 'purchased').map(r => r.product_id))
    : new Set()
  const producedProductIds: Set<number> = mrpPivot
    ? new Set(mrpPivot.rows.filter(r => r.row_type === 'on_hand' && r.item_type === 'produced').map(r => r.product_id))
    : new Set()

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
    return result
  })()

  // Tab-specific counts (unaffected by dateFilter so badge is always informative)
  const purchasePos = pos.filter(p => purchasedProductIds.has(p.product_id))
  const productionPos = pos.filter(p => producedProductIds.has(p.product_id))

  useSidebarActionsEffect(
    <div className="flex flex-col gap-2 items-start">
      <p className="w-3/4 text-[9px] font-medium uppercase tracking-widest text-white/80 mb-1">Supply Filters</p>
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
      <Select
        value={statusFilter}
        onChange={v => setStatusFilter(v)}
        className="w-3/4"
        options={[
          { value: 'all', label: 'All statuses' },
          { value: 'recommended', label: 'Recommended' },
          { value: 'planned', label: 'Planned' },
          { value: 'confirmed', label: 'Confirmed' },
          { value: 'in_transit', label: 'In Transit' },
        ]}
      />
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
    [statusFilter, horizon, consolidation, running, confirming, recommendedCount, dateFilter, vendorFilter, machineFilter, itemTypeFilter, vendorOptions, machineOptions],
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
          <p className="text-xs text-white/80">Total POs</p>
          <p className="text-xl font-semibold text-white mt-0.5">{pos.length}</p>
        </Card>
        <Card className="py-3">
          <p className="text-xs text-white/80">Recommended</p>
          <p className="text-xl font-semibold text-white mt-0.5">{recommendedCount}</p>
        </Card>
        <Card className="py-3">
          <p className="text-xs text-white/80">Total PO Value</p>
          <p className="text-xl font-semibold text-white mt-0.5">{fmtCurrency(totalValue)}</p>
        </Card>
        <Card className="py-3">
          <p className="text-xs text-white/80">Last MRP Run</p>
          <p className="text-sm font-semibold text-white mt-0.5">
            {latestRun ? new Date(latestRun.run_date).toLocaleDateString() : '—'}
          </p>
        </Card>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4">
        {([
          { key: 'explosion', label: 'MRP Explosion', show: true },
          { key: 'purchase_orders', label: `Purchase Orders (${purchasePos.length})`, show: itemTypeFilter !== 'produced' },
          { key: 'production_orders', label: `Production Orders (${productionPos.length})`, show: itemTypeFilter !== 'purchased' },
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

      {/* MRP Explosion Tab */}
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
                  className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full transition-colors ${isActive ? 'bg-violet-600 text-white' : 'bg-violet-50 text-violet-700 hover:bg-violet-100'}`}
                >
                  Order this week
                  {thisWeekCount > 0 && (
                    <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${isActive ? 'bg-white/20' : 'bg-violet-200 text-violet-800'}`}>
                      {thisWeekCount}
                    </span>
                  )}
                </button>
              )
            })()}
          </div>
          <Card className="p-0 overflow-hidden">

            {pivotLoading ? (
              <Spinner className="h-64" />
            ) : fullyFilteredMrpPivot ? (
              <MrpPivotTable data={fullyFilteredMrpPivot} onCellDoubleClick={handleExplosionDblClick} onProductDoubleClick={handleProductDblClick} onPeriodClick={handlePeriodClick} onSuggestedPoClick={handleSuggestedPoClick} onSuggestedPoEdit={handleSuggestedPoEdit} />
            ) : (
              <p className="text-sm text-white/60 p-8 text-center">Run MRP first to see the explosion view</p>
            )}
          </Card>

          {/* Product chart panel — opens on double-click of product row */}
          {selectedProduct && mrpPivot && (() => {
            const productRows = mrpPivot.rows.filter(r => r.product_id === selectedProduct.product_id)
            const byType = Object.fromEntries(productRows.map(r => [r.row_type, r])) as Record<MrpRow['row_type'], MrpRow>
            const ss = byType.on_hand?.safety_stock as number | null
            const rop = byType.on_hand?.reorder_point as number | null
            const chartData = mrpPivot.periods.map(p => ({
              label: p.label,
              customer_orders: Number(byType.customer_orders?.[p.key] ?? 0) || 0,
              forecast: Number(byType.forecast?.[p.key] ?? 0) || 0,
              confirmed_po: Number(byType.confirmed_po?.[p.key] ?? 0) || 0,
              suggested_po: Number(byType.suggested_po?.[p.key] ?? 0) || 0,
              proj_inv: Number(byType.ending_inv?.[p.key] ?? 0) || 0,
            }))
            return (
              <Card className="mt-4 p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <span className="font-mono text-xs font-bold text-white bg-white/[0.06] px-2 py-0.5 rounded mr-2">{selectedProduct.sku}</span>
                    <span className="text-sm font-medium text-white">{selectedProduct.description}</span>
                  </div>
                  <button onClick={() => setSelectedProduct(null)} className="text-white/50 hover:text-white">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <ResponsiveContainer width="100%" height={260}>
                  <ComposedChart data={chartData} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#a1a1aa' }} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: '#a1a1aa' }} tickLine={false} axisLine={false} width={45} />
                    <Tooltip contentStyle={{ fontSize: 12, border: '1px solid #e4e4e7', borderRadius: 8 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="customer_orders" name="Customer Orders" fill="#b45309" fillOpacity={0.8} radius={[2,2,0,0]} barSize={10} stackId="demand" />
                    <Bar dataKey="forecast" name="Forecast" fill="#dc2626" fillOpacity={0.6} radius={[2,2,0,0]} barSize={10} stackId="demand" />
                    <Bar dataKey="confirmed_po" name="Confirmed PO" fill="#059669" fillOpacity={0.8} radius={[2,2,0,0]} barSize={10} stackId="supply" />
                    <Bar dataKey="suggested_po" name="Suggested PO" fill="#7c3aed" fillOpacity={0.7} radius={[2,2,0,0]} barSize={10} stackId="supply" />
                    <Line dataKey="proj_inv" name="Proj. Inventory" stroke="#1e40af" strokeWidth={2} dot={{ r: 3, fill: '#1e40af' }} type="monotone" />
                    {ss != null && <ReferenceLine y={ss} stroke="#f59e0b" strokeDasharray="4 2" label={{ value: 'SS', position: 'insideTopRight', fontSize: 9, fill: '#f59e0b' }} />}
                    {rop != null && <ReferenceLine y={rop} stroke="#ef4444" strokeDasharray="4 2" label={{ value: 'ROP', position: 'insideBottomRight', fontSize: 9, fill: '#ef4444' }} />}
                  </ComposedChart>
                </ResponsiveContainer>
              </Card>
            )
          })()}
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
              <div className="flex items-center justify-end mb-3">
                <button
                  onClick={() => setDateFilter(f => f?.field === 'order_date' && f.from === thisWeek.from ? null : { label: 'Order this week', from: thisWeek.from, to: thisWeek.to, field: 'order_date' })}
                  className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full transition-colors ${
                    isThisWeekActive
                      ? 'bg-violet-600 text-white'
                      : 'bg-violet-50 text-violet-700 hover:bg-violet-100'
                  }`}
                >
                  Order this week
                  {thisWeekCount > 0 && (
                    <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${isThisWeekActive ? 'bg-white/20' : 'bg-violet-200 text-violet-800'}`}>
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
          <style>{`.po-highlight { background: #fef3c7 !important; border-left: 3px solid #f59e0b !important; }`}</style>
          {loading ? (
            <Spinner className="h-40" />
          ) : (
          <Card className="p-0 overflow-hidden mb-4">
              <DataTable
                rowData={filteredPos as unknown as Record<string, unknown>[]}
                columnDefs={poCols}
                height={460}
                rowClassRules={{
                  'bg-violet-50': p => p.data?.status === 'recommended',
                  'po-highlight': p => selectedPoIds.has(p.data?.id as number),
                }}
              />
            </Card>
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
