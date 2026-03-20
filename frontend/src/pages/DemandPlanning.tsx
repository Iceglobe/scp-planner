import { useEffect, useState, useCallback, useMemo } from 'react'
import { Play, RefreshCw, History, ChevronDown, Save, BarChart2 } from 'lucide-react'
import { useSidebarActionsEffect } from '../context/SidebarActionsContext'
import { useFilters } from '../context/FilterContext'
import { MultiSelect } from '../components/ui/MultiSelect'
import { getDemandPivot, runForecast, getForecastRuns, adjustForecast, adjustForecastMonth,
         reforecastProduct, getAdjustmentLog, saveForecastRun, getForecastAccuracy } from '../api'
import type { PivotData, PivotRow, ForecastRun } from '../api/types'
import { PivotTable } from '../components/tables/PivotTable'
import { ForecastChart } from '../components/charts/ForecastChart'
import { Card, CardHeader, CardTitle, PageHeader, Button, Select, Spinner, Badge } from '../components/ui'
import { fmtNumber } from '../utils/formatters'

const MODEL_OPTIONS = [
  { value: 'AUTO', label: 'Auto (best fit)' },
  { value: 'SMA', label: 'Simple Moving Average' },
  { value: 'WMA', label: 'Weighted Moving Average' },
  { value: 'HOLT_WINTERS', label: 'Holt-Winters' },
  { value: 'ARIMA', label: 'ARIMA (auto)' },
]
const HORIZON_OPTIONS = [
  { value: '6', label: '6 months' },
  { value: '12', label: '12 months' },
  { value: '18', label: '18 months' },
]
const GRAN_OPTIONS = [
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
]
const LAG_OPTIONS = [
  { value: '1', label: '1 week ago' },
  { value: '2', label: '2 weeks ago' },
  { value: '4', label: '4 weeks ago' },
  { value: '8', label: '8 weeks ago' },
  { value: '12', label: '12 weeks ago' },
  { value: '16', label: '16 weeks ago' },
]

interface AdjustLogEntry {
  id: number; product_id: number; sku: string; description: string
  period_date: string; old_qty: number | null; new_qty: number
  changed_by: string; changed_at: string
}
interface AccuracyProduct {
  product_id: number; sku: string; description: string; abc_class?: string
  periods_compared: number; mape: number | null; mae: number | null; bias: number | null
}
interface AccuracyResult {
  lag_weeks: number; runs_found: number; run_dates: string[]
  products: AccuracyProduct[]
  overall: { mape: number | null; mae: number | null; bias: number | null } | null
}

export default function DemandPlanning() {
  const [pivot, setPivot] = useState<PivotData | null>(null)
  const [runs, setRuns] = useState<ForecastRun[]>([])
  const [selectedRow, setSelectedRow] = useState<PivotRow | null>(null)
  const [chartData, setChartData] = useState<Record<string, unknown>[]>([])
  const [adjustLog, setAdjustLog] = useState<AdjustLogEntry[]>([])
  const [showLog, setShowLog] = useState(false)

  // Save dialog
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saving, setSaving] = useState(false)

  // Accuracy panel
  const [showAccuracy, setShowAccuracy] = useState(false)
  const [accuracyMode, setAccuracyMode] = useState<'lag' | 'run'>('lag')
  const [lagWeeks, setLagWeeks] = useState('4')
  const [accuracyRunId, setAccuracyRunId] = useState<string>('')
  const [accuracy, setAccuracy] = useState<AccuracyResult | null>(null)
  const [loadingAccuracy, setLoadingAccuracy] = useState(false)

  const [customerFilter, setCustomerFilter] = useState<string[]>([])
  const { itemIds, productNames } = useFilters()

  const [viewUnit, setViewUnit] = useState<'qty' | 'revenue'>('qty')
  const [model, setModel] = useState('AUTO')
  const [periods, setPeriods] = useState('12')
  const [granularity, setGranularity] = useState('week')
  const [viewMode, setViewMode] = useState<'sku' | 'customer'>('sku')
  const [selectedRunId, setSelectedRunId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)

  const loadPivot = useCallback((runId?: string) => {
    setLoading(true)
    const params: Record<string, string> = { granularity, group_by: viewMode }
    if (runId) params.forecast_run_id = runId
    Promise.all([
      getDemandPivot(params),
      getForecastRuns(),
    ]).then(([p, r]) => {
      setPivot(p)
      setRuns(r)
      if (!runId && r.length > 0) setSelectedRunId(r[0].run_id)
    }).finally(() => setLoading(false))
  }, [granularity, viewMode])

  useEffect(() => { loadPivot() }, [loadPivot])

  const handleRunForecast = async () => {
    setRunning(true)
    try {
      const result = await runForecast({ model, periods: parseInt(periods), granularity })
      setSelectedRunId(result.run_id)
      loadPivot(result.run_id)
    } finally {
      setRunning(false)
    }
  }

  const handleLoadRun = (runId: string) => {
    setSelectedRunId(runId)
    loadPivot(runId)
  }

  const savedRuns = runs.filter(r => r.name)
  const currentRunIsSaved = runs.find(r => r.run_id === selectedRunId)?.name != null
  const savedSlotsLeft = 5 - savedRuns.filter(r => r.run_id !== selectedRunId).length

  const handleSave = async () => {
    if (!saveName.trim() || !selectedRunId) return
    setSaving(true)
    try {
      await saveForecastRun(selectedRunId, saveName.trim())
      setShowSaveDialog(false)
      setSaveName('')
      getForecastRuns().then(setRuns)
    } finally {
      setSaving(false)
    }
  }

  const handleLoadAccuracy = async () => {
    setLoadingAccuracy(true)
    try {
      const result = await getForecastAccuracy(
        parseInt(lagWeeks),
        accuracyMode === 'run' && accuracyRunId ? accuracyRunId : undefined,
      )
      setAccuracy(result)
    } finally {
      setLoadingAccuracy(false)
    }
  }

  useEffect(() => {
    if (showAccuracy) handleLoadAccuracy()
  }, [lagWeeks, accuracyRunId, accuracyMode, showAccuracy]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCellEdit = useCallback(async (forecastId: number, productId: number, periodKey: string, value: number) => {
    if (granularity === 'month') {
      // Monthly cell = sum of N weekly forecasts → split evenly across all weeks
      await adjustForecastMonth({
        product_id: productId,
        year_month: periodKey,
        total_qty: value,
        run_id: selectedRunId || undefined,
      })
    } else {
      await adjustForecast(forecastId, value)
    }
    setPivot(prev => {
      if (!prev) return prev
      return {
        ...prev,
        rows: prev.rows.map(row => {
          if (row.product_id !== productId) return row
          return { ...row, [`f_${periodKey}`]: value, [`fa_${periodKey}`]: true }
        }),
      }
    })
    if (showLog) getAdjustmentLog().then(setAdjustLog)
  }, [showLog, granularity, selectedRunId])

  const handleModelChange = useCallback(async (productId: number, newModel: string) => {
    await reforecastProduct({ product_id: productId, model: newModel, periods: parseInt(periods), granularity })
    loadPivot(selectedRunId || undefined)
  }, [periods, granularity, selectedRunId, loadPivot])

  // Per-row chart data (respects viewUnit)
  const buildRowChartData = useCallback((row: PivotRow) => {
    if (!pivot) return []
    const sp = viewUnit === 'revenue' ? ((row.selling_price as number) || 0) : 1
    return pivot.periods.map(period => ({
      label: period.label,
      actual: (row[`a_${period.key}`] as number | undefined) != null
        ? (row[`a_${period.key}`] as number) * sp : undefined,
      forecast: (row[`f_${period.key}`] as number | undefined) != null
        ? (row[`f_${period.key}`] as number) * sp : undefined,
      lower: (row[`fl_${period.key}`] as number | undefined) != null
        ? (row[`fl_${period.key}`] as number) * sp : undefined,
      upper: (row[`fu_${period.key}`] as number | undefined) != null
        ? (row[`fu_${period.key}`] as number) * sp : undefined,
    }))
  }, [pivot, viewUnit])

  // Derive unique customer options from pivot rows
  const customerOptions = useMemo(() => {
    if (!pivot) return []
    return [...new Set(pivot.rows.map(r => r.customer as string | undefined).filter(Boolean))].sort() as string[]
  }, [pivot])

  // Apply text filters to pivot rows
  const filteredPivot = useMemo(() => {
    if (!pivot) return pivot
    if (!itemIds.length && !productNames.length && !customerFilter.length) return pivot
    const rows = pivot.rows.filter(r => {
      if (itemIds.length > 0 && !itemIds.includes(r.sku ?? '')) return false
      if (productNames.length > 0 && !productNames.includes(r.description ?? '')) return false
      if (customerFilter.length > 0 && !customerFilter.includes(r.customer as string ?? '')) return false
      return true
    })
    return { ...pivot, rows }
  }, [pivot, itemIds, productNames, customerFilter])

  // Aggregate chart: sum all rows per period
  const aggregateChartData = useMemo(() => {
    if (!filteredPivot) return []
    return filteredPivot.periods.map(period => {
      let actual = 0, forecast = 0, lower = 0, upper = 0
      let hasActual = false, hasForecast = false
      for (const row of filteredPivot.rows) {
        const sp = viewUnit === 'revenue' ? ((row.selling_price as number) || 0) : 1
        const a = row[`a_${period.key}`] as number | undefined
        const f = row[`f_${period.key}`] as number | undefined
        const fl = row[`fl_${period.key}`] as number | undefined
        const fu = row[`fu_${period.key}`] as number | undefined
        if (a != null) { actual += a * sp; hasActual = true }
        if (f != null) { forecast += f * sp; hasForecast = true }
        if (fl != null) lower += fl * sp
        if (fu != null) upper += fu * sp
      }
      return {
        label: period.label,
        actual: hasActual ? actual : undefined,
        forecast: hasForecast ? forecast : undefined,
        lower: hasForecast ? lower : undefined,
        upper: hasForecast ? upper : undefined,
      }
    })
  }, [filteredPivot, viewUnit])

  // Rebuild chart whenever pivot/viewUnit changes and a row is selected
  useEffect(() => {
    if (!pivot || !selectedRow) return
    const freshRow = pivot.rows.find(r => r.product_id === selectedRow.product_id)
    if (!freshRow) return
    setChartData(buildRowChartData(freshRow))
    setSelectedRow(freshRow)
  }, [pivot, viewUnit]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleRowClick = useCallback((row: PivotRow) => {
    setSelectedRow(row)
    setChartData(buildRowChartData(row))
  }, [buildRowChartData])

  const handleRowDoubleClick = useCallback(() => {
    setSelectedRow(null)
    setChartData([])
  }, [])

  const handleShowLog = async () => {
    const log = await getAdjustmentLog()
    setAdjustLog(log)
    setShowLog(v => !v)
  }

  const latestRun = runs[0]
  const currentRun = runs.find(r => r.run_id === selectedRunId)
  const runOptions = savedRuns.map(r => ({
    value: r.run_id,
    label: `★ ${r.name} — ${new Date(r.created_at).toLocaleDateString()}`,
  }))

  const mapeColor = (v: number | null) =>
    v == null ? 'text-white/70' : v < 15 ? 'text-emerald-600' : v < 30 ? 'text-amber-600' : 'text-red-600'

  useSidebarActionsEffect(
    <div className="flex flex-col gap-2 items-start">
      <p className="w-3/4 text-[9px] font-medium uppercase tracking-widest text-white/70 mb-1">Demand Filters</p>
      <MultiSelect
        options={customerOptions}
        value={customerFilter}
        onChange={setCustomerFilter}
        placeholder="Customer…"
      />
      <p className="w-3/4 text-[9px] font-medium uppercase tracking-widest text-white/70 mt-5 mb-1">Forecast Settings</p>
      <Select value={granularity} onChange={setGranularity} options={GRAN_OPTIONS} className="w-3/4" />
      <Select value={model} onChange={setModel} options={MODEL_OPTIONS} className="w-3/4" />
      <Select value={periods} onChange={setPeriods} options={HORIZON_OPTIONS} className="w-3/4" />
      <Button variant="primary" onClick={handleRunForecast} disabled={running} size="sm" className="w-3/4 justify-center mt-3">
        <Play className="w-3.5 h-3.5" />
        {running ? 'Running...' : 'Run Forecast'}
      </Button>
      {selectedRunId && (
        <Button variant="secondary" onClick={() => setShowSaveDialog(v => !v)} size="sm" className="w-3/4 justify-center">
          <Save className="w-3.5 h-3.5" />
          Save Run
        </Button>
      )}
      <div className="w-3/4 flex gap-1 mt-2">
        <Button variant={showAccuracy ? 'secondary' : 'ghost'} onClick={() => setShowAccuracy(v => !v)} size="sm" className="flex-1 justify-center">
          <BarChart2 className="w-3.5 h-3.5" />
        </Button>
        <Button variant={showLog ? 'secondary' : 'ghost'} onClick={handleShowLog} size="sm" className="flex-1 justify-center">
          <History className="w-3.5 h-3.5" />
          {adjustLog.length > 0 && (
            <span className="ml-0.5 bg-amber-100 text-amber-700 text-[10px] font-semibold rounded-full px-1 leading-none py-0.5">
              {adjustLog.length}
            </span>
          )}
        </Button>
        <Button variant="ghost" onClick={() => loadPivot(selectedRunId || undefined)} size="sm" className="flex-1 justify-center">
          <RefreshCw className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>,
    [granularity, model, periods, running, selectedRunId, showSaveDialog, showAccuracy, showLog, adjustLog.length, customerFilter, customerOptions],
  )

  return (
    <div>
      <PageHeader
        title="Demand Planning"
        description="Statistical forecasts with time-series pivot view"
      />

      {/* Save dialog */}
      {showSaveDialog && (
        <div className="flex items-center gap-2 mb-3 px-3 py-2.5 bg-white/[0.06] border border-white/10 rounded-xl backdrop-blur-sm">
          <Save className="w-3.5 h-3.5 text-white/40 shrink-0" />
          <span className="text-[11px] font-medium uppercase tracking-widest text-white/50 shrink-0">
            {currentRunIsSaved ? 'Rename:' : 'Save as:'}
          </span>
          <input
            autoFocus
            type="text"
            value={saveName}
            onChange={e => setSaveName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setShowSaveDialog(false) }}
            placeholder="e.g. Q1 2026 baseline"
            className="flex-1 text-sm bg-transparent border-none outline-none text-white placeholder-white/20"
          />
          {!currentRunIsSaved && (
            <span className="text-[10px] text-white/30 shrink-0">{savedSlotsLeft} left</span>
          )}
          <Button variant="primary" onClick={handleSave} disabled={saving || !saveName.trim()} size="sm">
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <Card>
          <p className="text-[10px] font-medium uppercase tracking-widest text-white/70 mb-2">Saved Forecasts</p>
          <p className="text-2xl font-serif font-normal text-white leading-none">{runs.filter(r => r.name).length}</p>
        </Card>
        <Card>
          <p className="text-[10px] font-medium uppercase tracking-widest text-white/70 mb-2">Viewing</p>
          <p className="text-2xl font-serif font-normal text-white leading-none truncate" title={currentRun?.name || currentRun?.model}>
            {currentRun?.name || currentRun?.model || '—'}
          </p>
        </Card>
        <Card>
          <p className="text-[10px] font-medium uppercase tracking-widest text-white/70 mb-2">Avg MAPE</p>
          <p className={`text-2xl font-serif font-normal leading-none ${mapeColor(latestRun?.mape ?? null)}`}>
            {latestRun?.mape != null ? `${latestRun.mape.toFixed(1)}%` : '—'}
          </p>
        </Card>
        <Card>
          <p className="text-[10px] font-medium uppercase tracking-widest text-white/70 mb-2">Horizon</p>
          <p className="text-2xl font-serif font-normal text-white leading-none">
            {latestRun?.periods_ahead != null ? `${latestRun.periods_ahead} months` : '—'}
          </p>
        </Card>
      </div>

      {/* Run selector */}
      {savedRuns.length > 1 && (
        <div className="flex items-center gap-2 mb-3">
          <ChevronDown className="w-3.5 h-3.5 text-white/70" />
          <span className="text-xs text-white/80">Viewing:</span>
          <select
            value={selectedRunId}
            onChange={e => handleLoadRun(e.target.value)}
            className="text-xs border border-white/20 rounded px-2 py-1 bg-white/[0.08] text-white focus:outline-none focus:ring-1 focus:ring-blue-400"
          >
            {runOptions.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      )}

      {/* View mode toggle + legend */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-4 text-xs text-white/80">
          {/* Qty / Revenue toggle */}
          <div className="flex rounded overflow-hidden border border-white/20 text-xs mr-2">
            {(['qty', 'revenue'] as const).map(u => (
              <button key={u} onClick={() => setViewUnit(u)}
                className={`px-3 py-1.5 font-medium ${viewUnit === u ? 'bg-brand-600 text-white' : 'bg-white/[0.08] text-white hover:bg-white/15'}`}>
                {u === 'qty' ? 'Qty' : 'Revenue'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-blue-100 border border-blue-200" />
            Actual demand
          </div>
          {viewMode === 'sku' ? (
            <>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-violet-100 border border-violet-200" />
                Forecast (editable)
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-amber-100 border border-amber-200" />
                Manually adjusted
              </div>
            </>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded bg-violet-100 border border-violet-200" />
              Customer forecast
            </div>
          )}
        </div>
        <div className="flex rounded overflow-hidden border border-white/20 text-xs">
          <button
            onClick={() => setViewMode('sku')}
            className={`px-3 py-1.5 font-medium ${viewMode === 'sku' ? 'bg-brand-600 text-white' : 'bg-white/[0.08] text-white hover:bg-white/15'}`}
          >
            By SKU
          </button>
          <button
            onClick={() => setViewMode('customer')}
            className={`px-3 py-1.5 font-medium ${viewMode === 'customer' ? 'bg-brand-600 text-white' : 'bg-white/[0.08] text-white hover:bg-white/15'}`}
          >
            By Customer
          </button>
        </div>
      </div>

      {/* Pivot Table */}
      {loading ? (
        <Spinner className="h-40" />
      ) : filteredPivot ? (
        <Card className="p-0 overflow-hidden mb-4">
          <PivotTable
            data={filteredPivot}
            onRowClick={viewMode === 'sku' ? handleRowClick : undefined}
            onRowDoubleClick={viewMode === 'sku' ? handleRowDoubleClick : undefined}
            onCellEdit={viewMode === 'sku' && viewUnit === 'qty' ? handleCellEdit : undefined}
            onModelChange={viewMode === 'sku' ? handleModelChange : undefined}
            mode={viewMode}
          />
        </Card>
      ) : null}

      {/* Forecast Accuracy panel */}
      {showAccuracy && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Forecast Accuracy</CardTitle>
            <div className="flex items-center gap-2">
              {/* Mode toggle */}
              <div className="flex rounded overflow-hidden border border-white/20 text-xs">
                <button
                  onClick={() => setAccuracyMode('lag')}
                  className={`px-2 py-1 ${accuracyMode === 'lag' ? 'bg-brand-600 text-white' : 'bg-white/[0.08] text-white hover:bg-white/15'}`}
                >
                  By age
                </button>
                <button
                  onClick={() => setAccuracyMode('run')}
                  className={`px-2 py-1 ${accuracyMode === 'run' ? 'bg-brand-600 text-white' : 'bg-white/[0.08] text-white hover:bg-white/15'}`}
                >
                  By run
                </button>
              </div>
              {accuracyMode === 'lag' ? (
                <select
                  value={lagWeeks}
                  onChange={e => setLagWeeks(e.target.value)}
                  className="text-xs border border-white/20 rounded px-2 py-1 bg-white/[0.08] text-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                >
                  {LAG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <select
                  value={accuracyRunId}
                  onChange={e => setAccuracyRunId(e.target.value)}
                  className="text-xs border border-white/20 rounded px-2 py-1 bg-white/[0.08] text-white focus:outline-none focus:ring-1 focus:ring-blue-400 max-w-[200px]"
                >
                  <option value="">Select a forecast run…</option>
                  {savedRuns.map(r => (
                    <option key={r.run_id} value={r.run_id}>
                      {r.name} — {new Date(r.created_at).toLocaleDateString()}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </CardHeader>
          {loadingAccuracy ? (
            <Spinner className="h-24" />
          ) : accuracy ? (
            accuracy.runs_found === 0 ? (
              <p className="text-xs text-white/70 py-4 text-center">
                No forecast runs found from {lagWeeks} week{parseInt(lagWeeks) > 1 ? 's' : ''} ago.
                Run forecasts regularly to build accuracy history.
              </p>
            ) : (
              <>
                {/* Overall summary */}
                {accuracy.overall && (
                  <div className="flex gap-6 px-1 py-3 mb-2 bg-white/[0.06] rounded-lg">
                    <div className="text-center">
                      <p className="text-xs text-white/70">Overall MAPE</p>
                      <p className={`text-lg font-semibold ${mapeColor(accuracy.overall.mape)}`}>
                        {accuracy.overall.mape != null ? `${accuracy.overall.mape.toFixed(1)}%` : '—'}
                      </p>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-white/70">Overall MAE</p>
                      <p className="text-lg font-semibold text-white">
                        {accuracy.overall.mae != null ? fmtNumber(accuracy.overall.mae) : '—'}
                      </p>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-white/70">Bias</p>
                      <p className={`text-lg font-semibold ${(accuracy.overall.bias ?? 0) > 0 ? 'text-blue-600' : 'text-red-600'}`}>
                        {accuracy.overall.bias != null ? (accuracy.overall.bias > 0 ? '+' : '') + fmtNumber(accuracy.overall.bias) : '—'}
                      </p>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-white/70">Runs compared</p>
                      <p className="text-lg font-semibold text-white">{accuracy.runs_found}</p>
                    </div>
                  </div>
                )}
                {/* Per-product table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-white/10">
                        <th className="text-left py-1.5 pr-3 text-white/70 font-medium">SKU</th>
                        <th className="text-left py-1.5 pr-3 text-white/70 font-medium">Description</th>
                        <th className="text-center py-1.5 pr-3 text-white/70 font-medium">ABC</th>
                        <th className="text-right py-1.5 pr-3 text-white/70 font-medium">Periods</th>
                        <th className="text-right py-1.5 pr-3 text-white/70 font-medium">MAPE</th>
                        <th className="text-right py-1.5 pr-3 text-white/70 font-medium">MAE</th>
                        <th className="text-right py-1.5 text-white/70 font-medium">Bias</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accuracy.products.map(p => (
                        <tr key={p.product_id} className="border-b border-white/5 hover:bg-white/[0.06]">
                          <td className="py-1.5 pr-3 font-mono text-white/90">{p.sku}</td>
                          <td className="py-1.5 pr-3 text-white/80 truncate max-w-[160px]">{p.description}</td>
                          <td className="py-1.5 pr-3 text-center">
                            <span className={`text-xs font-bold ${p.abc_class === 'A' ? 'text-emerald-600' : p.abc_class === 'B' ? 'text-amber-600' : 'text-white/70'}`}>
                              {p.abc_class ?? '—'}
                            </span>
                          </td>
                          <td className="py-1.5 pr-3 text-right text-white/70">{p.periods_compared}</td>
                          <td className={`py-1.5 pr-3 text-right font-semibold ${mapeColor(p.mape)}`}>
                            {p.mape != null ? `${p.mape.toFixed(1)}%` : '—'}
                          </td>
                          <td className="py-1.5 pr-3 text-right text-white/90">
                            {p.mae != null ? fmtNumber(p.mae) : '—'}
                          </td>
                          <td className={`py-1.5 text-right font-medium ${(p.bias ?? 0) > 0 ? 'text-blue-600' : 'text-red-500'}`}>
                            {p.bias != null ? (p.bias > 0 ? '+' : '') + fmtNumber(p.bias) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )
          ) : null}
        </Card>
      )}

      {/* Adjustment log */}
      {showLog && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>
              Forecast Adjustment Log
              {adjustLog.length > 0 && (
                <span className="ml-2 text-sm font-normal text-white/70">{adjustLog.length} change{adjustLog.length !== 1 ? 's' : ''}</span>
              )}
            </CardTitle>
          </CardHeader>
          {adjustLog.length === 0 ? (
            <p className="text-xs text-white/70 py-4 text-center">No manual adjustments yet</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="text-left py-1.5 pr-4 text-white/70 font-medium">SKU</th>
                    <th className="text-left py-1.5 pr-4 text-white/70 font-medium">Product</th>
                    <th className="text-left py-1.5 pr-4 text-white/70 font-medium">Period</th>
                    <th className="text-right py-1.5 pr-4 text-white/70 font-medium">Old</th>
                    <th className="text-right py-1.5 pr-4 text-white/70 font-medium">New</th>
                    <th className="text-left py-1.5 pr-4 text-white/70 font-medium">Changed by</th>
                    <th className="text-left py-1.5 text-white/70 font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {adjustLog.map(e => (
                    <tr key={e.id} className="border-b border-white/5 hover:bg-white/[0.06]">
                      <td className="py-1.5 pr-4 font-mono text-white/90">{e.sku}</td>
                      <td className="py-1.5 pr-4 text-white/80 max-w-[160px] truncate">{e.description}</td>
                      <td className="py-1.5 pr-4 text-white/80">{e.period_date}</td>
                      <td className="py-1.5 pr-4 text-right text-white/70">{e.old_qty != null ? fmtNumber(e.old_qty) : '—'}</td>
                      <td className="py-1.5 pr-4 text-right font-semibold text-amber-700">{fmtNumber(e.new_qty)}</td>
                      <td className="py-1.5 pr-4 text-white/80">{e.changed_by}</td>
                      <td className="py-1.5 text-white/70 whitespace-nowrap">{new Date(e.changed_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Chart — always visible: aggregate when no row selected, SKU detail when selected */}
      {filteredPivot && (
        <div>
          <div>
            <Card>
              <CardHeader>
                <div>
                  {selectedRow ? (
                    <>
                      <CardTitle>
                        <span className="font-mono mr-2">{selectedRow.sku}</span>
                        {selectedRow.description as string}
                      </CardTitle>
                      <p className="text-xs text-white/70 mt-0.5">
                        Safety stock: {fmtNumber(selectedRow.safety_stock_qty as number)} units
                        {viewUnit === 'revenue' && <span className="ml-2 text-amber-600">(Revenue view — editing disabled)</span>}
                      </p>
                    </>
                  ) : (
                    <CardTitle>All Items — Aggregate {viewUnit === 'revenue' ? 'Revenue' : 'Quantity'}</CardTitle>
                  )}
                </div>
                {selectedRow && <Badge variant="purple">{selectedRow.abc_class as string}</Badge>}
              </CardHeader>
              <ForecastChart
                data={(selectedRow ? chartData : aggregateChartData) as { label: string; actual?: number; forecast?: number; lower?: number; upper?: number }[]}
              />
            </Card>
          </div>

        </div>
      )}
    </div>
  )
}
