import { useState } from 'react'
import type { ICellRendererParams } from 'ag-grid-community'
import { updateProduct } from '../../api'

const ABC_OPTIONS = ['A', 'B', 'C', 'NPI', 'Phase Out']

const ABC_COLORS: Record<string, { bg: string; color: string }> = {
  A: { bg: 'rgba(5,150,105,0.15)', color: '#6ee7b7' },
  B: { bg: 'rgba(217,119,6,0.15)', color: '#fcd34d' },
  C: { bg: 'rgba(82,82,91,0.15)', color: 'rgba(255,255,255,0.5)' },
  NPI: { bg: 'rgba(99,102,241,0.2)', color: '#a5b4fc' },
  'Phase Out': { bg: 'rgba(239,68,68,0.15)', color: '#fca5a5' },
}

export function AbcSelectCell(p: ICellRendererParams) {
  const [current, setCurrent] = useState<string>(p.value ?? '')
  const c = current ? ABC_COLORS[current] : null
  const productId = (p.data as Record<string, unknown>)?.product_id as number

  const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value
    setCurrent(next)
    await updateProduct(productId, { abc_class: next })
    p.api?.refreshCells({ rowNodes: [p.node!], columns: ['abc_class'], force: true })
  }

  return (
    <select
      value={current}
      onChange={handleChange}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      style={{
        background: c?.bg ?? 'transparent',
        color: c?.color ?? 'rgba(255,255,255,0.4)',
        border: 'none',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        padding: '1px 4px',
        cursor: 'pointer',
        width: '100%',
        outline: 'none',
      }}
    >
      <option value="">—</option>
      {ABC_OPTIONS.map(opt => (
        <option key={opt} value={opt} style={{ background: '#1e1e2e', color: 'white' }}>
          {opt}
        </option>
      ))}
    </select>
  )
}
