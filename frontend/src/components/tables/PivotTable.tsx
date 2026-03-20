import { useMemo, useCallback, createElement } from 'react'
import { AgGridReact } from 'ag-grid-react'
import { ColDef, ColGroupDef, GridReadyEvent, CellValueChangedEvent, FirstDataRenderedEvent, ICellRendererParams } from 'ag-grid-community'
import 'ag-grid-community/styles/ag-grid.css'
import 'ag-grid-community/styles/ag-theme-alpine.css'
import type { PivotData, PivotRow } from '../../api/types'
import { fmtNumber } from '../../utils/formatters'
import { abcCellRenderer } from './cellRenderers'

const MODEL_OPTIONS = ['AUTO', 'SMA', 'WMA', 'HOLT_WINTERS', 'ARIMA']

interface Props {
  data: PivotData
  onRowClick?: (row: PivotRow) => void
  onRowDoubleClick?: (row: PivotRow) => void
  onCellEdit?: (forecastId: number, productId: number, periodKey: string, value: number) => void
  onModelChange?: (productId: number, model: string) => void
  showForecast?: boolean
  mode?: 'sku' | 'customer'
}


export function PivotTable({ data, onRowClick, onRowDoubleClick, onCellEdit, onModelChange, showForecast = true, mode = 'sku' }: Props) {
  const { periods, rows } = data
  const isCustomerMode = mode === 'customer'

  const columnDefs = useMemo((): (ColDef | ColGroupDef)[] => {
    const staticCols: ColDef[] = [
      {
        field: 'sku', headerName: 'SKU', pinned: 'left', lockPosition: 'left', lockPinned: true, width: 90,
        cellStyle: { fontFamily: 'monospace', fontSize: 11, color: 'rgba(255,255,255,0.9)' },
      },
      {
        field: 'description', headerName: 'Description', pinned: 'left', lockPosition: 'left', lockPinned: true, width: 200,
        tooltipField: 'description',
        cellStyle: { fontSize: 12 },
      },
      {
        field: 'abc_class', headerName: 'ABC', pinned: 'left', lockPosition: 'left', lockPinned: true, width: 58,
        cellRenderer: abcCellRenderer,
      },
      // Customer mode: show customer column; SKU mode: show supplier + forecast model
      ...(isCustomerMode ? [
        {
          field: 'customer', headerName: 'Customer', pinned: 'left', lockPosition: 'left', lockPinned: true, width: 160,
          cellStyle: { fontSize: 11, color: '#60a5fa', fontWeight: 500 },
        } as ColDef,
      ] : [
        {
          field: 'supplier', headerName: 'Supplier', pinned: 'left', lockPosition: 'left', lockPinned: true, width: 130,
          cellStyle: { fontSize: 11, color: 'rgba(255,255,255,0.75)' },
        } as ColDef,
        {
          field: 'forecast_model',
          headerName: 'Model',
          pinned: 'left',
          lockPosition: 'left',
          lockPinned: true,
          width: 130,
          cellRenderer: (params: ICellRendererParams) => {
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
      ]),
    ]

    // Build column defs and group them, splitting at the actual→forecast transition
    // so the "Forecast" header appears exactly at the first forecast column.
    const groups: { isFuture: boolean; children: ColDef[] }[] = []

    for (const period of periods) {
      const fieldKey = period.is_future ? `f_${period.key}` : `a_${period.key}`
      const isEditable = period.is_future && !isCustomerMode

      const colDef: ColDef = {
        field: fieldKey,
        headerName: period.label,
        width: 78,
        editable: isEditable,
        type: 'numericColumn',
        valueFormatter: params => {
          const v = params.value
          if (v == null || v === '') return '—'
          return fmtNumber(Number(v))
        },
        cellStyle: (params): Record<string, string | number> => {
          if (!period.is_future) {
            return { color: '#93c5fd', background: 'transparent', fontSize: 12, textAlign: 'right' }
          }
          const isAdjusted = params.data[`fa_${period.key}`]
          if (isAdjusted) {
            return { color: '#fcd34d', background: 'rgba(251,191,36,0.15)', fontWeight: '600', fontSize: 12, textAlign: 'right' }
          }
          return { color: '#c4b5fd', background: 'rgba(167,139,250,0.1)', fontSize: 12, textAlign: 'right' }
        },
        headerClass: period.is_future ? 'forecast-header' : 'actual-header',
      }

      // Start a new group whenever the actual/forecast status changes
      const lastGroup = groups[groups.length - 1]
      if (!lastGroup || lastGroup.isFuture !== period.is_future) {
        groups.push({ isFuture: period.is_future, children: [colDef] })
      } else {
        lastGroup.children.push(colDef)
      }
    }

    const groupedCols: ColGroupDef[] = groups.map((group) => ({
      headerName: group.isFuture ? (isCustomerMode ? `▶ Customer Forecast` : `▶ Forecast`) : `Actuals`,
      headerClass: group.isFuture ? 'pivot-header-forecast' : 'pivot-header-actual',
      children: group.children,
      marryChildren: false,
      openByDefault: true,
    }))

    return [...staticCols, ...groupedCols]
  }, [periods, onModelChange])

  const defaultColDef = useMemo<ColDef>(() => ({
    sortable: true,
    resizable: true,
    suppressSizeToFit: false,
  }), [])

  const onCellValueChanged = useCallback((e: CellValueChangedEvent) => {
    if (!onCellEdit) return
    const field = e.colDef.field || ''
    if (!field.startsWith('f_')) return
    const periodKey = field.substring(2)
    const value = Number(e.newValue)
    if (isNaN(value)) return

    const forecastId = e.data[`fid_${periodKey}`] as number | undefined
    if (!forecastId) return

    // Immediately mark cell as adjusted in local row data so it turns yellow without reload
    e.data[`fa_${periodKey}`] = true
    e.api.refreshCells({ rowNodes: [e.node!], columns: [field], force: true })

    onCellEdit(forecastId, e.data.product_id, periodKey, value)
  }, [onCellEdit])

  const onRowClicked = useCallback((e: { data: PivotRow }) => {
    onRowClick?.(e.data)
  }, [onRowClick])

  const onRowDoubleClicked = useCallback((e: { data: PivotRow }) => {
    onRowDoubleClick?.(e.data)
  }, [onRowDoubleClick])

  const onFirstDataRendered = useCallback((e: FirstDataRenderedEvent) => {
    e.api.autoSizeAllColumns()
  }, [])

  return (
    <div className="ag-theme-alpine w-full" style={{ height: 420 }}>
      <AgGridReact
        rowData={rows}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        onRowClicked={onRowClicked}
        onRowDoubleClicked={onRowDoubleClicked}
        onCellValueChanged={onCellValueChanged}
        onFirstDataRendered={onFirstDataRendered}
        rowSelection="single"
        enableCellTextSelection
        suppressMovableColumns={true}
        animateRows={false}
        tooltipShowDelay={300}
      />
    </div>
  )
}
