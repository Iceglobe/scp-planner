import { useEffect, useState, useMemo, useCallback } from 'react'
import { AgGridReact } from 'ag-grid-react'
import type { ColDef, FirstDataRenderedEvent } from 'ag-grid-community'
import 'ag-grid-community/styles/ag-grid.css'
import 'ag-grid-community/styles/ag-theme-alpine.css'
import {
  BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ComposedChart, Line, ReferenceLine, CartesianGrid, Legend,
} from 'recharts'
import type { TooltipProps } from 'recharts'
import { getDemandPivot, getForecastRuns, getKpis, getMrpPivot, getInventory } from '../api'
import type { PivotData, PivotRow, PeriodInfo, Kpis, MrpPivotData, MrpRow, InventoryRow } from '../api/types'
import { Card, CardHeader, CardTitle, Spinner, PageHeader } from '../components/ui'
import { ForecastChart } from '../components/charts/ForecastChart'
import { fmtNumber, fmtCurrency } from '../utils/formatters'
import { useSidebarActionsEffect } from '../context/SidebarActionsContext'

// ── helpers ────────────────────────────────────────────────────────────────

function filterPeriods(periods: PeriodInfo[], window: 'mtd' | 'ytd', includeFuture = false): PeriodInfo[] {
  const now = new Date()
  return periods.filter(p => {
    if (!includeFuture && p.is_future) return false
    const d = new Date(p.date)
    if (window === 'mtd') return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
    return d.getFullYear() === now.getFullYear()
  })
}

function sumOverPeriods(row: PivotRow, periods: PeriodInfo[], prefix: 'a' | 'f'): number {
  return periods.reduce((s, p) => s + (((row[`${prefix}_${p.key}`]) as number) || 0), 0)
}

// ── types ──────────────────────────────────────────────────────────────────

interface TableRow {
  sku: string
  description: string
  sales: number
  forecast: number
  error: number
}

interface RiskItem {
  sku: string
  description: string
  onHand: number
  unitCost: number
  daysSupply: number
  lowerTarget: number
  upperTarget: number
  riskType: 'stockout' | 'projected_stockout' | 'excess'
}

const SUPPLY_CHART_COLORS: Record<string, string> = {
  on_hand_bar: '#8fb5c7',
  customer_orders: '#208663',
  forecast: '#2aae81',
  confirmed_po: '#3b7386',
  suggested_po: '#6aaac0',
  proj_inv: '#7a90a4',
}

function SupplyTooltip({ active, payload, label, fmt }: TooltipProps<number, string> & { fmt: (v: number) => string }) {
  if (!active || !payload?.length) return null
  const entries = payload.filter(p => p.value != null && Number(p.value) !== 0)
  if (!entries.length) return null
  return (
    <div style={{ background: 'rgba(0,0,0,0.8)', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(16px)' }} className="rounded-xl shadow-2xl px-3.5 py-2.5 min-w-[160px]">
      <p className="text-[10px] uppercase tracking-widest mb-2" style={{ color: 'rgba(255,255,255,0.4)' }}>{label}</p>
      {entries.map((p, i) => (
        <div key={i} className="flex items-center justify-between gap-4 text-xs mb-1 last:mb-0">
          <span className="flex items-center gap-1.5" style={{ color: 'rgba(255,255,255,0.6)' }}>
            <span className="w-1.5 h-1.5 rounded-full inline-block shrink-0" style={{ background: SUPPLY_CHART_COLORS[p.dataKey as string] ?? p.color }} />
            {p.name}
          </span>
          <span className="font-semibold" style={{ color: 'rgba(255,255,255,0.95)' }}>{fmt(p.value as number)}</span>
        </div>
      ))}
    </div>
  )
}

// ── component ──────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [skuPivot, setSkuPivot] = useState<PivotData | null>(null)
  const [monthlyPivot, setMonthlyPivot] = useState<PivotData | null>(null)
  const [loading, setLoading] = useState(true)
  const [kpis, setKpis] = useState<Kpis | null>(null)
  const [mrpPivot, setMrpPivot] = useState<MrpPivotData | null>(null)
  const [inventory, setInventory] = useState<InventoryRow[]>([])
  const [viewUnit, setViewUnit] = useState<'qty' | 'currency'>('currency')

  // ── sidebar: qty / currency toggle ──────────────────────────────────────

  useSidebarActionsEffect(
    <div className="flex flex-col gap-1">
      <p className="text-[9px] font-bold uppercase tracking-widest text-white/70 mb-2">View</p>
      <div className="flex gap-1 rounded-lg bg-white/[0.04] p-0.5">
        <button
          onClick={() => setViewUnit('qty')}
          className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${viewUnit === 'qty' ? 'bg-brand-600 text-white' : 'text-white/60 hover:text-white'}`}
        >
          Qty
        </button>
        <button
          onClick={() => setViewUnit('currency')}
          className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${viewUnit === 'currency' ? 'bg-brand-600 text-white' : 'text-white/60 hover:text-white'}`}
        >
          Currency
        </button>
      </div>
    </div>,
    [viewUnit],
  )

  useEffect(() => {
    getForecastRuns().then(runs => {
      const runId = runs[0]?.run_id
      const wParams: Record<string, string> = { granularity: 'week', group_by: 'sku' }
      const mParams: Record<string, string> = { granularity: 'month', group_by: 'sku' }
      if (runId) { wParams.forecast_run_id = runId; mParams.forecast_run_id = runId }
      Promise.all([
        getDemandPivot(wParams),
        getDemandPivot(mParams),
      ]).then(([w, m]) => { setSkuPivot(w); setMonthlyPivot(m) }).finally(() => setLoading(false))
    }).catch(() => {
      Promise.all([
        getDemandPivot({ granularity: 'week', group_by: 'sku' }),
        getDemandPivot({ granularity: 'month', group_by: 'sku' }),
      ]).then(([w, m]) => { setSkuPivot(w); setMonthlyPivot(m) }).finally(() => setLoading(false))
    })
  }, [])

  useEffect(() => {
    Promise.all([getKpis(), getMrpPivot(12), getInventory()]).then(([k, p, inv]) => {
      setKpis(k)
      setMrpPivot(p)
      setInventory(inv)
    }).catch(() => {})
  }, [])


  // ── formatters ──────────────────────────────────────────────────────────

  const leftFmt  = viewUnit === 'currency' ? fmtCurrency : fmtNumber  // left col = sales price
  const rightFmt = viewUnit === 'currency' ? fmtCurrency : fmtNumber  // right col = cost price

  // ── period windows ──────────────────────────────────────────────────────

  const mtdSalesPeriods = useMemo(() => skuPivot ? filterPeriods(skuPivot.periods, 'mtd', false) : [], [skuPivot])
  const mtdFcstPeriods  = useMemo(() => skuPivot ? filterPeriods(skuPivot.periods, 'mtd', true)  : [], [skuPivot])

  // ── card 1: MTD sold vs forecast ────────────────────────────────────────

  const stats = useMemo(() => {
    if (!skuPivot) return null
    const uc = viewUnit === 'currency'
    const sales = skuPivot.rows.reduce((s, r) => s + sumOverPeriods(r, mtdSalesPeriods, 'a') * (uc ? ((r.selling_price as number) || 0) : 1), 0)
    // MTD forecast = full-month forecast × (day_of_month / days_in_month)
    // e.g. March 27: forecast_mtd = full_march_forecast / 31 * 27
    let forecast = 0
    if (monthlyPivot) {
      const now = new Date()
      const curMonthPeriod = monthlyPivot.periods.find(p => {
        const d = new Date(p.date)
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
      })
      if (curMonthPeriod) {
        let fullMonthForecast = 0
        for (const row of monthlyPivot.rows) {
          const sp = uc ? ((row.selling_price as number) || 0) : 1
          const f = row[`f_${curMonthPeriod.key}`] as number | undefined
          if (f != null) fullMonthForecast += f * sp
        }
        const dayOfMonth = now.getDate()
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
        forecast = fullMonthForecast / daysInMonth * dayOfMonth
      }
    }
    return { sales, forecast, delta: forecast - sales }
  }, [skuPivot, monthlyPivot, mtdSalesPeriods, viewUnit])

  const mtdChartData = useMemo(() => {
    if (!stats) return []
    return [
      { label: 'Sold', value: stats.sales },
      { label: 'Forecast', value: stats.forecast },
    ]
  }, [stats])

  // ── card 2: top 5 products by MTD sales ────────────────────────────────

  const top5 = useMemo(() => {
    if (!skuPivot) return []
    const uc = viewUnit === 'currency'
    return skuPivot.rows
      .map(r => {
        const sp = uc ? ((r.selling_price as number) || 0) : 1
        return {
          sku: r.sku,
          description: r.description as string,
          sales:    sumOverPeriods(r, mtdSalesPeriods, 'a') * sp,
          forecast: sumOverPeriods(r, mtdFcstPeriods,  'f') * sp,
        }
      })
      .sort((a, b) => b.sales - a.sales)
      .slice(0, 5)
  }, [skuPivot, mtdSalesPeriods, mtdFcstPeriods, viewUnit])

  // ── aggregate forecast chart (monthly, matching DemandPlanning) ─────────

  const aggregateChartData = useMemo(() => {
    if (!monthlyPivot) return []
    const uc = viewUnit === 'currency'
    const now = new Date()
    const mtdWeeklyPeriods = skuPivot ? filterPeriods(skuPivot.periods, 'mtd', false) : []
    return monthlyPivot.periods.map(period => {
      let actual = 0, forecast = 0, lower = 0, upper = 0
      let hasActual = false, hasForecast = false
      for (const row of monthlyPivot.rows) {
        const sp = uc ? ((row.selling_price as number) || 0) : 1
        const a = row[`a_${period.key}`] as number | undefined
        const f = row[`f_${period.key}`] as number | undefined
        const fl = row[`fl_${period.key}`] as number | undefined
        const fu = row[`fu_${period.key}`] as number | undefined
        if (a != null) { actual += a * sp; hasActual = true }
        if (f != null) { forecast += f * sp; hasForecast = true }
        if (fl != null) lower += fl * sp
        if (fu != null) upper += fu * sp
      }
      // Inject current month MTD actuals from weekly pivot when backend has no a_ for current month
      if (!hasActual && skuPivot && mtdWeeklyPeriods.length > 0) {
        const d = new Date(period.date)
        if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) {
          let mtdActual = 0
          for (const row of skuPivot.rows) {
            const sp = uc ? ((row.selling_price as number) || 0) : 1
            mtdActual += sumOverPeriods(row, mtdWeeklyPeriods, 'a') * sp
          }
          if (mtdActual > 0) { actual = mtdActual; hasActual = true }
        }
      }
      return {
        label: period.label,
        actual: hasActual ? actual : undefined,
        forecast: hasForecast ? forecast : undefined,
        lower: hasForecast ? lower : undefined,
        upper: hasForecast ? upper : undefined,
      }
    })
  }, [monthlyPivot, skuPivot, viewUnit])

  // ── table rows: MTD, by SKU ─────────────────────────────────────────────

  const tableRows = useMemo((): TableRow[] => {
    if (!skuPivot) return []
    const uc = viewUnit === 'currency'
    const salesP = filterPeriods(skuPivot.periods, 'mtd', false)
    const fcstP  = filterPeriods(skuPivot.periods, 'mtd', true)
    return skuPivot.rows
      .map(r => {
        const sp = uc ? ((r.selling_price as number) || 0) : 1
        const sales    = sumOverPeriods(r, salesP, 'a') * sp
        const forecast = sumOverPeriods(r, fcstP,  'f') * sp
        return { sku: r.sku, description: r.description as string, sales, forecast, error: forecast - sales }
      })
      .sort((a, b) => b.sales - a.sales)
  }, [skuPivot, viewUnit])

  // ── ag-grid column defs ─────────────────────────────────────────────────

  const colDefs = useMemo((): ColDef<TableRow>[] => {
    const numFmt = (p: { value: number }) => leftFmt(p.value)
    const errorCellStyle = (params: { value: number }) => ({
      color: params.value > 0 ? '#f97316' : '#34d399',
      textAlign: 'right' as const,
      fontSize: 12,
    })
    return [
      {
        field: 'sku', headerName: 'SKU', pinned: 'left', width: 100,
        cellStyle: { fontFamily: 'monospace', fontSize: 11, color: 'rgba(255,255,255,0.9)' },
      },
      {
        field: 'description', headerName: 'Description', pinned: 'left', width: 200,
        cellStyle: { fontSize: 12 },
      },
      {
        field: 'sales', headerName: 'Sales', width: 110, type: 'numericColumn',
        valueFormatter: numFmt,
        cellStyle: { color: '#93c5fd', textAlign: 'right', fontSize: 12 },
      },
      {
        field: 'forecast', headerName: 'Forecast', width: 110, type: 'numericColumn',
        valueFormatter: numFmt,
        cellStyle: { color: '#c4b5fd', textAlign: 'right', fontSize: 12 },
      },
      {
        field: 'error', headerName: 'Forecast Error', width: 130, type: 'numericColumn',
        valueFormatter: numFmt,
        cellStyle: errorCellStyle,
        headerTooltip: 'Forecast − Sales',
      },
    ]
  }, [viewUnit]) // eslint-disable-line react-hooks/exhaustive-deps

  const defaultColDef = useMemo<ColDef>(() => ({ sortable: true, resizable: true }), [])

  const onFirstDataRendered = useCallback((e: FirstDataRenderedEvent) => {
    e.api.autoSizeAllColumns()
  }, [])

  const getRowId = useCallback((p: { data: TableRow }) => p.data.sku, [])

  // ── right column: supply chart data (all items) — all rows use unit_cost ──

  const supplyChartData = useMemo(() => {
    if (!mrpPivot) return []
    const uc = viewUnit === 'currency'
    let totalOnHand = 0
    for (const row of mrpPivot.rows) {
      if (row.row_type === 'on_hand') {
        const cp = uc ? ((row.unit_cost as number) || 0) : 1
        totalOnHand += (Number(row.on_hand_today) || 0) * cp
      }
    }
    return [
      { label: 'On Hand', on_hand_bar: totalOnHand, customer_orders: 0, forecast: 0, confirmed_po: 0, suggested_po: 0, proj_inv: totalOnHand },
      ...mrpPivot.periods.map(p => {
        let customer_orders = 0, forecast = 0, confirmed_po = 0, suggested_po = 0, proj_inv = 0
        const productIds = [...new Set(mrpPivot.rows.map(r => r.product_id))]
        for (const pid of productIds) {
          const rows = mrpPivot.rows.filter(r => r.product_id === pid)
          const byType = Object.fromEntries(rows.map(r => [r.row_type, r])) as Record<string, MrpRow>
          const cp = uc ? ((byType.on_hand?.unit_cost as number) || 0) : 1
          customer_orders += (Number(byType.customer_orders?.[p.key] ?? 0) || 0) * cp
          forecast        += (Number(byType.forecast?.[p.key]        ?? 0) || 0) * cp
          confirmed_po    += (Number(byType.confirmed_po?.[p.key]    ?? 0) || 0) * cp
          suggested_po    += (Number(byType.suggested_po?.[p.key]    ?? 0) || 0) * cp
          proj_inv        += (Number(byType.ending_inv?.[p.key]      ?? 0) || 0) * cp
        }
        return { label: p.label, on_hand_bar: 0, customer_orders, forecast, confirmed_po, suggested_po, proj_inv }
      }),
    ]
  }, [mrpPivot, viewUnit])

  // ── right column: projected inventory in ~8 weeks (2 months) ──────────

  const projectedInventory2m = useMemo(() => {
    if (!mrpPivot || !mrpPivot.periods.length) return null
    const targetMs = Date.now() + 56 * 24 * 60 * 60 * 1000
    let closestPeriod = mrpPivot.periods[0]
    let closestDiff = Infinity
    for (const p of mrpPivot.periods) {
      const diff = Math.abs(new Date(p.date).getTime() - targetMs)
      if (diff < closestDiff) { closestDiff = diff; closestPeriod = p }
    }
    const periodKey = closestPeriod.key
    const uc = viewUnit === 'currency'
    let total = 0
    const productIds = [...new Set(mrpPivot.rows.map(r => r.product_id))]
    for (const pid of productIds) {
      const onHandRow = mrpPivot.rows.find(r => r.product_id === pid && r.row_type === 'on_hand')
      const endRow    = mrpPivot.rows.find(r => r.product_id === pid && r.row_type === 'ending_inv')
      if (!endRow) continue
      const mult = uc ? ((onHandRow?.unit_cost as number | null) ?? 0) : 1
      total += (Number(endRow[periodKey] ?? 0) || 0) * mult
    }
    return total
  }, [mrpPivot, viewUnit])

  // ── right column: today's total on-hand (qty mode) ─────────────────────

  const totalQohToday = useMemo(() => inventory.reduce((s, r) => s + r.quantity_on_hand, 0), [inventory])

  // ── right column: aggregate health limits ──────────────────────────────

  const { lowerLimit, upperLimit } = useMemo(() => {
    if (!mrpPivot) return { lowerLimit: null, upperLimit: null }
    const uc = viewUnit === 'currency'
    const ht = (() => { try { const s = localStorage.getItem('inventory_health_thresholds'); return s ? JSON.parse(s) : {} } catch { return {} } })()
    const lowerMult: number = ht.lower ?? 1
    const upperMult: number = ht.upper ?? 4
    const minWks: number = ht.min_weeks_cover ?? 0
    let totalLower = 0, totalUpper = 0, hasSs = false
    for (const row of mrpPivot.rows) {
      if (row.row_type !== 'on_hand') continue
      const rawSs = row.safety_stock as number | null
      if (!rawSs) continue
      const avgW = (row.avg_weekly_demand as number | null) ?? 0
      const ss = minWks > 0 ? Math.max(rawSs, minWks * avgW) : rawSs
      const cp = uc ? ((row.unit_cost as number) || 0) : 1
      totalLower += ss * lowerMult * cp
      totalUpper += ss * upperMult * cp
      hasSs = true
    }
    return hasSs ? { lowerLimit: totalLower, upperLimit: totalUpper } : { lowerLimit: null, upperLimit: null }
  }, [mrpPivot, viewUnit])

  // ── right column: risk tables + status counts (mrpPivot-based classification) ──
  // 1. Stockout        — on_hand = 0
  // 2. Proj. Stockout  — projected inv within lead-time <= 0
  // 3. Below SS        — projected inv within lead-time <= SS
  // 4. Excess          — projected inv exceeds MAX at any MRP period
  // 5. Healthy         — otherwise

  const { atRiskItems, excessItems, riskCounts } = useMemo(() => {
    const empty = {
      atRiskItems: [] as RiskItem[],
      excessItems: [] as RiskItem[],
      riskCounts: { stockout: 0, projected_stockout: 0, below_ss: 0, healthy: 0, excess: 0 },
    }
    if (!mrpPivot) return empty
    const ht = (() => { try { const s = localStorage.getItem('inventory_health_thresholds'); return s ? JSON.parse(s) : {} } catch { return {} } })()
    const upperMult: number = ht.upper ?? 4
    const minWks: number    = ht.min_weeks_cover ?? 0
    const atRisk: RiskItem[] = []
    const excess: RiskItem[] = []
    const counts = { stockout: 0, projected_stockout: 0, below_ss: 0, healthy: 0, excess: 0 }
    const productIds = [...new Set(mrpPivot.rows.map(r => r.product_id))]
    for (const pid of productIds) {
      const onHandRow = mrpPivot.rows.find(r => r.product_id === pid && r.row_type === 'on_hand')
      const endRow    = mrpPivot.rows.find(r => r.product_id === pid && r.row_type === 'ending_inv')
      if (!endRow || !onHandRow) continue
      const baseSs    = (onHandRow.safety_stock as number) || 0
      const avgWeekly = (onHandRow.avg_weekly_demand as number) || 0
      const ss        = minWks > 0 ? Math.max(baseSs, minWks * avgWeekly) : baseSs
      const onHandQty = Number(onHandRow.on_hand_today) || 0
      const unitCost  = (onHandRow.unit_cost as number) || 0
      const daysSupply = avgWeekly > 0 ? Math.round((onHandQty / avgWeekly) * 7) : 0
      const sku         = onHandRow.sku as string
      const description = onHandRow.description as string
      const upperTarget = ss * upperMult
      // Lead-time window + 1 week buffer to allow reaction time
      const ltDays   = Number(onHandRow.lead_time_days) || 0
      const ltWeeks  = Math.max(1, Math.round(ltDays / 7)) + 1
      const ltPeriods = mrpPivot.periods.slice(0, ltWeeks)
      const valsWithinLT = ltPeriods.map(p => Number(endRow[p.key] ?? 0))
      const minValWithinLT = Math.min(...valsWithinLT)
      // All periods
      const allVals   = mrpPivot.periods.map(p => Number(endRow[p.key] ?? 0))
      const maxValAll = Math.max(...allVals)

      if (onHandQty === 0) {
        counts.stockout++
        atRisk.push({ sku, description, onHand: onHandQty, unitCost, daysSupply, lowerTarget: ss, upperTarget, riskType: 'stockout' })
      } else if (minValWithinLT <= 0) {
        counts.projected_stockout++
        atRisk.push({ sku, description, onHand: onHandQty, unitCost, daysSupply, lowerTarget: ss, upperTarget, riskType: 'projected_stockout' })
      } else if (minValWithinLT <= ss) {
        counts.below_ss++
      } else if (ss > 0 && maxValAll > upperTarget) {
        counts.excess++
        excess.push({ sku, description, onHand: onHandQty, unitCost, daysSupply, lowerTarget: ss, upperTarget, riskType: 'excess' })
      } else {
        counts.healthy++
      }
    }
    return { atRiskItems: atRisk, excessItems: excess, riskCounts: counts }
  }, [mrpPivot])

  // ── derived labels ─────────────────────────────────────────────────────

  const uc = viewUnit === 'currency'
  const leftColLabel = uc ? 'All Items — Aggregate Revenue' : 'All Items — Aggregate Quantity'
  const invTodayLabel = uc ? fmtCurrency(kpis?.inventory_value) : fmtNumber(totalQohToday)
  const invProjLabel  = projectedInventory2m != null
    ? (uc ? fmtCurrency(projectedInventory2m) : fmtNumber(projectedInventory2m))
    : '—'
  const invTodayNum   = uc ? (kpis?.inventory_value ?? 0) : totalQohToday

  // ── render ──────────────────────────────────────────────────────────────

  if (loading) return <Spinner className="h-64" />

  return (
    <div>
      <PageHeader
        title="Executive Dashboard"
        description="Operations Performance Management & Outlook"
      />

      {/* Column headers */}
      <div className="grid grid-cols-2 gap-6 mb-3 mt-6">
        <p className="text-[13px] font-bold uppercase tracking-widest text-white/50">Sales & Forecast</p>
        <p className="text-[13px] font-bold uppercase tracking-widest text-white/50">Inventory & Stockout Risks</p>
      </div>

      {/* grid-cols-2: each adjacent pair shares a CSS grid row → heights auto-align */}
      <div className="grid grid-cols-2 gap-6">

        {/* ══ ROW 1 ══════════════════════════════════════════════════════ */}

        {/* Left Row 1: Sold vs Forecast + Top 5 */}
        <div className="grid grid-cols-5 gap-4">

          {/* Card 1: Sold vs Forecast MTD — column chart */}
          <Card className="col-span-3 overflow-hidden flex flex-col" style={{ padding: 0 }}>
            <p className="text-[10px] font-medium uppercase tracking-widest text-white/50 px-5 pt-4 pb-0">Sold vs Forecast — MTD</p>
            <ResponsiveContainer width="100%" height={225}>
              <BarChart data={mtdChartData} margin={{ top: 28, right: 40, bottom: 16, left: 40 }} barCategoryGap="22%">
                <XAxis dataKey="label" tick={{ fontSize: 13, fill: 'rgba(255,255,255,0.5)', fontWeight: 500 }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.12)' }} />
                <YAxis hide />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                  contentStyle={{ background: 'rgba(0,0,0,0.72)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 13 }}
                  labelStyle={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase' }}
                  itemStyle={{ color: 'rgba(255,255,255,0.85)' }}
                  formatter={(v: number) => leftFmt(v)}
                />
                <Bar dataKey="value" radius={[4, 4, 0, 0]} label={{ position: 'top', fontSize: 13, fill: 'rgba(255,255,255,0.6)', formatter: (v: number) => leftFmt(v) }}>
                  <Cell fill="#10b981" />
                  <Cell fill="#6ee7b7" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* Card 2: Top 5 products MTD */}
          <Card className="col-span-2" style={{ padding: 0 }}>
            <div className="px-5 pt-4 pb-5">
            <p className="text-[10px] font-medium uppercase tracking-widest text-white/50 mb-3">Top 5 Products — MTD</p>
            <div className="flex flex-col divide-y divide-white/[0.06]">
              {top5.map((p, i) => (
                <div key={p.sku} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                  <span className="text-[10px] text-white/25 w-3 shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] font-mono text-white/50 leading-none mb-0.5">{p.sku}</p>
                    <p className="text-xs text-white truncate leading-tight">{p.description}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[9px] text-white/30 leading-none mb-0.5">Sales</p>
                    <p className="text-[11px] text-blue-300 font-medium">{leftFmt(p.sales)}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[9px] text-white/30 leading-none mb-0.5">Fcst</p>
                    <p className="text-[11px] text-purple-300">{leftFmt(p.forecast)}</p>
                  </div>
                </div>
              ))}
            </div>
            </div>
          </Card>
        </div>

        {/* Right Row 1: inventory value + inventory status */}
        <div className="grid grid-cols-2 gap-4">

          {/* Inventory value: today + projected 2 months */}
          <Card className="overflow-hidden flex flex-col" style={{ padding: 0 }}>
            <div className="px-5 pt-4 pb-3 border-b border-white/[0.07]">
              <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">Inventory {uc ? 'Value' : 'Qty'}</p>
            </div>
            <div className="flex flex-col divide-y divide-white/[0.06] flex-1">
              <div className="px-5 py-4 flex flex-col gap-0.5">
                <p className="text-[10px] font-medium uppercase tracking-widest text-white/35">Today</p>
                <p className="text-[22px] font-semibold text-white leading-tight tabular-nums">{invTodayLabel}</p>
              </div>
              <div className="px-5 py-4 flex flex-col gap-0.5 flex-1">
                <p className="text-[10px] font-medium uppercase tracking-widest text-white/35">In 2 Months (proj.)</p>
                <p className="text-[22px] font-semibold text-white leading-tight tabular-nums">{invProjLabel}</p>
                {projectedInventory2m != null && invTodayNum > 0 ? (
                  <p className={`text-[11px] mt-1 font-semibold tabular-nums ${projectedInventory2m >= invTodayNum ? 'text-emerald-400' : 'text-red-400'}`}>
                    {projectedInventory2m >= invTodayNum ? '▲' : '▼'} {rightFmt(Math.abs(projectedInventory2m - invTodayNum))} vs today
                  </p>
                ) : null}
              </div>
            </div>
          </Card>

          {/* Inventory status */}
          <Card className="overflow-hidden flex flex-col" style={{ padding: 0 }}>
            <div className="px-5 pt-4 pb-3 border-b border-white/[0.07]">
              <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">Inventory Status</p>
            </div>
            <div className="flex flex-col divide-y divide-white/[0.06] flex-1">
              {([
                { label: 'Stockout',       value: riskCounts.stockout,           color: '#f87171' },
                { label: 'Proj. Stockout', value: riskCounts.projected_stockout, color: '#fb923c' },
                { label: 'Below SS',       value: riskCounts.below_ss,           color: '#fbbf24' },
                { label: 'Healthy',        value: riskCounts.healthy,            color: '#34d399' },
                { label: 'Excess',         value: riskCounts.excess,             color: '#a1a1aa' },
              ] as { label: string; value: number; color: string }[]).map(({ label, value, color }) => (
                <div key={label} className="px-5 flex items-center justify-between flex-1 min-h-0 py-3">
                  <div className="flex items-center gap-2.5">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
                    <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color }}>{label}</span>
                  </div>
                  <span className="text-xl font-bold text-white tabular-nums">{value}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* ══ ROW 2 ══════════════════════════════════════════════════════ */}

        {/* Left Row 2: Aggregate forecast chart */}
        <Card>
          <CardHeader>
            <CardTitle>{leftColLabel}</CardTitle>
          </CardHeader>
          <div className="px-5 pb-4">
            <ForecastChart data={aggregateChartData} valueFormatter={uc ? fmtCurrency : undefined} />
          </div>
        </Card>

        {/* Right Row 2: Supply planning chart — all items aggregate */}
        <Card className="p-5">
          <p className="text-[10px] font-medium uppercase tracking-widest text-white/40 mb-0.5">Inventory Projection</p>
          <p className="text-sm font-semibold text-white mb-4">All Items — Aggregate {uc ? 'Cost Value' : 'Quantity'}</p>
          {supplyChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart data={supplyChartData} margin={{ top: 8, right: 32, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="dashOnHandGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#8fb5c7" stopOpacity={0.85} />
                    <stop offset="100%" stopColor="#7aa3b8" stopOpacity={0.75} />
                  </linearGradient>
                  <linearGradient id="dashCustOrdGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#208663" stopOpacity={0.95} />
                    <stop offset="100%" stopColor="#1a7055" stopOpacity={0.85} />
                  </linearGradient>
                  <linearGradient id="dashForecastGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#2aae81" stopOpacity={0.85} />
                    <stop offset="100%" stopColor="#239970" stopOpacity={0.75} />
                  </linearGradient>
                  <linearGradient id="dashConfPoGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3b7386" stopOpacity={0.95} />
                    <stop offset="100%" stopColor="#2e5c6b" stopOpacity={0.85} />
                  </linearGradient>
                  <linearGradient id="dashSuggPoGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#6aaac0" stopOpacity={0.85} />
                    <stop offset="100%" stopColor="#5a96ac" stopOpacity={0.75} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.4)', fontWeight: 500 }} tickLine={false} axisLine={false} interval="preserveStartEnd" dy={8} />
                <YAxis tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.4)', fontWeight: 500 }} tickLine={false} axisLine={false} width={uc ? 72 : 45} tickFormatter={v => rightFmt(v)} />
                <Tooltip content={<SupplyTooltip fmt={rightFmt} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Legend content={() => (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: '10px', paddingTop: 12, fontSize: 10, letterSpacing: '0.05em', fontWeight: 500 }}>
                    {([
                      { label: 'On Hand', color: '#8fb5c7', type: 'bar' },
                      { label: 'Cust. Orders', color: '#208663', type: 'bar' },
                      { label: 'Forecast', color: '#2aae81', type: 'bar' },
                      { label: 'Conf. PO', color: '#3b7386', type: 'bar' },
                      { label: 'Sugg. PO', color: '#6aaac0', type: 'bar' },
                      { label: 'Proj. Inv', color: '#7a90a4', type: 'line' },
                    ] as { label: string; color: string; type: 'bar' | 'line' }[]).map(({ label, color, type }) => (
                      <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'rgba(255,255,255,0.8)' }}>
                        {type === 'bar' ? (
                          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                        ) : (
                          <svg width="16" height="8" style={{ display: 'inline-block', flexShrink: 0 }}>
                            <line x1="0" y1="4" x2="16" y2="4" stroke={color} strokeWidth="1.5" strokeDasharray="4 2" />
                            <circle cx="8" cy="4" r="2" fill="none" stroke={color} strokeWidth="1.5" />
                          </svg>
                        )}
                        {label}
                      </span>
                    ))}
                  </div>
                )} />
                <Bar dataKey="on_hand_bar" name="On Hand" fill="url(#dashOnHandGrad)" radius={[2,2,0,0]} barSize={8} />
                <Bar dataKey="customer_orders" name="Customer Orders" fill="url(#dashCustOrdGrad)" radius={[1,1,0,0]} barSize={8} stackId="demand" />
                <Bar dataKey="forecast" name="Forecast" fill="url(#dashForecastGrad)" radius={[1,1,0,0]} barSize={8} stackId="demand" />
                <Bar dataKey="confirmed_po" name="Confirmed PO" fill="url(#dashConfPoGrad)" radius={[2,2,0,0]} barSize={8} stackId="conf" />
                <Bar dataKey="suggested_po" name="Suggested PO" fill="url(#dashSuggPoGrad)" radius={[2,2,0,0]} barSize={8} stackId="sugg" />
                <Line dataKey="proj_inv" name="Proj. Inventory" stroke="#9ab4c8" strokeWidth={1} strokeDasharray="5 3" type="monotone" dot={false} activeDot={{ r: 3, fill: '#9ab4c8' }} />
                {lowerLimit != null && lowerLimit > 0 && (
                  <ReferenceLine y={lowerLimit} stroke="rgba(180,70,70,0.65)" strokeDasharray="4 4" strokeWidth={1}
                    label={{ content: (p: any) => { const rx = (p.viewBox?.x ?? 0) + (p.viewBox?.width ?? 0) + 4; const ry = p.viewBox?.y ?? 0; return (<g><text x={rx} y={ry - 2} fontSize={9} fill="rgba(180,70,70,0.85)" fontWeight={600}>Min</text><text x={rx} y={ry + 9} fontSize={10} fill="rgba(180,70,70,0.7)">{rightFmt(lowerLimit)}</text></g>) } }}
                  />
                )}
                {upperLimit != null && upperLimit > 0 && (
                  <ReferenceLine y={upperLimit} stroke="rgba(180,70,70,0.65)" strokeDasharray="4 4" strokeWidth={1}
                    label={{ content: (p: any) => { const rx = (p.viewBox?.x ?? 0) + (p.viewBox?.width ?? 0) + 4; const ry = p.viewBox?.y ?? 0; return (<g><text x={rx} y={ry - 2} fontSize={9} fill="rgba(180,70,70,0.85)" fontWeight={600}>Max</text><text x={rx} y={ry + 9} fontSize={10} fill="rgba(180,70,70,0.7)">{rightFmt(upperLimit)}</text></g>) } }}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-[11px] text-white/30 text-center py-12">No MRP data — run MRP first</p>
          )}
        </Card>

        {/* ══ ROW 3 ══════════════════════════════════════════════════════ */}

        {/* Left Row 3: SKU summary table */}
        <Card className="p-0 overflow-hidden">
          <div className="px-5 py-3 border-b border-white/10">
            <p className="text-[10px] font-medium uppercase tracking-widest text-white/50">SKU Summary — MTD</p>
          </div>
          <div className="ag-theme-alpine" style={{ height: 360 }}>
            <AgGridReact<TableRow>
              rowData={tableRows}
              columnDefs={colDefs}
              defaultColDef={defaultColDef}
              onFirstDataRendered={onFirstDataRendered}
              getRowId={getRowId}
              enableCellTextSelection
              suppressMovableColumns
              animateRows={false}
            />
          </div>
        </Card>

        {/* Right Row 3: Stockout + Excess tables */}
        <div className="grid grid-cols-2 gap-4">

          {/* At-risk items: Stockout + Projected Stockout */}
          <Card className="p-0 overflow-hidden">
            <div style={{ minWidth: 0 }}>
              {/* Sticky header table */}
              <table className="w-full text-white border-collapse" style={{ tableLayout: 'fixed', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid rgba(255,255,255,0.15)' }}>
                    <th colSpan={3} style={{ padding: '0 16px', height: 44 }}>
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                        <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.5)' }}>At Risk</span>
                        <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: '#f87171' }}>{atRiskItems.length}</span>
                      </div>
                    </th>
                  </tr>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    <th style={{ width: '38%', padding: '6px 16px', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.3)', textAlign: 'left' }}>SKU</th>
                    <th style={{ padding: '6px 8px', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.3)', textAlign: 'right' }}>SS Target</th>
                    <th style={{ width: '30%', padding: '6px 16px', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.3)', textAlign: 'right' }}>{uc ? 'Value' : 'QoH'}</th>
                  </tr>
                </thead>
              </table>
              {/* Scrollable body */}
              <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                {atRiskItems.length === 0 ? (
                  <p className="text-[11px] text-white/30 text-center py-8">No at-risk items</p>
                ) : (
                  <table className="w-full text-white border-collapse" style={{ tableLayout: 'fixed', fontSize: 13 }}>
                    <colgroup>
                      <col style={{ width: '38%' }} />
                      <col />
                      <col style={{ width: '30%' }} />
                    </colgroup>
                    <tbody>
                      {atRiskItems.map((item: RiskItem) => {
                        const dotColor = item.riskType === 'stockout' ? '#f87171' : '#fb923c'
                        const labelColor = item.riskType === 'stockout' ? '#f87171' : '#fb923c'
                        return (
                        <tr key={item.sku} style={{ height: 44, borderBottom: '1px solid rgba(255,255,255,0.05)' }} className="hover:bg-white/[0.03]">
                          <td style={{ padding: '0 16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            <div className="flex items-center gap-1.5">
                              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dotColor }} />
                              <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>{item.sku}</span>
                            </div>
                          </td>
                          <td style={{ padding: '0 8px', fontSize: 12, textAlign: 'right', color: labelColor }}>{uc ? rightFmt(item.lowerTarget * item.unitCost) : fmtNumber(item.lowerTarget)}</td>
                          <td style={{ padding: '0 16px', fontSize: 12, textAlign: 'right', color: 'rgba(255,255,255,0.7)', fontWeight: 600 }}>{uc ? rightFmt(item.onHand * item.unitCost) : fmtNumber(item.onHand)}</td>
                        </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </Card>

          {/* Excess items */}
          <Card className="p-0 overflow-hidden">
            <div style={{ minWidth: 0 }}>
              {/* Sticky header table */}
              <table className="w-full text-white border-collapse" style={{ tableLayout: 'fixed', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid rgba(255,255,255,0.15)' }}>
                    <th colSpan={3} style={{ padding: '0 16px', height: 44 }}>
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-zinc-400 shrink-0" />
                        <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.5)' }}>Excess</span>
                        <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.6)' }}>{excessItems.length}</span>
                      </div>
                    </th>
                  </tr>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    <th style={{ width: '38%', padding: '6px 16px', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.3)', textAlign: 'left' }}>SKU</th>
                    <th style={{ padding: '6px 8px', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.3)', textAlign: 'right' }}>Max Target</th>
                    <th style={{ width: '30%', padding: '6px 16px', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.3)', textAlign: 'right' }}>{uc ? 'Value' : 'QoH'}</th>
                  </tr>
                </thead>
              </table>
              {/* Scrollable body */}
              <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                {excessItems.length === 0 ? (
                  <p className="text-[11px] text-white/30 text-center py-8">No excess items</p>
                ) : (
                  <table className="w-full text-white border-collapse" style={{ tableLayout: 'fixed', fontSize: 13 }}>
                    <colgroup>
                      <col style={{ width: '38%' }} />
                      <col />
                      <col style={{ width: '30%' }} />
                    </colgroup>
                    <tbody>
                      {excessItems.map(item => (
                        <tr key={item.sku} style={{ height: 44, borderBottom: '1px solid rgba(255,255,255,0.05)' }} className="hover:bg-white/[0.03]">
                          <td style={{ padding: '0 16px', fontFamily: 'monospace', fontSize: 11, color: 'rgba(255,255,255,0.6)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.sku}</td>
                          <td style={{ padding: '0 8px', fontSize: 12, textAlign: 'right', color: 'rgba(212,212,216,0.7)' }}>{uc ? rightFmt(item.upperTarget * item.unitCost) : fmtNumber(item.upperTarget)}</td>
                          <td style={{ padding: '0 16px', fontSize: 12, textAlign: 'right', color: 'rgba(255,255,255,0.7)', fontWeight: 600 }}>{uc ? rightFmt(item.onHand * item.unitCost) : fmtNumber(item.onHand)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </Card>

        </div>

      </div>
    </div>
  )
}
