import { useMemo } from 'react'
import { AgGridReact } from 'ag-grid-react'
import { ColDef, RowClassRules, CellValueChangedEvent } from 'ag-grid-community'
import 'ag-grid-community/styles/ag-grid.css'
import 'ag-grid-community/styles/ag-theme-alpine.css'

interface Props {
  rowData: Record<string, unknown>[]
  columnDefs: ColDef[]
  height?: number
  onRowClick?: (row: Record<string, unknown>) => void
  onCellValueChanged?: (field: string, newValue: unknown, row: Record<string, unknown>) => void
  rowClassRules?: RowClassRules<Record<string, unknown>>
}

export function DataTable({ rowData, columnDefs, height = 400, onRowClick, onCellValueChanged, rowClassRules }: Props) {
  const defaultColDef = useMemo<ColDef>(() => ({
    sortable: true,
    resizable: true,
    filter: false,
  }), [])

  const handleCellValueChanged = (e: CellValueChangedEvent<Record<string, unknown>>) => {
    if (onCellValueChanged && e.colDef.field) {
      onCellValueChanged(e.colDef.field, e.newValue, e.data)
    }
  }

  return (
    <div className="ag-theme-alpine w-full" style={{ height }}>
      <AgGridReact
        rowData={rowData}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        autoSizeStrategy={{ type: 'fitCellContents' }}
        rowSelection="single"
        onRowClicked={e => onRowClick?.(e.data as Record<string, unknown>)}
        onCellValueChanged={handleCellValueChanged}
        rowClassRules={rowClassRules}
        animateRows={false}
        suppressCellFocus={false}
        stopEditingWhenCellsLoseFocus={true}
        singleClickEdit={true}
      />
    </div>
  )
}
