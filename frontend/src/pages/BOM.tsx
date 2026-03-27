import { useEffect, useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Trash2, GitBranch } from 'lucide-react'
import { getBomTree, getProducts, addBomItem, updateBomItem, deleteBomItem, updateProduct, getFlows, getWorkstations } from '../api'
import type { BomTreeNode, Product, ProductionFlow, Workstation } from '../api/types'
import { Spinner } from '../components/ui'

// ── Flatten tree into ordered rows ────────────────────────────────────────────

interface FlatRow {
  product_id: number
  sku: string
  description: string
  unit_of_measure: string
  level: number
  bom_id?: number
  quantity_per?: number
  parent_product_id?: number
}

function flattenTree(nodes: BomTreeNode[], depth = 0, parentId?: number): FlatRow[] {
  const rows: FlatRow[] = []
  for (const n of nodes) {
    rows.push({
      product_id: n.product_id,
      sku: n.sku,
      description: n.description,
      unit_of_measure: n.unit_of_measure,
      level: depth,
      bom_id: n.bom_id,
      quantity_per: n.quantity_per,
      parent_product_id: parentId,
    })
    if (n.children.length > 0) rows.push(...flattenTree(n.children, depth + 1, n.product_id))
  }
  return rows
}

// ── Inline qty cell ───────────────────────────────────────────────────────────

function QtyCell({ value, bomId, onSaved }: { value: number; bomId: number; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(value))

  const commit = async () => {
    const q = parseFloat(draft)
    setEditing(false)
    if (!q || q <= 0 || q === value) { setDraft(String(value)); return }
    await updateBomItem(bomId, q)
    onSaved()
  }

  if (editing)
    return (
      <input
        autoFocus
        type="number" min="0.001" step="any"
        className="w-20 bg-white/[0.1] border border-brand-400 rounded px-1.5 py-0.5 text-sm text-white text-right outline-none"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setEditing(false); setDraft(String(value)) } }}
      />
    )

  return (
    <button
      className="w-20 text-right text-sm font-medium text-white hover:bg-white/[0.1] rounded px-1.5 py-0.5 cursor-text transition-colors"
      onClick={() => setEditing(true)}
      title="Click to edit"
    >
      {value}
    </button>
  )
}

// ── Unit of measure ───────────────────────────────────────────────────────────

const UOM_OPTIONS = ['EA', 'pcs', 'kg', 'g', 'mg', 'L', 'mL', 'm', 'cm', 'mm', 'oz', 'lb', 'box', 'pack', 'roll', 'set']

function UomCell({ value, productId, onSaved }: { value: string; productId: number; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)

  const commit = async (newVal: string) => {
    setEditing(false)
    if (newVal === value) return
    await updateProduct(productId, { unit_of_measure: newVal })
    onSaved()
  }

  if (editing)
    return (
      <select
        autoFocus
        className="bg-zinc-800 border border-brand-400 rounded px-1.5 py-0.5 text-xs text-white outline-none cursor-pointer"
        defaultValue={value}
        onChange={e => commit(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') setEditing(false) }}
        onBlur={() => setEditing(false)}
      >
        {UOM_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
      </select>
    )

  return (
    <button
      className="text-xs font-mono text-white/40 hover:text-white hover:bg-white/[0.08] rounded px-1.5 py-0.5 transition-colors cursor-text"
      onClick={() => setEditing(true)}
      title="Click to edit unit"
    >
      {value}
    </button>
  )
}

// ── Production flow cell (level-0 only) ──────────────────────────────────────

function ProductionFlowCell({ value, productId, flows, onSaved }: {
  value: number | null
  productId: number
  flows: ProductionFlow[]
  onSaved: () => void
}) {
  const [editing, setEditing] = useState(false)

  const commit = async (newVal: string) => {
    setEditing(false)
    const newId = newVal === '' ? null : parseInt(newVal, 10)
    if (newId === value) return
    await updateProduct(productId, { production_flow_id: newId })
    onSaved()
  }

  const flowName = flows.find(f => f.id === value)?.name

  if (editing)
    return (
      <select
        autoFocus
        className="bg-zinc-800 border border-brand-400 rounded px-1.5 py-0.5 text-xs text-white outline-none cursor-pointer max-w-[160px]"
        defaultValue={value ?? ''}
        onChange={e => commit(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') setEditing(false) }}
        onBlur={() => setEditing(false)}
      >
        <option value="">— none —</option>
        {flows.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
    )

  return (
    <button
      className="text-xs font-mono text-white/40 hover:text-white hover:bg-white/[0.08] rounded px-1.5 py-0.5 transition-colors cursor-text max-w-[160px] truncate"
      onClick={() => setEditing(true)}
      title="Click to assign production flow"
    >
      {flowName ?? '—'}
    </button>
  )
}

// ── Workstation cell (BOM parents only) ──────────────────────────────────────

function WorkstationCell({ value, productId, workstations, onSaved }: {
  value: number | null
  productId: number
  workstations: Workstation[]
  onSaved: () => void
}) {
  const [editing, setEditing] = useState(false)

  const commit = async (newVal: string) => {
    setEditing(false)
    const newId = newVal === '' ? null : parseInt(newVal, 10)
    if (newId === value) return
    await updateProduct(productId, { workstation_id: newId })
    onSaved()
  }

  const wsName = workstations.find(w => w.id === value)?.name

  if (editing)
    return (
      <select
        autoFocus
        className="bg-zinc-800 border border-brand-400 rounded px-1.5 py-0.5 text-xs text-white outline-none cursor-pointer max-w-[140px]"
        defaultValue={value ?? ''}
        onChange={e => commit(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') setEditing(false) }}
        onBlur={() => setEditing(false)}
      >
        <option value="">— none —</option>
        {workstations.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
      </select>
    )

  return (
    <button
      className="text-xs font-mono text-white/40 hover:text-white hover:bg-white/[0.08] rounded px-1.5 py-0.5 transition-colors cursor-text max-w-[140px] truncate"
      onClick={() => setEditing(true)}
      title="Click to assign workstation"
    >
      {wsName ?? '—'}
    </button>
  )
}

// ── Searchable product input ──────────────────────────────────────────────────

function ProductSearch({
  value, onChange, products, placeholder, autoFocus, onKeyDown, tabIndex,
}: {
  value: Product | null
  onChange: (p: Product | null) => void
  products: Product[]
  placeholder: string
  autoFocus?: boolean
  onKeyDown?: (e: React.KeyboardEvent) => void
  tabIndex?: number
}) {
  const [query, setQuery] = useState('')
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const open = anchorRect !== null

  // Close on outside click
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setAnchorRect(null)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const openDropdown = () => {
    if (inputRef.current) setAnchorRect(inputRef.current.getBoundingClientRect())
  }

  // position: absolute relative to #dropdown-portal (which sits at body top:0 left:0)
  // getBoundingClientRect() is viewport-relative; add scrollY/scrollX for document coords
  const dropdownStyle: React.CSSProperties = anchorRect ? {
    position: 'absolute',
    top: anchorRect.bottom + window.scrollY + 4,
    left: anchorRect.left + window.scrollX,
    width: Math.max(anchorRect.width, 288),
    pointerEvents: 'auto',
  } : {}

  const filtered = products.filter(
    p => p.sku.toLowerCase().includes(query.toLowerCase()) ||
         p.description.toLowerCase().includes(query.toLowerCase())
  ).slice(0, 8)

  if (value)
    return (
      <div className="flex items-center gap-1.5 bg-white/[0.07] rounded px-2 py-1 min-w-0">
        <span className="font-mono text-xs text-brand-300 flex-shrink-0">{value.sku}</span>
        <span className="text-xs text-white/50 truncate">{value.description}</span>
        <button className="text-white/30 hover:text-white ml-auto flex-shrink-0 text-base leading-none" onClick={() => { onChange(null); setQuery('') }}>×</button>
      </div>
    )

  return (
    <div ref={wrapperRef} className="relative min-w-0">
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        tabIndex={tabIndex}
        className="w-full bg-transparent border border-white/20 focus:border-brand-400 rounded px-2 py-1 text-sm text-white placeholder-white/30 outline-none"
        placeholder={placeholder}
        value={query}
        onChange={e => { setQuery(e.target.value); openDropdown() }}
        onFocus={() => openDropdown()}
        onKeyDown={e => {
          if (e.key === 'Enter' && open && filtered.length === 1) {
            e.preventDefault()
            onChange(filtered[0]); setAnchorRect(null); setQuery('')
          } else {
            onKeyDown?.(e)
          }
        }}
      />
      {open && filtered.length > 0 && createPortal(
        <div style={dropdownStyle} className="bg-zinc-900 border border-white/20 rounded-xl shadow-2xl py-1">
          {filtered.map(p => (
            <button
              key={p.id}
              className="w-full text-left px-3 py-2 hover:bg-white/[0.08] flex gap-3 items-center"
              onMouseDown={e => { e.preventDefault(); onChange(p); setAnchorRect(null); setQuery('') }}
            >
              <span className="font-mono text-xs text-brand-300 w-20 flex-shrink-0">{p.sku}</span>
              <span className="text-sm text-white/80 truncate">{p.description}</span>
            </button>
          ))}
        </div>,
        document.getElementById('dropdown-portal') ?? document.body
      )}
    </div>
  )
}

// ── Add row ───────────────────────────────────────────────────────────────────

interface AddRowProps {
  products: Product[]
  existingRows: FlatRow[]
  defaultLevel?: number       // pre-fill level
  defaultParentId?: number    // pre-fill parent (also drives level)
  onAdded: () => void
  onCancel: () => void
}

function AddRow({ products, existingRows, defaultLevel, defaultParentId, onAdded, onCancel }: AddRowProps) {
  const defaultParentProduct = defaultParentId ? (products.find(p => p.id === defaultParentId) ?? null) : null
  const [level, setLevel] = useState<number>(defaultLevel ?? (defaultParentId ? 1 : 1))
  const [parent, setParent] = useState<Product | null>(defaultParentProduct)
  const [item, setItem] = useState<Product | null>(null)
  const [qty, setQty] = useState('1')
  const [uom, setUom] = useState('EA')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const levelRef = useRef<HTMLInputElement>(null)

  // When item changes, sync UOM from its product record
  useEffect(() => { setUom(item?.unit_of_measure ?? 'EA') }, [item])

  const parentOptions = products.filter(p => p.id !== item?.id)
  const itemOptions = products.filter(p => p.id !== parent?.id)

  const isL0 = level === 0

  const commit = async () => {
    if (isL0) {
      setError('L0 items appear automatically when they have children. Enter level 1+.')
      return
    }
    if (!parent) { setError('Select parent'); return }
    if (!item) { setError('Select item code'); return }
    const q = parseFloat(qty)
    if (!q || q <= 0) { setError('Qty > 0'); return }
    setSaving(true); setError('')
    try {
      await addBomItem({ parent_product_id: parent.id, child_product_id: item.id, quantity_per: q })
      if (uom !== item.unit_of_measure) {
        await updateProduct(item.id, { unit_of_measure: uom })
      }
      onAdded()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(msg || 'Error'); setSaving(false)
    }
  }

  const esc = (e: React.KeyboardEvent) => { if (e.key === 'Escape') onCancel() }

  return (
    <tr className="bg-brand-900/20 border-t-2 border-brand-500/40">
      {/* Level */}
      <td className="px-2 py-2 text-center">
        <input
          ref={levelRef}
          type="number" min="0" max="9" step="1"
          className="w-10 bg-white/[0.08] border border-white/20 focus:border-brand-400 rounded px-1.5 py-1 text-sm text-white text-center outline-none"
          value={level}
          onChange={e => { setLevel(parseInt(e.target.value) || 0); if (parseInt(e.target.value) === 0) setParent(null) }}
          onKeyDown={esc}
          autoFocus
        />
      </td>

      {/* Parent — hidden at L0 */}
      <td className="px-2 py-2" style={{ minWidth: 160 }}>
        {isL0 ? (
          <span className="text-xs text-white/20 italic px-1">—</span>
        ) : (
          <ProductSearch
            value={parent} onChange={setParent}
            products={parentOptions}
            placeholder="Parent…"
            onKeyDown={esc}
            tabIndex={1}
          />
        )}
      </td>

      {/* Item Code */}
      <td className="px-2 py-2" style={{ minWidth: 160 }}>
        <ProductSearch
          value={item} onChange={setItem}
          products={itemOptions}
          placeholder="Item code…"
          onKeyDown={e => { if (e.key === 'Enter' && !isL0) commit(); esc(e) }}
          tabIndex={2}
        />
      </td>

      {/* Description — auto */}
      <td className="px-2 py-2 text-xs text-white/40 truncate max-w-[200px]">
        {item?.description ?? ''}
      </td>

      {/* Qty — hidden at L0 */}
      <td className="px-2 py-2 text-right">
        {!isL0 && (
          <input
            type="number" min="0.001" step="any"
            className="w-20 bg-white/[0.06] border border-white/20 focus:border-brand-400 rounded px-2 py-1 text-sm text-white text-right outline-none"
            value={qty}
            onChange={e => setQty(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commit(); esc(e) }}
            placeholder="qty"
            tabIndex={3}
          />
        )}
      </td>

      {/* UOM */}
      <td className="px-2 py-2">
        {!isL0 && (
          <select
            className="bg-zinc-800 border border-white/20 focus:border-brand-400 rounded px-1.5 py-1 text-xs text-white outline-none cursor-pointer"
            value={uom}
            onChange={e => setUom(e.target.value)}
            tabIndex={4}
          >
            {UOM_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        )}
      </td>

      {/* Save / cancel */}
      <td className="px-2 py-2 whitespace-nowrap">
        <div className="flex items-center gap-1.5">
          {!isL0 && (
            <button
              onClick={commit} disabled={saving || !parent || !item}
              className="text-xs font-medium px-2.5 py-1 rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
              tabIndex={4}
            >
              {saving ? '…' : <><Plus className="w-3 h-3" />Add</>}
            </button>
          )}
          <button onClick={onCancel} className="text-white/30 hover:text-white/70 text-lg leading-none px-1">×</button>
          {error && <span className="text-xs text-rose-400 max-w-[120px] leading-tight">{error}</span>}
        </div>
      </td>
    </tr>
  )
}

// ── Delete with inline confirm ────────────────────────────────────────────────

function DeleteButton({ bomId, onDeleted }: { bomId: number; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false)

  if (confirming)
    return (
      <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
        <span className="text-xs text-white/50">Sure?</span>
        <button
          className="text-xs font-medium px-1.5 py-0.5 rounded bg-rose-600 text-white hover:bg-rose-500 transition-colors"
          onClick={async () => { await deleteBomItem(bomId); onDeleted() }}
        >
          Yes
        </button>
        <button
          className="text-xs px-1.5 py-0.5 rounded text-white/40 hover:text-white transition-colors"
          onClick={() => setConfirming(false)}
        >
          No
        </button>
      </div>
    )

  return (
    <button
      className="p-1 rounded text-white/0 group-hover:text-white/25 hover:!text-rose-400 hover:bg-white/[0.08] transition-colors"
      title="Remove"
      onClick={e => { e.stopPropagation(); setConfirming(true) }}
    >
      <Trash2 className="w-3.5 h-3.5" />
    </button>
  )
}

// ── Constants ─────────────────────────────────────────────────────────────────

const LEVEL_COLORS = ['text-brand-300', 'text-violet-300', 'text-amber-300', 'text-emerald-300', 'text-rose-300']
const LEVEL_BG     = ['', 'bg-violet-500/[0.03]', 'bg-amber-500/[0.03]', 'bg-emerald-500/[0.03]', 'bg-rose-500/[0.03]']

// ── Tree helpers ──────────────────────────────────────────────────────────────

function containsProduct(node: BomTreeNode, productId: number): boolean {
  if (node.product_id === productId) return true
  return node.children.some(c => containsProduct(c, productId))
}

function findRootContaining(tree: BomTreeNode[], productId: number): BomTreeNode | null {
  for (const root of tree) {
    if (containsProduct(root, productId)) return root
  }
  return null
}

function findAllParents(tree: BomTreeNode[], targetId: number): Array<{ sku: string; description: string; qty: number }> {
  const results: Array<{ sku: string; description: string; qty: number }> = []
  function traverse(node: BomTreeNode) {
    for (const child of node.children) {
      if (child.product_id === targetId) {
        results.push({ sku: node.sku, description: node.description, qty: child.quantity_per ?? 1 })
      }
      traverse(child)
    }
  }
  for (const root of tree) traverse(root)
  return results
}

// ── Visual BOM tree ───────────────────────────────────────────────────────────

const LEVEL_BORDER_COLOR = [
  'border-brand-400/50',
  'border-violet-400/50',
  'border-amber-400/50',
  'border-emerald-400/50',
  'border-rose-400/50',
]
const LEVEL_BG_NODE = [
  'bg-brand-500/[0.07]',
  'bg-violet-500/[0.07]',
  'bg-amber-500/[0.07]',
  'bg-emerald-500/[0.07]',
  'bg-rose-500/[0.07]',
]

const BOM_TREE_STYLES = `
  @keyframes bomNodeIn {
    from { opacity: 0; transform: translateY(8px) scale(0.88); }
    to   { opacity: 1; transform: translateY(0)   scale(1);    }
  }
  @keyframes bomLineDown {
    from { transform: scaleY(0); opacity: 0; }
    to   { transform: scaleY(1); opacity: 1; }
  }
  @keyframes bomLineAcross {
    from { opacity: 0; clip-path: inset(0 100% 0 0); }
    to   { opacity: 1; clip-path: inset(0 0%   0 0); }
  }
  .bom-node  { animation: bomNodeIn    0.32s cubic-bezier(0.34,1.56,0.64,1) both; }
  .bom-vline { animation: bomLineDown  0.20s ease-out both; transform-origin: top; }
  .bom-hline { animation: bomLineAcross 0.25s ease-out both; }
`

function VisualTreeNode({
  node, selectedId, onSelect, depth = 0, stagger = 0,
}: {
  node: BomTreeNode
  selectedId: number
  onSelect: (id: number) => void
  depth?: number
  stagger?: number
}) {
  const isSelected = node.product_id === selectedId
  const idx        = Math.min(depth, LEVEL_COLORS.length - 1)
  const textColor  = LEVEL_COLORS[idx]
  const borderCls  = isSelected ? 'border-brand-400/80' : LEVEL_BORDER_COLOR[idx]
  const bgCls      = isSelected ? 'bg-brand-500/20' : LEVEL_BG_NODE[idx]
  const glowCls    = isSelected ? 'shadow-lg shadow-brand-400/30' : ''
  const n          = node.children.length

  const desc = node.description.length > 18
    ? node.description.slice(0, 18) + '…'
    : node.description

  return (
    <div className="flex flex-col items-center">
      {/* ── Node card ── */}
      <div
        className={`bom-node rounded-xl border px-3 py-2 min-w-[88px] max-w-[120px] text-center cursor-pointer
          transition-all duration-200 select-none ${borderCls} ${bgCls} ${glowCls}
          ${isSelected ? 'ring-2 ring-brand-400/40' : 'hover:bg-white/[0.08] hover:border-white/25'}`}
        style={{ animationDelay: `${stagger}ms` }}
        onClick={() => onSelect(node.product_id)}
        title={node.description}
      >
        <div className={`font-mono text-[11px] font-bold leading-tight ${isSelected ? 'text-brand-300' : textColor}`}>
          {node.sku}
        </div>
        <div className={`text-[9px] mt-0.5 leading-snug ${isSelected ? 'text-white/55' : 'text-white/28'}`}>
          {desc}
        </div>
        {node.quantity_per != null && (
          <div className={`text-[9px] mt-1 font-semibold ${isSelected ? 'text-brand-400/80' : 'text-white/20'}`}>
            ×{node.quantity_per}
          </div>
        )}
      </div>

      {/* ── Children ── */}
      {n > 0 && (
        <>
          {/* Vertical line from node down to horizontal bar */}
          <div
            className="bom-vline bg-white/[0.14]"
            style={{ width: 1, height: 18, animationDelay: `${stagger + 120}ms` }}
          />

          {/* Horizontal bar + child columns */}
          <div className="flex items-start">
            {node.children.map((child, i) => {
              const isFirst = i === 0
              const isLast  = i === n - 1
              const isOnly  = n === 1

              return (
                <div
                  key={`${child.product_id}-${child.bom_id ?? i}`}
                  className="flex flex-col items-center"
                  style={{ padding: '0 10px' }}
                >
                  {/* Connector segment: horizontal bar + vertical drop */}
                  <div className="relative flex justify-center" style={{ width: '100%', height: 18 }}>
                    {/* Horizontal bar segment (left half / full / right half) */}
                    {!isOnly && (
                      <div
                        className="bom-hline absolute bg-white/[0.14]"
                        style={{
                          top: 0,
                          height: 1,
                          left:  isFirst ? '50%' : 0,
                          right: isLast  ? '50%' : 0,
                          animationDelay: `${stagger + 180}ms`,
                        }}
                      />
                    )}
                    {/* Vertical drop */}
                    <div
                      className="bom-vline bg-white/[0.14]"
                      style={{ width: 1, height: '100%', animationDelay: `${stagger + 160}ms` }}
                    />
                  </div>

                  <VisualTreeNode
                    node={child}
                    selectedId={selectedId}
                    onSelect={onSelect}
                    depth={depth + 1}
                    stagger={stagger + 160 + i * 70}
                  />
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function BomTreePanel({
  tree, selectedProductId, onSelect,
}: {
  tree: BomTreeNode[]
  selectedProductId: number | null
  onSelect: (id: number) => void
}) {
  if (!selectedProductId) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-white/20 text-sm gap-2 pt-8">
        <GitBranch className="w-8 h-8 opacity-20" />
        <span>Click a row to see BOM structure</span>
      </div>
    )
  }

  const root       = findRootContaining(tree, selectedProductId)
  const parents    = findAllParents(tree, selectedProductId)
  const isTopLevel = root?.product_id === selectedProductId

  return (
    <>
      <style>{BOM_TREE_STYLES}</style>
      <div className="flex flex-col gap-5">

        {/* Visual tree */}
        <div>
          <p className="text-xs font-medium text-white/30 uppercase tracking-wider mb-4">BOM Structure</p>
          {root ? (
            <div className="overflow-x-auto pb-2 flex justify-center">
              <VisualTreeNode
                node={root}
                selectedId={selectedProductId}
                onSelect={onSelect}
              />
            </div>
          ) : (
            <p className="text-xs text-white/30 italic">This item is not part of any BOM.</p>
          )}
        </div>

        {/* Also used in */}
        {parents.length > 0 && (
          <div>
            <p className="text-xs font-medium text-white/30 uppercase tracking-wider mb-2.5">Also used in</p>
            <div className="flex flex-col gap-1.5">
              {parents.map((p, i) => (
                <div key={i} className="flex items-center gap-2 text-xs bg-white/[0.025] rounded-lg px-3 py-2 border border-white/[0.05]">
                  <span className="font-mono text-brand-300 flex-shrink-0">{p.sku}</span>
                  <span className="text-white/45 truncate">{p.description}</span>
                  <span className="text-white/25 ml-auto flex-shrink-0">×{p.qty}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {parents.length === 0 && isTopLevel && (
          <p className="text-xs text-white/20 italic">Top-level assembly — not a component of any other BOM.</p>
        )}

      </div>
    </>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function BOM() {
  const [tree, setTree]       = useState<BomTreeNode[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [flows, setFlows] = useState<ProductionFlow[]>([])
  const [workstations, setWorkstations] = useState<Workstation[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding]   = useState(false)
  const [addLevel, setAddLevel]   = useState<number | undefined>()
  const [addParentId, setAddParentId] = useState<number | undefined>()
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null)

  const load = useCallback(async () => {
    const [t, p, fl, ws] = await Promise.all([getBomTree(), getProducts(), getFlows(), getWorkstations()])
    setTree(t); setProducts(p); setFlows(fl); setWorkstations(ws); setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const reload = useCallback(async () => {
    setAdding(false); setAddLevel(undefined); setAddParentId(undefined)
    await load()
  }, [load])

  const startAddChild = (parentId: number, parentLevel: number) => {
    setAddLevel(parentLevel + 1)
    setAddParentId(parentId)
    setAdding(true)
  }

  const startAddNew = (level?: number, parentId?: number) => {
    setAddLevel(level)
    setAddParentId(parentId)
    setAdding(true)
  }

  if (loading) return <Spinner className="h-64" />

  const rows = flattenTree(tree)
  // Products that appear as a parent of at least one other row (BOM parents = need a workstation)
  const parentProductIds = new Set(
    rows.map(r => r.parent_product_id).filter((id): id is number => id !== undefined)
  )

  return (
    <div className="flex flex-col gap-3">

      {/* Content: table (2/3) + tree panel (1/3) — scrolls horizontally on narrow windows */}
      <div className="overflow-x-auto">
      <div className="flex gap-4 items-start min-w-[740px]">

      {/* Table column */}
      <div className="w-2/3 flex flex-col gap-2 flex-shrink-0">

        {/* Table header: stats left, buttons right */}
        <div className="flex items-center justify-between">
          <p className="text-xs text-white/40">
            {rows.length === 0
              ? 'No BOM items yet.'
              : `${rows.length} rows · ${tree.length} top-level product${tree.length !== 1 ? 's' : ''}`}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => startAddNew(1)}
              className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-white/10 text-white/60 hover:text-white hover:border-white/20 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />New row
            </button>
            <button
              onClick={() => startAddNew(1)}
              className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-500 transition-colors"
            >
              <GitBranch className="w-4 h-4" />Create new BOM
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="rounded-2xl border border-white/[0.08] overflow-hidden">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-white/[0.04] text-xs font-medium text-white/40 uppercase tracking-wider [&>th:first-child]:rounded-tl-2xl [&>th:last-child]:rounded-tr-2xl">
              <th className="px-3 py-2.5 text-center w-12">Lvl</th>
              <th className="px-3 py-2.5 text-left w-36">Parent</th>
              <th className="px-3 py-2.5 text-left w-36">Item Code</th>
              <th className="px-3 py-2.5 text-left">Description</th>
              <th className="px-3 py-2.5 text-right w-24">Qty</th>
              <th className="px-3 py-2.5 text-left w-16">Unit</th>
              <th className="px-3 py-2.5 text-left w-36">Production Flow</th>
              <th className="px-3 py-2.5 text-left w-36">Workstation</th>
              <th className="px-3 py-2.5 w-14" />
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05]">

            {rows.length === 0 && !adding && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-white/30 text-sm">
                  No BOM items yet — click <strong>Create new BOM</strong> to get started.
                </td>
              </tr>
            )}

            {rows.map(row => {
              const levelColor = LEVEL_COLORS[Math.min(row.level, LEVEL_COLORS.length - 1)]
              const rowBg      = LEVEL_BG[Math.min(row.level, LEVEL_BG.length - 1)]
              const parentRow  = rows.find(r => r.product_id === row.parent_product_id && r.level === row.level - 1)
              const parentSku  = parentRow?.sku ?? (row.level === 0 ? '' : '—')

              const isSelected = row.product_id === selectedProductId

              return (
                <tr
                  key={`${row.product_id}-${row.bom_id ?? 'root'}`}
                  className={`group transition-colors cursor-pointer select-none ${rowBg} ${isSelected ? 'bg-brand-500/10 hover:bg-brand-500/15' : 'hover:bg-white/[0.04]'}`}
                  onClick={() => setSelectedProductId(row.product_id)}
                  onDoubleClick={() => startAddChild(row.product_id, row.level)}
                  title="Double-click to add child"
                >
                  {/* Level */}
                  <td className="px-3 py-2 text-center">
                    <span className={`text-xs font-bold ${levelColor}`}>L{row.level}</span>
                  </td>

                  {/* Parent SKU */}
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs text-white/35">{parentSku}</span>
                  </td>

                  {/* Item code — indented */}
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1" style={{ paddingLeft: row.level * 12 }}>
                      {row.level > 0 && <span className="text-white/20 flex-shrink-0 text-xs">└</span>}
                      <span className={`font-mono text-sm font-medium ${levelColor}`}>{row.sku}</span>
                    </div>
                  </td>

                  {/* Description */}
                  <td className="px-3 py-2 text-white/65 truncate max-w-[240px]">{row.description}</td>

                  {/* Qty */}
                  <td className="px-3 py-2 text-right" onClick={e => e.stopPropagation()}>
                    {row.bom_id ? (
                      <QtyCell value={row.quantity_per ?? 1} bomId={row.bom_id} onSaved={reload} />
                    ) : (
                      <span className="text-xs text-white/20 italic">top level</span>
                    )}
                  </td>

                  {/* Unit */}
                  <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                    <UomCell value={row.unit_of_measure} productId={row.product_id} onSaved={reload} />
                  </td>

                  {/* Production Flow — level-0 only */}
                  <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                    {row.level === 0 ? (
                      <ProductionFlowCell
                        value={products.find(p => p.id === row.product_id)?.production_flow_id ?? null}
                        productId={row.product_id}
                        flows={flows}
                        onSaved={reload}
                      />
                    ) : (
                      <span className="text-xs text-white/10">—</span>
                    )}
                  </td>

                  {/* Workstation — L0 and L1+ parents (items that have children) */}
                  <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                    {parentProductIds.has(row.product_id) ? (
                      <WorkstationCell
                        value={products.find(p => p.id === row.product_id)?.workstation_id ?? null}
                        productId={row.product_id}
                        workstations={workstations}
                        onSaved={reload}
                      />
                    ) : (
                      <span className="text-xs text-white/10">—</span>
                    )}
                  </td>

                  {/* Actions — always-visible + button, delete on hover */}
                  <td className="px-2 py-2" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center gap-0.5">
                      {/* + child: always visible, subtle */}
                      <button
                        className="p-1 rounded text-white/25 hover:text-brand-400 hover:bg-white/[0.08] transition-colors"
                        title="Add child (or double-click row)"
                        onClick={() => startAddChild(row.product_id, row.level)}
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>

                      {/* delete: hover only, with inline confirm */}
                      {row.bom_id && (
                        <DeleteButton bomId={row.bom_id} onDeleted={reload} />
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}

            {/* Inline add row */}
            {adding && (
              <AddRow
                products={products}
                existingRows={rows}
                defaultLevel={addLevel}
                defaultParentId={addParentId}
                onAdded={reload}
                onCancel={() => { setAdding(false); setAddLevel(undefined); setAddParentId(undefined) }}
              />
            )}

          </tbody>
        </table>
        </div>{/* end table rounded wrapper */}
      </div>{/* end table column */}

      {/* Right panel — BOM tree */}
      <div className="w-1/3 min-w-0 pl-4">
        <BomTreePanel tree={tree} selectedProductId={selectedProductId} onSelect={setSelectedProductId} />
      </div>

      </div>{/* end content flex row */}
      </div>{/* end overflow-x-auto */}

      <div className="h-2" />
    </div>
  )
}
