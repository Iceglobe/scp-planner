import { useMemo, useCallback, createElement, useState, useRef, useEffect } from 'react'
import { AgGridReact } from 'ag-grid-react'
import { ColDef, ColGroupDef, GridReadyEvent, CellValueChangedEvent, FirstDataRenderedEvent, ICellRendererParams, CellContextMenuEvent, ITooltipParams } from 'ag-grid-community'
import 'ag-grid-community/styles/ag-grid.css'
import 'ag-grid-community/styles/ag-theme-alpine.css'
import type { PivotData, PivotRow } from '../../api/types'
import { fmtNumber } from '../../utils/formatters'
import { abcCellRenderer } from './cellRenderers'

function NoteTooltip(params: ITooltipParams) {
  const note = params.value as string | undefined
  if (!note) return null
  return (
    <div style={{
      background: 'rgba(15, 20, 30, 0.85)',
      backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)',
      border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 10,
      padding: '10px 14px',
      maxWidth: 260,
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      pointerEvents: 'none',
    }}>
      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color: 'rgba(255,215,80,0.6)', textTransform: 'uppercase', margin: '0 0 6px 0' }}>
        Adjustment note
      </p>
      <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.88)', margin: 0, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
        {note}
      </p>
    </div>
  )
}

const MODEL_OPTIONS = ['AUTO', 'SMA', 'WMA', 'HOLT_WINTERS', 'ARIMA']

interface Props {
  data: PivotData
  customerData?: PivotData
  onRowClick?: (row: PivotRow) => void
  onRowDoubleClick?: (row: PivotRow) => void
  onCellEdit?: (forecastId: number, productId: number, periodKey: string, value: number) => void
  onCustomerCellEdit?: (productId: number, customer: string, yearMonth: string, qty: number) => void
  onNoteChange?: (forecastId: number, productId: number, periodKey: string, note: string | null) => void
  onCustomerNoteChange?: (productId: number, customer: string, yearMonth: string, note: string | null) => void
  onCellRevert?: (productId: number, periodKey: string) => void
  onCustomerCellRevert?: (productId: number, customer: string, periodKey: string) => void
  onModelChange?: (productId: number, model: string) => void
  onPriorityToggle?: (productId: number, customer: string) => void
  mapeByProduct?: Record<number, number | null>
  showForecast?: boolean
  mode?: 'sku' | 'customer'
}

interface NoteTarget {
  forecastId?: number
  customer?: string
  productId: number
  periodKey: string
  existingNote: string
}

// Extended row type used internally with drill-down metadata
interface GridRow extends Record<string, unknown> {
  _rowType: 'sku' | 'customer'
  _parentProductId?: number
}

export function PivotTable({ data, customerData, onRowClick, onRowDoubleClick, onCellEdit, onCustomerCellEdit, onNoteChange, onCustomerNoteChange, onCellRevert, onCustomerCellRevert, onModelChange, onPriorityToggle, mapeByProduct, showForecast = true, mode = 'sku' }: Props) {
  const { periods, rows } = data

  const [noteTarget, setNoteTarget] = useState<NoteTarget | null>(null)
  const [noteText, setNoteText] = useState('')
  const noteInputRef = useRef<HTMLTextAreaElement>(null)
  const gridRef = useRef<AgGridReact>(null)

  // Track expanded SKUs (by product_id)
  const [expandedSkus, setExpandedSkus] = useState<Set<number>>(new Set())
  const expandedSkusRef = useRef<Set<number>>(new Set())

  // Stabilize periods reference: only update when period keys/future flags actually change.
  // This prevents columnDefs from rebuilding (and horizontal scroll resetting) on silent data reloads.
  const lastPeriodsRef = useRef(periods)
  const stablePeriods = useMemo(() => {
    const prev = lastPeriodsRef.current
    if (
      prev.length === periods.length &&
      prev.every((p, i) => p.key === periods[i].key && p.is_future === periods[i].is_future)
    ) return prev
    lastPeriodsRef.current = periods
    return periods
  }, [periods])

  useEffect(() => {
    if (noteTarget) {
      setNoteText(noteTarget.existingNote)
      setTimeout(() => noteInputRef.current?.focus(), 50)
    }
  }, [noteTarget])

  const saveNote = useCallback((note: string | null) => {
    if (!noteTarget) return
    if (noteTarget.customer) {
      onCustomerNoteChange?.(noteTarget.productId, noteTarget.customer, noteTarget.periodKey, note)
    } else if (noteTarget.forecastId != null) {
      onNoteChange?.(noteTarget.forecastId, noteTarget.productId, noteTarget.periodKey, note)
    }
    setNoteTarget(null)
  }, [noteTarget, onNoteChange, onCustomerNoteChange])

  // Build customer rows map: product_id → customer rows
  const customerRowsMap = useMemo(() => {
    if (!customerData) return new Map<number, PivotRow[]>()
    const map = new Map<number, PivotRow[]>()
    for (const row of customerData.rows) {
      const pid = row.product_id as number
      if (!map.has(pid)) map.set(pid, [])
      map.get(pid)!.push(row)
    }
    return map
  }, [customerData])

  // Keep ref in sync for cell renderer access without rebuilding columnDefs
  const customerRowsMapRef = useRef(customerRowsMap)

  // Track which (product_id, periodKey) pairs have at least one adjusted customer row.
  // Stored as ref so SKU row cellStyle can read it without rebuilding columnDefs.
  const skuAdjustedMapRef = useRef(new Set<string>())
  useEffect(() => {
    const set = new Set<string>()
    if (customerData) {
      for (const row of customerData.rows) {
        const pid = row.product_id as number
        for (const [key, val] of Object.entries(row)) {
          if (key.startsWith('fa_') && val) {
            set.add(`${pid}-${key.substring(3)}`)
          }
        }
      }
    }
    skuAdjustedMapRef.current = set
    // Refresh SKU row cells so they pick up the new adjusted indicators
    setTimeout(() => gridRef.current?.api?.refreshCells({ force: true }), 0)
  }, [customerData])
  useEffect(() => { customerRowsMapRef.current = customerRowsMap }, [customerRowsMap])

  const toggleExpand = useCallback((productId: number) => {
    setExpandedSkus(prev => {
      const next = new Set(prev)
      if (next.has(productId)) next.delete(productId)
      else next.add(productId)
      expandedSkusRef.current = next
      // Refresh the customer column cells so the icon updates
      setTimeout(() => gridRef.current?.api?.refreshCells({ columns: ['_customer_expand'], force: true }), 0)
      return next
    })
  }, [])

  const toggleExpandRef = useRef(toggleExpand)
  useEffect(() => { toggleExpandRef.current = toggleExpand }, [toggleExpand])

  const mapeByProductRef = useRef(mapeByProduct ?? {})
  useEffect(() => {
    mapeByProductRef.current = mapeByProduct ?? {}
    setTimeout(() => gridRef.current?.api?.refreshCells({ columns: ['_mape'], force: true }), 0)
  }, [mapeByProduct])

  const onPriorityToggleRef = useRef(onPriorityToggle)
  useEffect(() => { onPriorityToggleRef.current = onPriorityToggle }, [onPriorityToggle])

  // prioritySetRef: "productId-customer" strings for quick lookup in cell renderer
  const prioritySetRef = useRef(new Set<string>())
  // prioritySkuIdsRef: product_ids that have at least one priority customer (for SKU row hint)
  const prioritySkuIdsRef = useRef(new Set<number>())
  useEffect(() => {
    const pairSet = new Set<string>()
    const skuSet = new Set<number>()
    if (customerData) {
      for (const row of customerData.rows) {
        if (row.is_priority) {
          const pid = row.product_id as number
          const cust = row.customer as string
          pairSet.add(`${pid}-${cust}`)
          skuSet.add(pid)
        }
      }
    }
    prioritySetRef.current = pairSet
    prioritySkuIdsRef.current = skuSet
    setTimeout(() => gridRef.current?.api?.refreshCells({ columns: ['_priority'], force: true }), 0)
  }, [customerData])

  // Flat row data: SKU rows interleaved with expanded customer sub-rows
  const flatRowData = useMemo((): GridRow[] => {
    const result: GridRow[] = []
    for (const row of rows) {
      result.push({ ...(row as Record<string, unknown>), _rowType: 'sku' })
      if (expandedSkus.has(row.product_id as number)) {
        const custRows = customerRowsMap.get(row.product_id as number) ?? []
        for (const cr of custRows) {
          result.push({ ...(cr as Record<string, unknown>), _rowType: 'customer', _parentProductId: row.product_id as number })
        }
      }
    }
    return result
  }, [rows, expandedSkus, customerRowsMap])

  const columnDefs = useMemo((): (ColDef | ColGroupDef)[] => {
    const hasCustomerData = customerRowsMapRef.current.size > 0

    // Customer / expand column — first column
    const customerExpandCol: ColDef = {
      field: '_customer_expand',
      headerName: 'Customer',
      pinned: 'left',
      lockPosition: 'left',
      lockPinned: true,
      width: 160,
      sortable: false,
      cellRenderer: (params: ICellRendererParams) => {
        const rowType = params.data._rowType as string
        if (rowType === 'customer') {
          return createElement('span', {
            style: { paddingLeft: 16, fontSize: 11, color: '#60a5fa', fontWeight: 500 },
          }, (params.data.customer as string) || '—')
        }
        // SKU row: show expand toggle if customer data exists for this product
        const productId = params.data.product_id as number
        const custCount = customerRowsMapRef.current.get(productId)?.length ?? 0
        if (!hasCustomerData || custCount === 0) return null
        const isExpanded = expandedSkusRef.current.has(productId)
        return createElement('button', {
          onClick: (e: MouseEvent) => { e.stopPropagation(); toggleExpandRef.current(productId) },
          title: isExpanded ? 'Collapse customers' : `Expand ${custCount} customer${custCount === 1 ? '' : 's'}`,
          style: {
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: '#60a5fa', fontSize: 11, padding: '0 4px',
            display: 'flex', alignItems: 'center', gap: 4,
          },
        },
          createElement('span', { style: { fontSize: 10, lineHeight: 1 } }, isExpanded ? '▼' : '▶'),
          createElement('span', {}, `${custCount} customer${custCount === 1 ? '' : 's'}`)
        )
      },
      cellStyle: (params: any): Record<string, string | number> => {
        if (params.data._rowType === 'customer') {
          return { background: 'rgba(96,165,250,0.06)', borderLeft: '2px solid rgba(96,165,250,0.3)' }
        }
        return {}
      },
    }

    const staticCols: ColDef[] = [
      customerExpandCol,
      {
        field: 'sku', headerName: 'SKU', pinned: 'left', lockPosition: 'left', lockPinned: true, width: 90,
        cellStyle: { fontFamily: 'monospace', fontSize: 11, color: 'rgba(255,255,255,0.9)' },
      },
      {
        field: 'description', headerName: 'Description', pinned: 'left', lockPosition: 'left', lockPinned: true, width: 200,
        cellStyle: { fontSize: 12 },
      },
      {
        field: 'abc_class', headerName: 'ABC', pinned: 'left', lockPosition: 'left', lockPinned: true, width: 58,
        cellRenderer: abcCellRenderer,
      },
      {
        field: 'forecast_model',
        headerName: 'Model',
        pinned: 'left',
        lockPosition: 'left',
        lockPinned: true,
        width: 130,
        cellRenderer: (params: ICellRendererParams) => {
          // Only show model selector on SKU rows
          if (params.data._rowType === 'customer') return null
          const current = (params.value as string) ?? 'AUTO'
          const productId = params.data?.product_id as number
          const select = createElement('select', {
            value: current,
            style: {
              fontSize: 11, fontWeight: 600, color: '#60a5fa',
              border: 'none', background: 'transparent', cursor: 'pointer', width: '100%',
              outline: 'none',
            },
            onClick: (e: MouseEvent) => e.stopPropagation(),
            onChange: (e: Event) => {
              const val = (e.target as HTMLSelectElement).value
              onModelChange?.(productId, val)
            },
          }, ...MODEL_OPTIONS.map(m =>
            createElement('option', { key: m, value: m }, m === 'HOLT_WINTERS' ? 'Holt-Winters' : m)
          ))
          return select
        },
      } as ColDef,
      {
        field: '_mape',
        headerName: 'MAPE',
        pinned: 'left',
        lockPosition: 'left',
        lockPinned: true,
        width: 66,
        sortable: false,
        cellRenderer: (params: ICellRendererParams) => {
          if (params.data._rowType === 'customer') return null
          const pid = params.data.product_id as number
          const mape = mapeByProductRef.current[pid]
          if (mape == null) return createElement('span', { style: { color: 'rgba(255,255,255,0.2)', fontSize: 11 } }, '—')
          const color = mape < 15 ? '#34d399' : mape < 30 ? '#fbbf24' : '#f87171'
          return createElement('span', { style: { fontSize: 11, fontWeight: 600, color } }, `${mape.toFixed(0)}%`)
        },
      } as ColDef,
      {
        field: '_priority',
        headerName: '★',
        pinned: 'left',
        lockPosition: 'left',
        lockPinned: true,
        width: 36,
        sortable: false,
        cellRenderer: (params: ICellRendererParams) => {
          const rowType = params.data._rowType as string
          if (rowType === 'customer') {
            const productId = params.data._parentProductId as number
            const customer = params.data.customer as string
            const isPriority = prioritySetRef.current.has(`${productId}-${customer}`)
            return createElement('button', {
              onClick: (e: MouseEvent) => { e.stopPropagation(); onPriorityToggleRef.current?.(productId, customer) },
              title: isPriority ? 'Remove priority' : 'Mark as priority',
              style: {
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: isPriority ? '#fbbf24' : 'rgba(255,255,255,0.18)',
                fontSize: 14, padding: 0, lineHeight: 1, display: 'block', width: '100%', textAlign: 'center',
              },
            }, '★')
          }
          // SKU row: show dim star hint if any customer of this product is priority
          const productId = params.data.product_id as number
          if (prioritySkuIdsRef.current.has(productId)) {
            return createElement('span', {
              title: 'Has priority customer',
              style: { color: 'rgba(251,191,36,0.35)', fontSize: 11, display: 'block', textAlign: 'center' },
            }, '★')
          }
          return null
        },
        cellStyle: (params: any): Record<string, string | number> => {
          if (params.data._rowType === 'customer') {
            return { background: 'rgba(96,165,250,0.06)', borderLeft: '2px solid rgba(96,165,250,0.3)', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }
          }
          return { padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }
        },
      } as ColDef,
    ]

    // Build column defs and group them, splitting at the actual→forecast transition
    const groups: { isFuture: boolean; children: ColDef[] }[] = []

    for (const period of stablePeriods) {
      const fieldKey = period.is_future ? `f_${period.key}` : `a_${period.key}`
      // Cells are editable only on customer sub-rows (future periods only)
      const isEditable = period.is_future && !!onCustomerCellEdit

      const colDef: ColDef = {
        field: fieldKey,
        headerName: period.label,
        width: 78,
        editable: isEditable ? (params: any) => params.data._rowType === 'customer' : false,
        type: 'numericColumn',
        valueFormatter: params => {
          const v = params.value
          if (v == null || v === '') return '—'
          return fmtNumber(Number(v))
        },
        cellStyle: (params): Record<string, string | number> => {
          const isCustomerRow = params.data._rowType === 'customer'
          if (!period.is_future) {
            return {
              color: '#93c5fd', fontSize: 12, textAlign: 'right',
              ...(isCustomerRow ? { background: 'rgba(96,165,250,0.06)' } : { background: 'transparent' }),
            }
          }
          if (isCustomerRow) {
            const isAdjusted = params.data[`fa_${period.key}`]
            if (isAdjusted) {
              return { color: '#fcd34d', background: 'rgba(245,158,11,0.10)', fontSize: 12, textAlign: 'right', cursor: 'cell', fontWeight: '600' }
            }
            return { color: '#c4b5fd', background: 'rgba(167,139,250,0.12)', fontSize: 12, textAlign: 'right', cursor: 'cell' }
          }
          // SKU aggregate row — show soft yellow tint if any customer sub-row is adjusted
          const anyAdjusted = skuAdjustedMapRef.current.has(`${params.data.product_id}-${period.key}`)
          if (anyAdjusted) {
            return { color: '#fcd34d', background: 'rgba(245,158,11,0.10)', fontSize: 12, fontWeight: '600', textAlign: 'right', cursor: 'default' }
          }
          return { color: '#c4b5fd', background: 'transparent', fontSize: 12, fontWeight: '600', textAlign: 'right', cursor: 'default' }
        },
        headerClass: period.is_future ? 'forecast-header' : 'actual-header',
        tooltipValueGetter: period.is_future
          ? (params) => (params.data[`fn_${period.key}`] as string | undefined) || null
          : undefined,
        tooltipComponent: period.is_future ? NoteTooltip : undefined,
      }

      const lastGroup = groups[groups.length - 1]
      if (!lastGroup || lastGroup.isFuture !== period.is_future) {
        groups.push({ isFuture: period.is_future, children: [colDef] })
      } else {
        lastGroup.children.push(colDef)
      }
    }

    const groupedCols: ColGroupDef[] = groups.map((group) => ({
      headerName: group.isFuture ? `▶ Forecast` : `Actuals`,
      headerClass: group.isFuture ? 'pivot-header-forecast' : 'pivot-header-actual',
      children: group.children,
      marryChildren: false,
      openByDefault: true,
    }))

    return [...staticCols, ...groupedCols]
  }, [stablePeriods, onModelChange, onCustomerCellEdit])

  const defaultColDef = useMemo<ColDef>(() => ({
    sortable: true,
    resizable: true,
    suppressSizeToFit: false,
  }), [])

  const onCellRevertRef = useRef(onCellRevert)
  const onCustomerCellRevertRef = useRef(onCustomerCellRevert)
  useEffect(() => { onCellRevertRef.current = onCellRevert }, [onCellRevert])
  useEffect(() => { onCustomerCellRevertRef.current = onCustomerCellRevert }, [onCustomerCellRevert])

  const onCellValueChanged = useCallback((e: CellValueChangedEvent) => {
    const field = e.colDef.field || ''
    if (!field.startsWith('f_')) return
    const periodKey = field.substring(2)
    const value = Number(e.newValue)

    // Empty/invalid input → revert to statistical forecast via backend, then reload
    if (e.newValue === '' || e.newValue == null || isNaN(value)) {
      // Clear the cell immediately (show —) while the async revert happens
      e.node?.setDataValue(field, null)
      e.api.refreshCells({ rowNodes: [e.node!], columns: [field], force: true })
      if (e.data._rowType === 'customer') {
        onCustomerCellRevertRef.current?.(e.data.product_id as number, e.data.customer as string, periodKey)
      } else {
        onCellRevertRef.current?.(e.data.product_id as number, periodKey)
      }
      return
    }

    if (e.data._rowType === 'customer' && onCustomerCellEdit) {
      // Customer-level edit: periodKey is already "YYYY-MM" for monthly data
      onCustomerCellEdit(
        e.data.product_id as number,
        e.data.customer as string,
        periodKey,
        value,
      )
      return
    }

    // Legacy SKU-level edit (kept for compatibility, cells not editable in normal flow)
    if (!onCellEdit) return
    const forecastId = e.data[`fid_${periodKey}`] as number | undefined
    if (!forecastId) return
    e.data[`fa_${periodKey}`] = true
    e.api.refreshCells({ rowNodes: [e.node!], columns: [field], force: true })
    onCellEdit(forecastId, e.data.product_id as number, periodKey, value)
  }, [onCellEdit, onCustomerCellEdit])

  const onCellContextMenu = useCallback((e: CellContextMenuEvent) => {
    const field = e.colDef.field || ''
    if (!field.startsWith('f_')) return
    const periodKey = field.substring(2)
    if (!e.data[`fa_${periodKey}`]) return
    if (e.event) (e.event as Event).preventDefault()

    if (e.data._rowType === 'customer' && onCustomerNoteChange) {
      setNoteTarget({
        customer: e.data.customer as string,
        productId: e.data.product_id as number,
        periodKey,
        existingNote: (e.data[`fn_${periodKey}`] as string) || '',
      })
      return
    }

    if (!onNoteChange) return
    const forecastId = e.data[`fid_${periodKey}`] as number | undefined
    if (!forecastId) return
    setNoteTarget({
      forecastId,
      productId: e.data.product_id as number,
      periodKey,
      existingNote: (e.data[`fn_${periodKey}`] as string) || '',
    })
  }, [onNoteChange, onCustomerNoteChange])

  const onRowClicked = useCallback((e: { data?: GridRow }) => {
    if (!e.data) return
    onRowClick?.(e.data as unknown as PivotRow)
  }, [onRowClick])

  const onRowDoubleClicked = useCallback((e: { data?: GridRow }) => {
    if (!e.data) return
    onRowDoubleClick?.(e.data as unknown as PivotRow)
  }, [onRowDoubleClick])

  const onFirstDataRendered = useCallback((e: FirstDataRenderedEvent) => {
    e.api.autoSizeAllColumns()
    const firstFuture = stablePeriods.find(p => p.is_future)
    if (firstFuture) {
      e.api.ensureColumnVisible(`f_${firstFuture.key}`, 'start')
    }
  }, [stablePeriods])

  const getRowId = useCallback((params: { data: GridRow }) => {
    if (params.data._rowType === 'customer') {
      return `cust-${params.data.product_id}-${params.data.customer}`
    }
    return `sku-${params.data.product_id}`
  }, [])

  const getRowStyle = useCallback((params: any) => {
    if (params.data?._rowType === 'customer') {
      return { background: 'rgba(96,165,250,0.04)' }
    }
    return undefined
  }, [])

  return (
    <div className="ag-theme-alpine w-full" style={{ height: 420, position: 'relative' }}>
      {noteTarget && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.45)', zIndex: 10,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: 'rgba(30,35,45,0.97)', border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 12, padding: '20px 24px', width: 320,
            backdropFilter: 'blur(20px)', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          }}>
            <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', marginBottom: 8 }}>
              Adjustment note
            </p>
            <textarea
              ref={noteInputRef}
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveNote(noteText.trim() || null) }
                if (e.key === 'Escape') setNoteTarget(null)
              }}
              placeholder="Why was this changed?"
              rows={3}
              style={{
                width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 8, color: 'rgba(255,255,255,0.9)', fontSize: 13, padding: '8px 10px',
                resize: 'none', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setNoteTarget(null)} style={{
                fontSize: 12, padding: '6px 14px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)',
                background: 'transparent', color: 'rgba(255,255,255,0.5)', cursor: 'pointer',
              }}>Cancel</button>
              <button onClick={() => saveNote(noteText.trim() || null)} style={{
                fontSize: 12, padding: '6px 14px', borderRadius: 6, border: 'none',
                background: '#16a34a', color: '#fff', cursor: 'pointer', fontWeight: 600,
              }}>Save</button>
            </div>
          </div>
        </div>
      )}
      <AgGridReact
        ref={gridRef}
        rowData={flatRowData}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        onRowClicked={onRowClicked}
        onRowDoubleClicked={onRowDoubleClicked}
        onCellValueChanged={onCellValueChanged}
        onCellContextMenu={onCellContextMenu}
        onFirstDataRendered={onFirstDataRendered}
        preventDefaultOnContextMenu={true}
        getRowId={getRowId}
        getRowStyle={getRowStyle}
        rowSelection="single"
        enableCellTextSelection
        suppressMovableColumns={true}
        animateRows={false}
        tooltipShowDelay={300}
      />
    </div>
  )
}
