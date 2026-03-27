import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Calculator, Check } from 'lucide-react'
import { useSidebarActionsEffect } from '../context/SidebarActionsContext'
import { useFilters } from '../context/FilterContext'
import { ColDef } from 'ag-grid-community'
import { getInventory, getAbcAnalysis, recalculateSafetyStock, recalculateRop, updateProduct, setAbcServiceLevels } from '../api'
import type { InventoryRow, AbcItem } from '../api/types'
import { DataTable } from '../components/tables/DataTable'
import { abcCellRenderer } from '../components/tables/cellRenderers'
import { AbcSelectCell } from '../components/tables/AbcSelectCell'
import { ABCPieChart, ABCRevenueBar } from '../components/charts/ABCChart'
import { Card, CardHeader, CardTitle, PageHeader, Button, Spinner } from '../components/ui'
import { fmtCurrency } from '../utils/formatters'

export default function InventoryPage() {
  const { itemIds, productNames } = useFilters()
  const [inventory, setInventory] = useState<InventoryRow[]>([])
  const [abcItems, setAbcItems] = useState<AbcItem[]>([])
  const [loading, setLoading] = useState(true)
  const [recalcLoading, setRecalcLoading] = useState(false)
  const [ropLoading, setRopLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'inventory' | 'abc'>('inventory')
  const [saved, setSaved] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [slLoading, setSlLoading] = useState(false)
  const [serviceLevels, setServiceLevels] = useState<{ A: number; B: number; C: number }>(() => {
    try {
      const stored = localStorage.getItem('abc_service_levels')
      if (stored) return JSON.parse(stored)
    } catch { /* ignore */ }
    return { A: 97, B: 95, C: 90 }
  })
  const [healthThresholds, setHealthThresholds] = useState<{ lower: number; upper: number; min_weeks_cover: number }>(() => {
    try {
      const stored = localStorage.getItem('inventory_health_thresholds')
      if (stored) return { min_weeks_cover: 2, ...JSON.parse(stored) }
    } catch { /* ignore */ }
    return { lower: 2, upper: 5, min_weeks_cover: 2 }
  })

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([getInventory(), getAbcAnalysis()])
      .then(([inv, abc]) => { setInventory(inv); setAbcItems(abc) })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    window.addEventListener('datasource-refreshed', load)
    return () => window.removeEventListener('datasource-refreshed', load)
  }, [load])

  const flashSaved = (label: string) => {
    setSaved(label)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => setSaved(null), 2000)
  }

  const STRING_FIELDS = new Set(['abc_class'])

  const handleCellChange = useCallback(async (
    field: string,
    newValue: unknown,
    row: Record<string, unknown>,
  ) => {
    const productId = row.product_id as number
    const value = STRING_FIELDS.has(field)
      ? String(newValue)
      : parseFloat(String(newValue))
    if (!STRING_FIELDS.has(field) && isNaN(value as number)) return
    try {
      await updateProduct(productId, { [field]: value })
      flashSaved(`${row.sku} → ${field}`)
      load()
    } catch {
      load()
    }
  }, [load])

  const handleRecalc = async () => {
    setRecalcLoading(true)
    try {
      await recalculateSafetyStock()
      load()
    } finally {
      setRecalcLoading(false)
    }
  }

  const handleApplyServiceLevels = async () => {
    setSlLoading(true)
    try {
      await setAbcServiceLevels({ A: serviceLevels.A / 100, B: serviceLevels.B / 100, C: serviceLevels.C / 100 })
      await recalculateSafetyStock()
      flashSaved('Service levels applied')
      load()
    } finally {
      setSlLoading(false)
    }
  }

  const handleRecalcRop = async () => {
    setRopLoading(true)
    try {
      await recalculateRop()
      load()
    } finally {
      setRopLoading(false)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invCols = useMemo(() => ([
    { field: 'sku', headerName: 'SKU', width: 95, pinned: 'left', cellStyle: { fontFamily: 'monospace', fontSize: 11 } },
    { field: 'description', headerName: 'Description', width: 200, flex: 1 },
    { field: 'category', headerName: 'Category', width: 110 },
    {
      field: 'abc_class', headerName: 'ABC', width: 90,
      cellRenderer: AbcSelectCell,
    },
    { field: 'quantity_on_hand', headerName: 'On Hand', width: 85, type: 'numericColumn' },
    { field: 'quantity_on_order', headerName: 'On Order', width: 85, type: 'numericColumn' },
    { field: 'quantity_reserved', headerName: 'Reserved', width: 85, type: 'numericColumn' },
    {
      field: 'position', headerName: 'Position', width: 85, type: 'numericColumn',
      cellStyle: (p): Record<string, string> => {
        const pos = p.value as number
        const data = p.data as { safety_stock_qty?: number; avg_daily_demand?: number }
        const rawSs = data?.safety_stock_qty ?? 0
        const avgWeekly = (data?.avg_daily_demand ?? 0) * 7
        const ss = healthThresholds.min_weeks_cover > 0 ? Math.max(rawSs, healthThresholds.min_weeks_cover * avgWeekly) : rawSs
        if (pos == null) return { fontWeight: '600' }
        if (ss === 0) return { fontWeight: '600', color: '#ffffff' }
        if (pos <= 0) return { fontWeight: '600', color: '#f87171' }           // Stockout
        if (pos <= ss) return { fontWeight: '600', color: '#fb923c' }          // Below SS
        if (pos > healthThresholds.upper * ss) return { fontWeight: '600', color: '#a1a1aa' }  // Excess
        return { fontWeight: '600', color: '#22c55e' }                         // Healthy
      },
    },
    {
      field: 'service_level', headerName: 'Svc Level', width: 85,
      type: 'numericColumn', editable: true,
      valueFormatter: p => p.value != null ? `${Math.round(p.value * 100)}%` : '—',
      cellStyle: { cursor: 'cell', background: 'rgba(255, 255, 255, 0.05)' },
      valueParser: p => parseFloat(p.newValue) / 100,
    },
    {
      field: 'avg_daily_demand', headerName: 'Avg Weekly Demand', width: 140,
      type: 'numericColumn',
      valueFormatter: p => p.value != null ? (p.value * 7).toFixed(1) : '—',
    },
    {
      field: 'safety_stock_qty', headerName: 'Safety Stock', width: 105,
      type: 'numericColumn', editable: true,
      cellStyle: { cursor: 'cell', background: 'rgba(255, 255, 255, 0.05)' },
      valueParser: p => parseFloat(p.newValue),
      valueGetter: p => {
        const raw = p.data?.safety_stock_qty ?? 0
        const avgWeekly = (p.data?.avg_daily_demand ?? 0) * 7
        return healthThresholds.min_weeks_cover > 0 ? Math.max(raw, healthThresholds.min_weeks_cover * avgWeekly) : raw
      },
      valueFormatter: p => p.value != null ? Math.round(p.value).toString() : '—',
    },
    {
      field: 'reorder_point', headerName: 'ROP', width: 80,
      type: 'numericColumn', editable: true,
      cellStyle: { cursor: 'cell', background: 'rgba(255, 255, 255, 0.05)' },
      valueParser: p => parseFloat(p.newValue),
    },
    {
      field: 'days_of_supply', headerName: 'Days Supply', width: 100,
      valueFormatter: p => p.value != null ? `${p.value}d` : '—',
    },
    {
      field: 'inventory_value', headerName: 'Value', width: 100,
      valueFormatter: p => fmtCurrency(p.value), type: 'numericColumn',
    },
    { field: 'supplier', headerName: 'Supplier', width: 140 },
  ] as ColDef[]), [healthThresholds])

  const abcCols: ColDef[] = [
    { field: 'sku', headerName: 'SKU', width: 95, cellStyle: { fontFamily: 'monospace', fontSize: 11 } },
    { field: 'description', headerName: 'Description', flex: 1, minWidth: 180 },
    { field: 'abc_class', headerName: 'ABC', width: 60, cellRenderer: abcCellRenderer },
    { field: 'revenue', headerName: 'Annual Revenue', width: 140, valueFormatter: p => fmtCurrency(p.value), type: 'numericColumn' },
    {
      field: 'revenue_pct', headerName: '% Revenue', width: 100,
      valueFormatter: p => `${p.value?.toFixed(1)}%`, type: 'numericColumn',
    },
    {
      field: 'cumulative_pct', headerName: 'Cumulative %', width: 110,
      valueFormatter: p => `${p.value?.toFixed(1)}%`, type: 'numericColumn',
      cellStyle: (p): Record<string, string> => {
        const v = p.value as number
        if (v <= 80) return { color: '#ffffff', fontWeight: '600' }
        if (v <= 95) return { color: '#fbbf24', fontWeight: '600' }
        return { color: '#71717a' }
      },
    },
  ]

  const filteredInventory = useMemo(() => inventory.filter(i => {
    if (itemIds.length > 0 && !itemIds.includes(i.sku ?? '')) return false
    if (productNames.length > 0 && !productNames.includes(i.description ?? '')) return false
    return true
  }), [inventory, itemIds, productNames])

  const totalValue = inventory.reduce((s, i) => s + (i.inventory_value || 0), 0)
  const criticalCount = inventory.filter(i => i.status === 'stockout').length
  const warningCount = inventory.filter(i => i.status === 'below_ss').length
  const excessCount = inventory.filter(i => i.safety_stock_qty > 0 && i.position > healthThresholds.upper * i.safety_stock_qty).length

  const abcCounts = {
    A: inventory.filter(i => i.abc_class === 'A').length,
    B: inventory.filter(i => i.abc_class === 'B').length,
    C: inventory.filter(i => i.abc_class === 'C').length,
  }

  useSidebarActionsEffect(
    <div className="flex flex-col gap-1.5 items-start">
      {saved && (
        <span className="w-3/4 flex items-center gap-1.5 text-xs text-indigo-400 font-medium bg-indigo-400/10 px-2 py-1.5 rounded-lg">
          <Check className="w-3.5 h-3.5 shrink-0" /> Saved: {saved}
        </span>
      )}
      <p className="w-3/4 text-[9px] font-medium uppercase tracking-widest text-white/80 mt-5 mb-1">ABC Service Levels</p>
      {(['A', 'B', 'C'] as const).map(cls => (
        <div key={cls} className="w-3/4 flex items-center gap-2">
          <span className={`text-xs font-bold w-4 ${cls === 'A' ? 'text-indigo-400' : cls === 'B' ? 'text-amber-400' : 'text-white/70'}`}>{cls}</span>
          <input
            type="number"
            min={50}
            max={99}
            step={1}
            value={serviceLevels[cls]}
            onChange={e => setServiceLevels(prev => {
              const next = { ...prev, [cls]: Number(e.target.value) }
              localStorage.setItem('abc_service_levels', JSON.stringify(next))
              return next
            })}
            className="flex-1 text-xs text-right border border-white/20 rounded px-2 py-1 bg-white/[0.06] text-white focus:outline-none focus:ring-1 focus:ring-white/40"
          />
          <span className="text-xs text-white/70 w-8 shrink-0">%</span>
        </div>
      ))}
      <Button variant="secondary" size="sm" onClick={handleApplyServiceLevels} disabled={slLoading} className="w-3/4 justify-center mt-3">
        <Calculator className="w-3.5 h-3.5" />
        {slLoading ? 'Applying...' : 'Apply & Recalculate SS'}
      </Button>
      <Button variant="secondary" size="sm" onClick={handleRecalcRop} disabled={ropLoading} className="w-3/4 justify-center mt-1">
        <Calculator className="w-3.5 h-3.5" />
        {ropLoading ? 'Calculating...' : 'Recalculate ROP'}
      </Button>

      <p className="w-3/4 text-[9px] font-medium uppercase tracking-widest text-white/80 mt-5 mb-1">Inventory Health</p>
      <p className="w-3/4 text-[9px] text-white/40 mb-2">Multiples of safety stock</p>
      <div className="w-3/4 flex items-center gap-2 mb-1">
        <span className="text-[10px] text-red-400 font-medium w-14 shrink-0 leading-tight">Lower range,<br/>healthy</span>
        <input
          type="number"
          min={0.1}
          max={healthThresholds.upper - 0.1}
          step={0.5}
          value={healthThresholds.lower}
          onChange={e => setHealthThresholds(prev => {
            const next = { ...prev, lower: Number(e.target.value) }
            localStorage.setItem('inventory_health_thresholds', JSON.stringify(next))
            return next
          })}
          className="flex-1 min-w-0 text-xs text-right border border-white/20 rounded px-2 py-1 bg-white/[0.06] text-white focus:outline-none focus:ring-1 focus:ring-white/40"
        />
        <span className="text-xs text-white/70 w-8 shrink-0">x SS</span>
      </div>
      <div className="w-3/4 flex items-center gap-2 mb-1">
        <span className="text-[10px] text-purple-400 font-medium w-14 shrink-0 leading-tight">Upper range,<br/>healthy</span>
        <input
          type="number"
          min={healthThresholds.lower + 0.1}
          step={0.5}
          value={healthThresholds.upper}
          onChange={e => setHealthThresholds(prev => {
            const next = { ...prev, upper: Number(e.target.value) }
            localStorage.setItem('inventory_health_thresholds', JSON.stringify(next))
            return next
          })}
          className="flex-1 min-w-0 text-xs text-right border border-white/20 rounded px-2 py-1 bg-white/[0.06] text-white focus:outline-none focus:ring-1 focus:ring-white/40"
        />
        <span className="text-xs text-white/70 w-8 shrink-0">x SS</span>
      </div>
      <div className="w-3/4 flex items-center gap-2 mb-1">
        <span className="text-[10px] text-blue-400 font-medium w-14 shrink-0 leading-tight">Min weeks<br/>cover</span>
        <input
          type="number"
          min={1}
          max={52}
          step={1}
          value={healthThresholds.min_weeks_cover}
          onChange={e => setHealthThresholds(prev => {
            const next = { ...prev, min_weeks_cover: Number(e.target.value) }
            localStorage.setItem('inventory_health_thresholds', JSON.stringify(next))
            return next
          })}
          className="flex-1 min-w-0 text-xs text-right border border-white/20 rounded px-2 py-1 bg-white/[0.06] text-white focus:outline-none focus:ring-1 focus:ring-white/40"
        />
        <span className="text-xs text-white/70 w-8 shrink-0">wks</span>
      </div>
      <div className="w-3/4 mt-3 rounded-lg bg-white/[0.04] border border-white/10 px-2.5 py-2 space-y-1">
        <div className="flex items-center gap-2 text-[10px]">
          <span className="w-2 h-2 rounded-full bg-red-500 shrink-0"/>
          <span className="text-white/60">Below {healthThresholds.lower}x SS - at risk</span>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <span className="w-2 h-2 rounded-full bg-green-500 shrink-0"/>
          <span className="text-white/60">{healthThresholds.lower}x - {healthThresholds.upper}x SS - healthy</span>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <span className="w-2 h-2 rounded-full bg-purple-500 shrink-0"/>
          <span className="text-white/60">Above {healthThresholds.upper}x SS - excess</span>
        </div>
      </div>
    </div>,
    [saved, recalcLoading, ropLoading, slLoading, serviceLevels, healthThresholds],
  )

  if (loading) return <Spinner className="h-64" />

  return (
    <div>
      <PageHeader
        title="Inventory"
        description="Inventory positions, ABC analysis, and safety stock"
      />

      {/* Stats */}
      <div className="grid grid-cols-5 gap-3 mb-5">
        <Card>
          <p className="text-[10px] font-bold uppercase tracking-widest text-white/40 mb-2">Total Inv. Value</p>
          <p className="text-2xl font-bold text-white leading-none">{fmtCurrency(totalValue)}</p>
        </Card>
        <Card>
          <p className="text-[10px] font-bold uppercase tracking-widest text-white/40 mb-2">Stockouts</p>
          <p className={`text-2xl font-bold leading-none ${criticalCount > 0 ? 'text-red-400' : 'text-white'}`}>{criticalCount}</p>
        </Card>
        <Card>
          <p className="text-[10px] font-bold uppercase tracking-widest text-white/40 mb-2">Below Safety Stock</p>
          <p className={`text-2xl font-bold leading-none ${warningCount > 0 ? 'text-amber-400' : 'text-white'}`}>{warningCount}</p>
        </Card>
        <Card>
          <p className="text-[10px] font-bold uppercase tracking-widest text-white/40 mb-2">Excess Stock</p>
          <p className={`text-2xl font-bold leading-none ${excessCount > 0 ? 'text-zinc-400' : 'text-white'}`}>{excessCount}</p>
        </Card>
        <Card>
          <p className="text-[10px] font-bold uppercase tracking-widest text-white/40 mb-2">ABC Split</p>
          <p className="text-2xl font-bold text-white leading-none">{abcCounts.A} / {abcCounts.B} / {abcCounts.C}</p>
        </Card>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4">
        {(['inventory', 'abc'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              activeTab === tab
                ? 'bg-brand-600 text-white'
                : 'text-white/70 hover:text-white hover:bg-white/[0.08]'
            }`}
          >
            {tab === 'inventory' ? 'Inventory Positions' : 'ABC Analysis'}
          </button>
        ))}
      </div>

      {activeTab === 'inventory' && (
        <Card className="p-0 overflow-hidden">
          <DataTable
            rowData={filteredInventory as unknown as Record<string, unknown>[]}
            columnDefs={invCols}
            height={520}
            onCellValueChanged={handleCellChange}
            rowClassRules={{
              'bg-red-400/10': p => p.data?.status === 'stockout',
              'bg-amber-400/10': p => p.data?.status === 'below_ss',
              'bg-white/5': p => p.data?.status === 'healthy',
            }}
          />
        </Card>
      )}

      {activeTab === 'abc' && (
        <div className="grid grid-cols-3 gap-4">
          <div className="col-span-2">
            <Card className="p-0 overflow-hidden">
              <div className="px-5 py-4 border-b border-white/10 glass-light">
                <h3 className="text-sm font-semibold text-white">Pareto Analysis — Annual Revenue</h3>
                <p className="text-xs text-white/50 mt-0.5">A = top 80%, B = 80–95%, C = bottom 5%</p>
              </div>
              <DataTable
                rowData={abcItems as unknown as Record<string, unknown>[]}
                columnDefs={abcCols}
                height={440}
                rowClassRules={{
                  'bg-white/[0.06]': p => p.data?.abc_class === 'A',
                  'bg-amber-400/10': p => p.data?.abc_class === 'B',
                }}
              />
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader><CardTitle>ABC Distribution</CardTitle></CardHeader>
              <ABCPieChart counts={abcCounts} />
            </Card>
            <Card>
              <CardHeader><CardTitle>Revenue by Class</CardTitle></CardHeader>
              <ABCRevenueBar items={abcItems} />
            </Card>
            {abcItems.some(i => i.abc_locked) && (
              <Card>
                <CardHeader><CardTitle>Manual Overrides</CardTitle></CardHeader>
                <p className="text-xs text-white/50 mb-3">Items whose ABC class has been manually changed from the model's Pareto classification.</p>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-white/10">
                      <th className="text-left py-1.5 pr-3 text-white/60 font-medium">SKU</th>
                      <th className="text-left py-1.5 pr-3 text-white/60 font-medium">Description</th>
                      <th className="text-center py-1.5 pr-3 text-white/60 font-medium">Model</th>
                      <th className="text-center py-1.5 text-white/60 font-medium">Override</th>
                    </tr>
                  </thead>
                  <tbody>
                    {abcItems.filter(i => i.abc_locked).map(item => (
                      <tr key={item.product_id} className="border-b border-white/5">
                        <td className="py-1.5 pr-3 font-mono text-white/80">{item.sku}</td>
                        <td className="py-1.5 pr-3 text-white/70 truncate max-w-[120px]">{item.description}</td>
                        <td className="py-1.5 pr-3 text-center">
                          <span className={`font-bold ${item.model_abc_class === 'A' ? 'text-emerald-500' : item.model_abc_class === 'B' ? 'text-amber-500' : 'text-white/50'}`}>
                            {item.model_abc_class ?? '—'}
                          </span>
                        </td>
                        <td className="py-1.5 text-center">
                          <span className={`font-bold ${item.abc_class === 'A' ? 'text-emerald-400' : item.abc_class === 'B' ? 'text-amber-400' : 'text-white/50'}`}>
                            {item.abc_class ?? '—'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
