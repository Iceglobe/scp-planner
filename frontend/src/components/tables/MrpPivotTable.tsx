import React, { useMemo, useCallback, createElement, useRef, useState, useEffect } from 'react'
import { AgGridReact } from 'ag-grid-react'
import { ColDef, ColGroupDef, FirstDataRenderedEvent, RowClassParams, CellDoubleClickedEvent, CellClickedEvent, CellValueChangedEvent, GridReadyEvent, GridApi } from 'ag-grid-community'
import 'ag-grid-community/styles/ag-grid.css'
import 'ag-grid-community/styles/ag-theme-alpine.css'
import type { MrpPivotData, MrpRow } from '../../api/types'
import { abcCellRenderer } from './cellRenderers'
import { fmtCurrency } from '../../utils/formatters'

type RowType = MrpRow['row_type']

interface Props {
  data: MrpPivotData
  viewUnit?: 'qty' | 'currency'
  onCellDoubleClick?: (rowType: RowType, productId: number, periodKey: string) => void
  onProductDoubleClick?: (productId: number, sku: string, description: string) => void
  onPeriodClick?: (periodKey: string, periodLabel: string, periodDate: string) => void
  onSuggestedPoClick?: (poIds: number[], productId: number) => void
  onSuggestedPoEdit?: (productId: number, periodKey: string, newQty: number, poIds: number[]) => void
  maxHeight?: number
}

function getPrice(data: MrpRow, viewUnit: 'qty' | 'currency'): number {
  if (viewUnit !== 'currency') return 1
  return (data.unit_cost as number) || 0
}

const ROW_LABELS: Record<RowType, string> = {
  on_hand: 'Beginning Inventory',
  customer_orders: 'Confirmed Orders',
  forecast: 'Forecast',
  confirmed_po: 'Confirmed POs',
  suggested_po: 'Suggested PO (order week)',
  ending_inv: 'Proj. Inventory',
}

const ROW_COLORS: Record<RowType, string> = {
  on_hand: '#8fb5c7',
  customer_orders: '#208663',
  forecast: '#2aae81',
  confirmed_po: '#3b7386',
  suggested_po: '#6aaac0',
  ending_inv: '#7a90a4',
}

const ROW_BG: Record<RowType, string> = {
  on_hand: 'rgba(255,255,255,0.06)',
  customer_orders: 'transparent',
  forecast: 'transparent',
  confirmed_po: 'transparent',
  suggested_po: 'transparent',
  ending_inv: 'rgba(148,163,184,0.06)',
}

// Which row types show value even when 0
const ALWAYS_SHOW: Set<RowType> = new Set(['on_hand', 'ending_inv'])

function fmtVal(v: unknown, rt: RowType, price: number, viewUnit: 'qty' | 'currency'): string {
  if (v == null || v === '') return '—'
  const n = Number(v)
  if (isNaN(n)) return '—'
  if (!ALWAYS_SHOW.has(rt) && n === 0) return '—'
  if (viewUnit === 'currency') return fmtCurrency(n * price)
  return String(Math.round(n))
}

function headerOnlyCell(p: { data: MrpRow; value: unknown }, render: (val: unknown) => ReturnType<typeof createElement> | null) {
  return p.data.row_type === 'on_hand' ? render(p.value) : null
}

type SortState = { field: string | null; dir: 'asc' | 'desc' }

function SortableHeader({ displayName, field, sortStateRef, onSort }: {
  displayName: string; field: string
  sortStateRef: React.MutableRefObject<SortState>
  onSort: (f: string) => void
}) {
  const active = sortStateRef.current.field === field
  const dir = sortStateRef.current.dir
  return (
    <div onClick={() => onSort(field)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', width: '100%', height: '100%' }}>
      <span>{displayName}</span>
      <span style={{ fontSize: 9, opacity: active ? 1 : 0.35 }}>
        {active ? (dir === 'asc' ? '▲' : '▼') : '⇅'}
      </span>
    </div>
  )
}

export function MrpPivotTable({ data, viewUnit = 'qty', onCellDoubleClick, onProductDoubleClick, onPeriodClick, onSuggestedPoClick, onSuggestedPoEdit, maxHeight }: Props) {
  const { periods, rows } = data
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const gridApiRef = useRef<GridApi | null>(null)
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  // Mutable ref so headers can read current sort without columnDefs being recreated
  const sortStateRef = useRef<SortState>({ field: null, dir: 'asc' })
  sortStateRef.current = { field: sortField, dir: sortDir }

  // Auto-size all columns whenever viewUnit changes (currency values need wider cols)
  useEffect(() => {
    const t = setTimeout(() => { gridApiRef.current?.autoSizeAllColumns() }, 50)
    return () => clearTimeout(t)
  }, [viewUnit])

  // Refresh headers when sort changes — without recreating columnDefs (avoids width reset)
  useEffect(() => {
    gridApiRef.current?.refreshHeader()
  }, [sortField, sortDir])

  const onGridReady = useCallback((e: GridReadyEvent) => {
    gridApiRef.current = e.api
  }, [])

  // Sort product groups by the on_hand row's value for the active sort field
  const sortedRows = useMemo(() => {
    if (!sortField) return rows
    const pidVals = rows
      .filter(r => r.row_type === 'on_hand')
      .map(r => ({ pid: r.product_id, val: (r as unknown as Record<string, unknown>)[sortField] ?? null }))
    pidVals.sort((a, b) => {
      if (a.val == null && b.val == null) return 0
      if (a.val == null) return 1
      if (b.val == null) return -1
      const av = typeof a.val === 'string' ? a.val.toLowerCase() : (a.val as number)
      const bv = typeof b.val === 'string' ? b.val.toLowerCase() : (b.val as number)
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return pidVals.flatMap(({ pid }) => rows.filter(r => r.product_id === pid))
  }, [rows, sortField, sortDir])

  const handleSortClick = useCallback((field: string) => {
    setSortField(prev => {
      if (prev === field) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); return prev }
      setSortDir('asc'); return field
    })
  }, [])

  const columnDefs = useMemo((): (ColDef | ColGroupDef)[] => {

    // ── Pinned static columns ──────────────────────────────────────────────
    const labelCol: ColDef = {
      field: 'label',
      headerName: 'Product / Metric',
      pinned: 'left',
      width: 200,
      cellRenderer: (p: { data: MrpRow }) => {
        const { row_type: rt, sku, description } = p.data
        if (rt === 'on_hand') {
          return createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            createElement('span', {
              style: { fontFamily: 'monospace', fontSize: 10, fontWeight: 700,
                background: 'rgba(96,165,250,0.2)', color: '#93c5fd', padding: '1px 5px', borderRadius: 3, flexShrink: 0 }
            }, sku),
            createElement('span', {
              style: { fontSize: 11, fontWeight: 600, color: '#ffffff', overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
            }, description),
          )
        }
        const clickable = rt === 'confirmed_po' || rt === 'customer_orders' || rt === 'suggested_po'
        return createElement('div', {
          style: { display: 'flex', alignItems: 'center', gap: 5, paddingLeft: 14,
            cursor: clickable ? 'pointer' : 'default' }
        },
          createElement('span', {
            style: { width: 6, height: 6, borderRadius: '50%', background: ROW_COLORS[rt],
              flexShrink: 0, display: 'inline-block' }
          }),
          createElement('span', {
            style: { fontSize: 11, color: 'rgba(255,255,255,0.7)',
              textDecoration: clickable ? 'underline dotted' : 'none' }
          }, ROW_LABELS[rt]),
        )
      },
    }

    const abcCol: ColDef = {
      field: 'abc_class',
      headerName: 'ABC',
      headerComponent: SortableHeader,
      headerComponentParams: { field: 'abc_class', sortStateRef, onSort: handleSortClick },
      pinned: 'left',
      width: 52,
      cellRenderer: (p: { data: MrpRow; value: string }) =>
        headerOnlyCell(p, v => v ? abcCellRenderer({ value: v as string }) : null),
    }

    const onHandCol: ColDef = {
      field: 'on_hand_today',
      headerName: 'On Hand',
      headerComponent: SortableHeader,
      headerComponentParams: { field: 'on_hand_today', sortStateRef, onSort: handleSortClick },
      pinned: 'left',
      width: 78,
      type: 'numericColumn',
      cellRenderer: (p: { data: MrpRow; value: number }) =>
        headerOnlyCell(p, v => {
          if (v == null) return createElement('span', { style: { fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.9)' } }, '—')
          const n = v as number
          const displayed = viewUnit === 'currency'
            ? fmtCurrency(n * ((p.data.unit_cost as number) || 0))
            : String(Math.round(n))
          return createElement('span', { style: { fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.9)' } }, displayed)
        }),
    }

    const leadTimeCol: ColDef = {
      field: 'lead_time_days',
      headerName: 'LT (d)',
      headerComponent: SortableHeader,
      headerComponentParams: { field: 'lead_time_days', sortStateRef, onSort: handleSortClick },
      pinned: 'left',
      width: 62,
      type: 'numericColumn',
      cellRenderer: (p: { data: MrpRow; value: number }) =>
        headerOnlyCell(p, v =>
          createElement('span', {
            style: { fontSize: 12, color: 'rgba(255,255,255,0.7)' }
          }, v != null ? `${v}d` : '—')
        ),
    }

    const ssCol: ColDef = {
      field: 'safety_stock',
      headerName: 'SS',
      headerComponent: SortableHeader,
      headerComponentParams: { field: 'safety_stock', sortStateRef, onSort: handleSortClick },
      pinned: 'left',
      width: 62,
      type: 'numericColumn',
      cellRenderer: (p: { data: MrpRow; value: number }) =>
        headerOnlyCell(p, v =>
          createElement('span', {
            style: { fontSize: 12, color: '#c4b5fd', fontWeight: 600 }
          }, v != null ? String(Math.round(v as number)) : '—')
        ),
    }

    const moqCol: ColDef = {
      field: 'moq',
      headerName: 'MOQ',
      headerComponent: SortableHeader,
      headerComponentParams: { field: 'moq', sortStateRef, onSort: handleSortClick },
      pinned: 'left',
      width: 62,
      type: 'numericColumn',
      cellRenderer: (p: { data: MrpRow; value: number }) =>
        headerOnlyCell(p, v =>
          createElement('span', {
            style: { fontSize: 12, color: 'rgba(255,255,255,0.7)' }
          }, v != null ? String(Math.round(v as number)) : '—')
        ),
    }

    const maxCapCol: ColDef = {
      field: 'max_weekly_capacity',
      headerName: 'Max Cap',
      headerComponent: SortableHeader,
      headerComponentParams: { field: 'max_weekly_capacity', sortStateRef, onSort: handleSortClick },
      headerTooltip: 'Max weekly capacity',
      pinned: 'left',
      width: 72,
      type: 'numericColumn',
      cellRenderer: (p: { data: MrpRow; value: number | null }) =>
        headerOnlyCell(p, v =>
          createElement('span', {
            style: { fontSize: 12, color: v != null ? '#fcd34d' : 'rgba(255,255,255,0.25)', fontWeight: v != null ? 600 : 400 }
          }, v != null ? String(Math.round(v as number)) : '∞')
        ),
    }

    // ── Period columns grouped by month ────────────────────────────────────
    const groupMap: Record<string, { label: string; children: ColDef[] }> = {}
    const groupOrder: string[] = []

    for (const period of periods) {
      const monthKey = period.key.substring(0, 7)
      if (!groupMap[monthKey]) {
        const d = new Date(period.date)
        groupMap[monthKey] = {
          label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
          children: [],
        }
        groupOrder.push(monthKey)
      }

      const colDef: ColDef = {
        field: period.key,
        headerName: period.label,
        width: 68,
        type: 'numericColumn',
        // suggested_po cells are editable in qty mode only
        editable: (p) => viewUnit === 'qty' && p.data?.row_type === 'suggested_po',
        singleClickEdit: false,
        valueSetter: (p) => {
          const n = Number(p.newValue)
          if (isNaN(n) || n < 0) return false
          p.data[p.colDef.field!] = n
          return true
        },
        valueFormatter: (p: { value: unknown; data: MrpRow }) => {
          const rt = p.data?.row_type
          return fmtVal(p.value, rt, getPrice(p.data, viewUnit), viewUnit)
        },
        cellStyle: (p: { value: unknown; data: MrpRow }): Record<string, string | number> => {
          const rt = p.data?.row_type
          const val = Number(p.value)
          const base: Record<string, string | number> = { fontSize: 12, textAlign: 'right', cursor: 'default' }

          if (rt === 'ending_inv') {
            const ss = (p.data?.safety_stock as number) || 0
            const rop = (p.data?.reorder_point as number) || 0
            if (val <= 0) return { ...base, color: '#f87171', fontWeight: 700 }
            if (val < ss) return { ...base, color: '#fb923c', fontWeight: 600 }
            if (val < rop * 1.5) return { ...base, color: '#4ade80', fontWeight: 600 }
            return { ...base, color: 'rgba(255,255,255,0.8)', fontWeight: 600 }
          }
          if (rt === 'on_hand') return { ...base, color: 'rgba(255,255,255,0.9)', fontWeight: 600 }
          if (rt === 'customer_orders') return val > 0
            ? { ...base, color: '#34c98e', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline dotted' }
            : { ...base, color: 'rgba(255,255,255,0.25)' }
          if (rt === 'forecast') return { ...base, color: ROW_COLORS.forecast }
          if (rt === 'confirmed_po') return val > 0
            ? { ...base, color: '#5aadc4', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline dotted' }
            : { ...base, color: 'rgba(255,255,255,0.25)' }
          if (rt === 'suggested_po') return val > 0
            ? { ...base, color: ROW_COLORS.suggested_po, fontWeight: 700, cursor: 'cell', textDecoration: 'underline dotted' }
            : { ...base, color: 'rgba(255,255,255,0.25)', cursor: 'cell' }
          return base
        },
        headerTooltip: period.date,
      }
      groupMap[monthKey].children.push(colDef)
    }

    const groupedCols: ColGroupDef[] = groupOrder.map(gk => ({
      headerName: groupMap[gk].label,
      children: groupMap[gk].children,
      marryChildren: false,
    }))

    return [labelCol, abcCol, onHandCol, leadTimeCol, ssCol, moqCol, maxCapCol, ...groupedCols]
  }, [periods, viewUnit])

  const defaultColDef = useMemo<ColDef>(() => ({
    sortable: false,
    resizable: true,
  }), [])

  const getRowStyle = useCallback((params: RowClassParams<MrpRow>) => {
    const rt = params.data?.row_type
    if (!rt) return {}
    const style: Record<string, string> = { background: ROW_BG[rt] }
    if (rt === 'on_hand') style.borderTop = '2px solid #cbd5e1'
    if (rt === 'ending_inv') style.borderBottom = '2px solid #cbd5e1'
    return style
  }, [])

  const getRowHeight = useCallback((params: { data?: MrpRow }) => {
    return params.data?.row_type === 'on_hand' ? 38 : 26
  }, [])

  const onFirstDataRendered = useCallback((e: FirstDataRenderedEvent) => {
    e.api.autoSizeAllColumns()
  }, [])

  const onCellClicked = useCallback((e: CellClickedEvent<MrpRow>) => {
    const rt = e.data?.row_type
    const val = Number(e.value)
    const field = e.colDef.field || ''

    if (rt === 'on_hand' && onProductDoubleClick) {
      onProductDoubleClick(e.data!.product_id, e.data!.sku ?? '', e.data!.description ?? '')
      return
    }

    if (rt === 'suggested_po') {
      // Zero cells: let double-click handle creation; single click does nothing
      if (!val || val === 0) return
      if (!onSuggestedPoClick) return
      // Delay 300ms so double-click can cancel and open editor instead
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
      const poIds = (e.data?.spo_ids as Record<string, number[]> | undefined)?.[field] ?? []
      const productId = e.data!.product_id
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null
        onSuggestedPoClick(poIds, productId)
      }, 300)
      return
    }

    if (rt !== 'confirmed_po' && rt !== 'customer_orders') return
    if (!onPeriodClick) return
    if (!val || val === 0) return
    const period = periods.find(p => p.key === field)
    if (period) onPeriodClick(period.key, period.label, period.date)
  }, [onPeriodClick, onSuggestedPoClick, periods])

  const onCellValueChanged = useCallback((e: CellValueChangedEvent<MrpRow>) => {
    if (e.data?.row_type !== 'suggested_po' || !onSuggestedPoEdit) return
    const periodKey = e.colDef.field || ''
    const newQty = Number(e.newValue)
    if (isNaN(newQty) || newQty < 0) return
    const poIds = e.data.spo_ids?.[periodKey] ?? []
    onSuggestedPoEdit(e.data.product_id, periodKey, newQty, poIds)
  }, [onSuggestedPoEdit])

  const onCellDoubleClicked = useCallback((e: CellDoubleClickedEvent<MrpRow>) => {
    // Cancel any pending single-click navigation so we can edit in place
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }

    const rt = e.data?.row_type
    // suggested_po: AG Grid handles inline editing on double-click
    if (rt === 'suggested_po') return
    if (!onCellDoubleClick) return
    if (rt !== 'confirmed_po' && rt !== 'customer_orders') return
    const val = Number(e.value)
    if (!val || val === 0) return
    onCellDoubleClick(rt, e.data!.product_id, e.colDef.field || '')
  }, [onCellDoubleClick, onProductDoubleClick])

  const height = Math.min(rows.length * 28 + 80, maxHeight ?? 720)

  return (
    <div className="ag-theme-alpine w-full" style={{ height }}>
      <AgGridReact
        rowData={sortedRows}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        getRowStyle={getRowStyle}
        getRowHeight={getRowHeight}
        getRowId={(params: { data: MrpRow }) => `${params.data.product_id}_${params.data.row_type}`}
        onGridReady={onGridReady}
        onFirstDataRendered={onFirstDataRendered}
        onCellClicked={onCellClicked}
        onCellDoubleClicked={onCellDoubleClicked}
        onCellValueChanged={onCellValueChanged}
        animateRows={false}
        suppressMovableColumns={true}
        headerHeight={36}
        groupHeaderHeight={28}
        tooltipShowDelay={300}
      />
    </div>
  )
}
