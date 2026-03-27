import { useEffect, useState } from 'react'
import { AlertTriangle, Plus, Trash2, Settings, GripVertical, Check, X, Pencil } from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine, CartesianGrid,
} from 'recharts'
import type { TooltipProps } from 'recharts'
import { useSidebarActionsEffect } from '../context/SidebarActionsContext'
import {
  getValueStreamLoad, simulateValueStream,
  getWorkstations, createWorkstation, updateWorkstation, deleteWorkstation,
  getMrpRuns, getFlows, createFlow, updateFlow, deleteFlow,
} from '../api'
import type {
  ValueStreamLoadResponse, WorkstationLoadResult,
  WeeklyWorkstationLoad, Workstation, MrpRun, ProductionFlow,
} from '../api/types'
import { Card, CardHeader, CardTitle, PageHeader, Button, Select, Spinner } from '../components/ui'

// ── Colors ────────────────────────────────────────────────────────────────────

const VSM_COLORS = ['#6aaac0', '#2aae81', '#e08b5e', '#8fb5c7', '#a07dbf', '#208663']

// ── Tooltip ───────────────────────────────────────────────────────────────────

function VsmTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'rgba(0,0,0,0.85)', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(16px)' }}
      className="rounded-xl shadow-2xl px-3.5 py-2.5 min-w-[160px]">
      <p className="text-[10px] uppercase tracking-widest mb-2 text-white/40">{label}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center justify-between gap-4 text-xs mb-1 last:mb-0">
          <span className="flex items-center gap-1.5 text-white/60">
            <span className="w-1.5 h-1.5 rounded-full inline-block shrink-0" style={{ background: p.color }} />
            {p.name}
          </span>
          <span className="font-semibold text-white/95">{((p.value as number) * 100).toFixed(0)}%</span>
        </div>
      ))}
    </div>
  )
}

// ── Util color helpers ─────────────────────────────────────────────────────────

function utilColor(pct: number, threshold: number) {
  if (pct > threshold) return 'bg-red-500'
  if (pct > threshold * 0.85) return 'bg-amber-400'
  return 'bg-green-500'
}
function utilTextColor(pct: number, threshold: number) {
  if (pct > threshold) return 'text-red-400'
  if (pct > threshold * 0.85) return 'text-amber-400'
  return 'text-green-400'
}

// ── Workstation box in flow ────────────────────────────────────────────────────

interface FlowBoxProps {
  ws: WorkstationLoadResult
  allWorkstations: Workstation[]
  threshold: number
  isSelected: boolean
  isDragging: boolean
  isDragOver: boolean
  onSelect: () => void
  onEdit: (updates: { name?: string; hours_per_day?: number; days_per_week?: number; cycle_rate_units_per_min?: number }) => void
  onRemove: () => void
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: () => void
  onDragEnd: () => void
}

function FlowBox({
  ws, threshold, isSelected, isDragging, isDragOver,
  onSelect, onEdit, onRemove, onDragStart, onDragOver, onDrop, onDragEnd,
}: FlowBoxProps) {
  const [editing, setEditing] = useState(false)
  const [draftHours, setDraftHours] = useState(String(ws.hours_per_day))
  const [draftDays, setDraftDays] = useState(String(ws.days_per_week))
  const [draftRate, setDraftRate] = useState(String(ws.cycle_rate_units_per_min))
  const [draftName, setDraftName] = useState(ws.workstation_name)

  const colorBar = utilColor(ws.peak_utilization_pct, threshold)
  const textCol  = utilTextColor(ws.peak_utilization_pct, threshold)

  const computedUnits = Math.round(
    (parseFloat(draftHours) || 0) * 60 * (parseFloat(draftRate) || 0) * (parseInt(draftDays) || 5)
  )

  function commitEdit() {
    onEdit({
      name: draftName.trim() || ws.workstation_name,
      hours_per_day: parseFloat(draftHours) || 8,
      days_per_week: parseInt(draftDays) || 5,
      cycle_rate_units_per_min: parseFloat(draftRate) || 0,
    })
    setEditing(false)
  }

  function cancelEdit() {
    setDraftHours(String(ws.hours_per_day))
    setDraftDays(String(ws.days_per_week))
    setDraftRate(String(ws.cycle_rate_units_per_min))
    setDraftName(ws.workstation_name)
    setEditing(false)
  }

  return (
    <div
      className={`relative flex flex-col min-w-[160px] max-w-[180px] rounded-xl border transition-all duration-200
        ${isDragOver ? 'border-brand-400/80 ring-2 ring-brand-400/30 bg-brand-500/10' : ''}
        ${isDragging ? 'opacity-40' : ''}
        ${isSelected && !isDragOver ? 'border-brand-400/60 bg-brand-500/10' : ''}
        ${!isSelected && !isDragOver ? 'border-white/[0.1] bg-white/[0.03] hover:bg-white/[0.07] hover:border-white/20' : ''}
      `}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      {/* Color strip */}
      <div className={`h-1.5 rounded-t-xl ${colorBar}`} />

      {/* Drag handle + remove */}
      <div className="flex items-center justify-between px-2 pt-1.5">
        <GripVertical className="w-3.5 h-3.5 text-white/20 cursor-grab active:cursor-grabbing shrink-0" />
        <button
          onClick={e => { e.stopPropagation(); onRemove() }}
          className="p-0.5 text-white/15 hover:text-rose-400 transition-colors"
          title="Remove from flow"
        ><X className="w-3 h-3" /></button>
      </div>

      {editing ? (
        <div className="px-2.5 pb-2.5 flex flex-col gap-1.5" onClick={e => e.stopPropagation()}>
          <p className="text-[9px] font-bold uppercase tracking-widest text-white/40 mt-0.5">Name</p>
          <input
            className="bg-white/[0.08] border border-white/10 rounded px-2 py-1 text-xs text-white outline-none focus:border-brand-400 w-full"
            value={draftName}
            onChange={e => setDraftName(e.target.value)}
            placeholder="Name"
          />
          <p className="text-[9px] font-bold uppercase tracking-widest text-white/40 mt-0.5">Hours/day</p>
          <input
            className="bg-white/[0.08] border border-white/10 rounded px-2 py-1 text-xs text-white outline-none focus:border-brand-400 w-full"
            value={draftHours}
            onChange={e => setDraftHours(e.target.value)}
            placeholder="e.g. 8"
            type="number" min="0" max="24" step="0.5"
          />
          <p className="text-[9px] font-bold uppercase tracking-widest text-white/40 mt-0.5">Days/week</p>
          <select
            className="bg-white/[0.08] border border-white/10 rounded px-2 py-1 text-xs text-white outline-none focus:border-brand-400 w-full"
            value={draftDays}
            onChange={e => setDraftDays(e.target.value)}
          >
            {[1,2,3,4,5,6,7].map(d => <option key={d} value={d}>{d} day{d !== 1 ? 's' : ''}</option>)}
          </select>
          <p className="text-[9px] font-bold uppercase tracking-widest text-white/40 mt-0.5">Cycle rate (units/min)</p>
          <input
            className="bg-white/[0.08] border border-white/10 rounded px-2 py-1 text-xs text-white outline-none focus:border-brand-400 w-full"
            value={draftRate}
            onChange={e => setDraftRate(e.target.value)}
            placeholder="e.g. 0.5"
            type="number" min="0" step="0.01"
          />
          <p className="text-[10px] text-white/30">= {computedUnits} units/wk</p>
          <div className="flex gap-1 mt-0.5">
            <button onClick={commitEdit} className="flex-1 flex items-center justify-center gap-1 py-1 bg-brand-600 hover:bg-brand-500 rounded text-white text-[10px] font-medium transition-colors">
              <Check className="w-2.5 h-2.5" /> Save
            </button>
            <button onClick={cancelEdit} className="px-2 py-1 text-white/40 hover:text-white text-[10px] transition-colors">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="px-3 pb-2.5 flex flex-col gap-0.5 cursor-pointer" onClick={onSelect}>
          <p className="text-xs font-semibold text-white truncate" title={ws.workstation_name}>{ws.workstation_name}</p>
          {ws.department && <p className="text-[10px] text-white/35 truncate">{ws.department}</p>}
          <p className={`text-xl font-bold leading-none mt-1.5 ${textCol}`}>
            {(ws.peak_utilization_pct * 100).toFixed(0)}%
          </p>
          <p className="text-[10px] text-white/25">peak utilisation</p>
          <div className="flex items-center justify-between mt-1.5">
            <div>
              <p className="text-[10px] text-white/40">{ws.capacity_units_per_week.toFixed(0)} units/wk</p>
              <p className="text-[10px] text-white/25">{ws.hours_per_day}h × {ws.days_per_week}d/wk · {ws.cycle_rate_units_per_min} u/min</p>
            </div>
            <button
              onClick={e => { e.stopPropagation(); setEditing(true) }}
              className="p-1 text-white/15 hover:text-white/60 transition-colors"
              title="Edit workstation"
            ><Pencil className="w-3 h-3" /></button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Detail table ───────────────────────────────────────────────────────────────

function DetailTable({
  workstations, selectedWsId, threshold,
}: {
  workstations: WorkstationLoadResult[]
  selectedWsId: number | null
  threshold: number
}) {
  const [expandedWeeks, setExpandedWeeks] = useState<Set<string>>(new Set())
  const toggleWeek = (key: string) => {
    setExpandedWeeks(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  }

  if (selectedWsId !== null) {
    const ws = workstations.find(w => w.workstation_id === selectedWsId)
    if (!ws) return null
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-white/[0.04] text-xs font-medium text-white/40 uppercase tracking-wider">
              <th className="px-3 py-2.5 text-left">Week</th>
              <th className="px-3 py-2.5 text-right">Load (min)</th>
              <th className="px-3 py-2.5 text-right">Capacity (min)</th>
              <th className="px-3 py-2.5 text-right">Utilisation</th>
              <th className="px-3 py-2.5 text-right">Items</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {ws.weekly_loads.map((wl: WeeklyWorkstationLoad) => {
              const rowKey = `${ws.workstation_id}-${wl.week_key}`
              const expanded = expandedWeeks.has(rowKey)
              const textCol = utilTextColor(wl.utilization_pct, threshold)
              return (
                <>
                  <tr
                    key={wl.week_key}
                    className={`hover:bg-white/[0.04] transition-colors ${wl.products.length > 0 ? 'cursor-pointer' : ''}`}
                    onClick={() => wl.products.length > 0 && toggleWeek(rowKey)}
                  >
                    <td className="px-3 py-2 text-white/70 font-mono text-xs">
                      {wl.week_label}
                      {wl.is_bottleneck && <span className="ml-2 text-[9px] text-red-400 uppercase font-bold">bottleneck</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-white/60 text-xs">{wl.load_minutes.toFixed(0)}</td>
                    <td className="px-3 py-2 text-right text-white/40 text-xs">{wl.capacity_minutes.toFixed(0)}</td>
                    <td className={`px-3 py-2 text-right text-xs font-semibold ${textCol}`}>{(wl.utilization_pct * 100).toFixed(0)}%</td>
                    <td className="px-3 py-2 text-right text-white/50 text-xs">
                      {wl.products.length > 0
                        ? <span className="text-brand-400 hover:underline">{wl.products.length} {expanded ? '▲' : '▼'}</span>
                        : '—'}
                    </td>
                  </tr>
                  {expanded && wl.products.map(pl => (
                    <tr key={pl.product_id} className="bg-white/[0.02]">
                      <td className="px-3 py-1.5 pl-8" colSpan={2}>
                        <span className="font-mono text-xs text-brand-300">{pl.sku}</span>
                        {wl.is_bottleneck && pl.has_priority_demand && (
                          <span className="text-amber-400 font-bold ml-0.5 text-xs" title="Priority customer demand">*</span>
                        )}
                        <span className="text-xs text-white/40 ml-2">{pl.description}</span>
                      </td>
                      <td className="px-3 py-1.5 text-right text-xs text-white/40">qty: {pl.qty.toFixed(0)}</td>
                      <td className="px-3 py-1.5 text-right text-xs text-white/40" colSpan={2}>{pl.load_minutes.toFixed(0)} min</td>
                    </tr>
                  ))}
                </>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-white/[0.04] text-xs font-medium text-white/40 uppercase tracking-wider">
            <th className="px-3 py-2.5 text-left">Workstation</th>
            <th className="px-3 py-2.5 text-left">Dept</th>
            <th className="px-3 py-2.5 text-right">Hrs/day</th>
            <th className="px-3 py-2.5 text-right">Units/wk</th>
            <th className="px-3 py-2.5 text-right">Avg Util</th>
            <th className="px-3 py-2.5 text-right">Peak Util</th>
            <th className="px-3 py-2.5 text-right">Bottleneck wks</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.04]">
          {workstations.map(ws => {
            const bottleneckWks = ws.weekly_loads.filter(wl => wl.is_bottleneck).length
            const textCol = utilTextColor(ws.peak_utilization_pct, threshold)
            return (
              <tr key={ws.workstation_id} className="hover:bg-white/[0.04] transition-colors">
                <td className="px-3 py-2 text-white/80 text-sm">{ws.workstation_name}</td>
                <td className="px-3 py-2 text-white/40 text-xs">{ws.department ?? '—'}</td>
                <td className="px-3 py-2 text-right text-white/50 text-xs">{ws.hours_per_day}</td>
                <td className="px-3 py-2 text-right text-white/60 text-xs">{ws.capacity_units_per_week.toFixed(0)}</td>
                <td className="px-3 py-2 text-right text-xs text-white/60">{(ws.avg_utilization_pct * 100).toFixed(0)}%</td>
                <td className={`px-3 py-2 text-right text-xs font-semibold ${textCol}`}>{(ws.peak_utilization_pct * 100).toFixed(0)}%</td>
                <td className="px-3 py-2 text-right text-xs">
                  {bottleneckWks > 0
                    ? <span className="text-red-400 font-semibold">{bottleneckWks}</span>
                    : <span className="text-white/25">0</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Manage Workstations modal ──────────────────────────────────────────────────

function ManageWorkstationsModal({
  workstations, onClose, onChanged,
}: {
  workstations: Workstation[]
  onClose: () => void
  onChanged: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [hoursPerDay, setHoursPerDay] = useState('8')
  const [daysPerWeek, setDaysPerWeek] = useState('5')
  const [cycleRate, setCycleRate] = useState('')
  const [dept, setDept] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const computedCap = Math.round((parseFloat(hoursPerDay) || 0) * 60 * (parseFloat(cycleRate) || 0) * (parseInt(daysPerWeek) || 5))

  const handleAdd = async () => {
    if (!name.trim() || !cycleRate) { setError('Name and cycle rate (units/min) required.'); return }
    setSaving(true)
    try {
      await createWorkstation({
        name: name.trim(),
        hours_per_day: parseFloat(hoursPerDay) || 8,
        days_per_week: parseInt(daysPerWeek) || 5,
        cycle_rate_units_per_min: parseFloat(cycleRate) || 0,
        department: dept.trim() || null,
      })
      setName(''); setHoursPerDay('8'); setDaysPerWeek('5'); setCycleRate(''); setDept(''); setAdding(false); setError('')
      onChanged()
    } catch {
      setError('Failed to create workstation.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl w-full max-w-xl p-6 flex flex-col gap-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-white">Manage Workstations</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white text-xl leading-none">×</button>
        </div>

        <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
          {workstations.length === 0 && <p className="text-sm text-white/30 italic">No workstations yet.</p>}
          {workstations.map(ws => (
            <div key={ws.id} className="flex items-center gap-2 bg-white/[0.04] rounded-lg px-3 py-2">
              <div className="flex-1">
                <span className="text-sm text-white font-medium">{ws.name}</span>
                {ws.department && <span className="text-xs text-white/40 ml-2">{ws.department}</span>}
                <span className="text-xs text-white/30 ml-2">{ws.capacity_units_per_week} units/wk · {ws.hours_per_day}h × {ws.days_per_week}d/wk · {ws.cycle_rate_units_per_min} u/min</span>
              </div>
              <button onClick={() => deleteWorkstation(ws.id).then(onChanged)} className="p-1 text-white/20 hover:text-rose-400 transition-colors" title="Delete">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>

        {adding ? (
          <div className="border-t border-white/[0.07] pt-3 flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              <input
                className="bg-white/[0.06] border border-white/10 focus:border-brand-400 rounded-lg px-3 py-1.5 text-sm text-white outline-none col-span-2"
                placeholder="Workstation name *"
                value={name} onChange={e => setName(e.target.value)}
              />
              <input
                className="bg-white/[0.06] border border-white/10 focus:border-brand-400 rounded-lg px-3 py-1.5 text-sm text-white outline-none"
                placeholder="Hours/day (default 8)"
                type="number" min="0" max="24" step="0.5" value={hoursPerDay} onChange={e => setHoursPerDay(e.target.value)}
              />
              <select
                className="bg-white/[0.06] border border-white/10 focus:border-brand-400 rounded-lg px-3 py-1.5 text-sm text-white outline-none"
                value={daysPerWeek} onChange={e => setDaysPerWeek(e.target.value)}
              >
                {[1,2,3,4,5,6,7].map(d => <option key={d} value={d}>{d} day{d !== 1 ? 's' : ''}/wk</option>)}
              </select>
              <input
                className="bg-white/[0.06] border border-white/10 focus:border-brand-400 rounded-lg px-3 py-1.5 text-sm text-white outline-none"
                placeholder="Cycle rate (units/min) *"
                type="number" min="0" step="0.01" value={cycleRate} onChange={e => setCycleRate(e.target.value)}
              />
              <div className="text-xs text-white/40">= {computedCap} units/week</div>
              <input
                className="bg-white/[0.06] border border-white/10 focus:border-brand-400 rounded-lg px-3 py-1.5 text-sm text-white outline-none"
                placeholder="Department (optional)"
                value={dept} onChange={e => setDept(e.target.value)}
              />
            </div>
            {error && <p className="text-xs text-rose-400">{error}</p>}
            <div className="flex gap-2">
              <button onClick={handleAdd} disabled={saving}
                className="flex-1 py-1.5 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 disabled:opacity-40 transition-colors">
                {saving ? 'Saving…' : 'Add Workstation'}
              </button>
              <button onClick={() => { setAdding(false); setError('') }} className="px-4 py-1.5 rounded-lg text-white/50 hover:text-white text-sm transition-colors">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 text-sm text-brand-400 hover:text-brand-300 transition-colors self-start">
            <Plus className="w-4 h-4" />Add workstation
          </button>
        )}
      </div>
    </div>
  )
}

// ── Production Flow Row ────────────────────────────────────────────────────────

interface FlowRowProps {
  flow: ProductionFlow
  workstationLoadMap: Map<number, WorkstationLoadResult>
  allWorkstations: Workstation[]
  threshold: number
  selectedWsId: number | null
  onSelectWs: (id: number) => void
  onFlowUpdated: (flow: ProductionFlow) => void
  onFlowDeleted: (id: number) => void
  onEditWorkstation: (wsId: number, updates: Record<string, unknown>) => void
}

function FlowRow({
  flow, workstationLoadMap, allWorkstations, threshold,
  selectedWsId, onSelectWs, onFlowUpdated, onFlowDeleted, onEditWorkstation,
}: FlowRowProps) {
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(flow.name)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const [showAddPicker, setShowAddPicker] = useState(false)

  const saveName = async () => {
    if (!nameDraft.trim()) return
    const updated = await updateFlow(flow.id, { name: nameDraft.trim() })
    onFlowUpdated(updated)
    setEditingName(false)
  }

  const reorder = async (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return
    const ids = [...flow.workstation_ids]
    const [moved] = ids.splice(fromIdx, 1)
    ids.splice(toIdx, 0, moved)
    const updated = await updateFlow(flow.id, { workstation_ids: ids })
    onFlowUpdated(updated)
  }

  const removeWs = async (idx: number) => {
    const ids = flow.workstation_ids.filter((_, i) => i !== idx)
    const updated = await updateFlow(flow.id, { workstation_ids: ids })
    onFlowUpdated(updated)
  }

  const addWs = async (wsId: number) => {
    const updated = await updateFlow(flow.id, { workstation_ids: [...flow.workstation_ids, wsId] })
    onFlowUpdated(updated)
    setShowAddPicker(false)
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Flow header */}
      <div className="flex items-center gap-2">
        {editingName ? (
          <div className="flex items-center gap-1">
            <input
              autoFocus
              className="bg-white/[0.06] border border-white/10 rounded-lg px-2.5 py-1 text-sm text-white outline-none focus:border-brand-400"
              value={nameDraft}
              onChange={e => setNameDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditingName(false) }}
            />
            <button onClick={saveName} className="p-1 text-brand-400 hover:text-brand-300"><Check className="w-3.5 h-3.5" /></button>
            <button onClick={() => setEditingName(false)} className="p-1 text-white/30 hover:text-white"><X className="w-3.5 h-3.5" /></button>
          </div>
        ) : (
          <button
            onClick={() => { setNameDraft(flow.name); setEditingName(true) }}
            className="text-sm font-semibold text-white/70 hover:text-white transition-colors flex items-center gap-1.5"
          >
            {flow.name}
            <Pencil className="w-3 h-3 text-white/25" />
          </button>
        )}
        <button
          onClick={() => deleteFlow(flow.id).then(() => onFlowDeleted(flow.id))}
          className="ml-auto p-1 text-white/15 hover:text-rose-400 transition-colors"
          title="Delete flow"
        ><Trash2 className="w-3.5 h-3.5" /></button>
      </div>

      {/* Workstation boxes — scrollable, no dropdowns inside */}
      <div className="flex items-center gap-0 overflow-x-auto pb-1">
        {flow.workstation_ids.length === 0 && (
          <p className="text-xs text-white/25 italic">No steps yet — use Add step below</p>
        )}
        {flow.workstation_ids.map((wsId, idx) => {
          const wsLoad = workstationLoadMap.get(wsId)
          if (!wsLoad) return null
          return (
            <div key={`${wsId}-${idx}`} className="flex items-center">
              {idx > 0 && (
                <div
                  className={`flex items-center self-center shrink-0 px-1 text-lg select-none transition-colors
                    ${dragOverIdx === idx ? 'text-brand-400' : 'text-white/20'}`}
                  onDragOver={e => { e.preventDefault(); setDragOverIdx(idx) }}
                  onDrop={() => { if (dragIdx !== null) reorder(dragIdx, idx); setDragIdx(null); setDragOverIdx(null) }}
                >→</div>
              )}
              <FlowBox
                ws={wsLoad}
                allWorkstations={allWorkstations}
                threshold={threshold}
                isSelected={selectedWsId === wsId}
                isDragging={dragIdx === idx}
                isDragOver={dragOverIdx === idx && dragIdx !== idx}
                onSelect={() => onSelectWs(wsId)}
                onEdit={updates => onEditWorkstation(wsId, updates as Record<string, unknown>)}
                onRemove={() => removeWs(idx)}
                onDragStart={() => setDragIdx(idx)}
                onDragOver={e => { e.preventDefault(); setDragOverIdx(idx) }}
                onDrop={() => { if (dragIdx !== null && dragIdx !== idx) reorder(dragIdx, idx); setDragIdx(null); setDragOverIdx(null) }}
                onDragEnd={() => { setDragIdx(null); setDragOverIdx(null) }}
              />
            </div>
          )
        })}
      </div>

      {/* Add step picker — OUTSIDE overflow container so it never gets clipped */}
      {showAddPicker ? (
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-[10px] text-white/30 uppercase tracking-wider mr-1">Add:</span>
          {allWorkstations.map(ws => (
            <button
              key={ws.id}
              onClick={() => addWs(ws.id)}
              className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-white/10 text-white/60 hover:text-white hover:border-brand-400/60 hover:bg-brand-500/10 transition-colors"
            >
              <Plus className="w-3 h-3" />{ws.name}
            </button>
          ))}
          <button onClick={() => setShowAddPicker(false)} className="text-xs text-white/25 hover:text-white/60 ml-1 transition-colors">
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setShowAddPicker(true)}
          className="self-start flex items-center gap-1 text-xs text-brand-400/70 hover:text-brand-400 border border-dashed border-brand-400/30 hover:border-brand-400/60 rounded-lg px-3 py-1.5 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />Add step
        </button>
      )}

    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

const HORIZON_OPTIONS = [
  { value: '8', label: '8 weeks' },
  { value: '12', label: '12 weeks' },
  { value: '16', label: '16 weeks' },
  { value: '26', label: '26 weeks' },
]

export default function ValueStreamMapping() {
  const [vsData, setVsData]           = useState<ValueStreamLoadResponse | null>(null)
  const [simulatedWs, setSimulatedWs] = useState<WorkstationLoadResult[] | null>(null)
  const [workstations, setWorkstations] = useState<Workstation[]>([])
  const [flows, setFlows]             = useState<ProductionFlow[]>([])
  const [mrpRuns, setMrpRuns]         = useState<MrpRun[]>([])
  const [selectedWsId, setSelectedWsId] = useState<number | null>(null)
  const [horizonWeeks, setHorizonWeeks] = useState(12)
  const [thresholdPct, setThresholdPct] = useState(0.85)
  const [hoursOverrides, setHoursOverrides] = useState<Record<number, number>>({})
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>()
  const [simulating, setSimulating]   = useState(false)
  const [simError, setSimError]       = useState<string | null>(null)
  const [loading, setLoading]         = useState(true)
  const [showManage, setShowManage]   = useState(false)

  const displayWorkstations: WorkstationLoadResult[] = simulatedWs ?? vsData?.workstations ?? []

  const workstationLoadMap = new Map(displayWorkstations.map(w => [w.workstation_id, w]))

  const loadAll = async (keepOverrides = false) => {
    setLoading(true)
    try {
      const [vsLoad, runs, ws, fl] = await Promise.all([
        getValueStreamLoad({ horizon_weeks: horizonWeeks, threshold_pct: thresholdPct, mrp_run_id: selectedRunId }),
        getMrpRuns(),
        getWorkstations(),
        getFlows(),
      ])
      setVsData(vsLoad)
      setMrpRuns(runs)
      setWorkstations(ws)
      setFlows(fl)
      setSimulatedWs(null)
      if (!keepOverrides) {
        const init: Record<number, number> = {}
        vsLoad.workstations.forEach((w: WorkstationLoadResult) => {
          init[w.workstation_id] = w.hours_per_day
        })
        setHoursOverrides(init)
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadAll() }, [horizonWeeks, thresholdPct, selectedRunId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSimulate = async () => {
    setSimulating(true)
    setSimError(null)
    try {
      const result = await simulateValueStream({
        mrp_run_id: selectedRunId,
        horizon_weeks: horizonWeeks,
        threshold_pct: thresholdPct,
        hours_per_day_overrides: hoursOverrides,
      })
      setSimulatedWs(result.workstations)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string }
      setSimError(err?.response?.data?.detail ?? err?.message ?? 'Simulation failed')
    } finally {
      setSimulating(false)
    }
  }

  const handleEditWorkstation = async (wsId: number, updates: Record<string, unknown>) => {
    await updateWorkstation(wsId, updates)
    await loadAll(true)
  }

  const handleFlowUpdated = (updated: ProductionFlow) => {
    setFlows(prev => prev.map(f => f.id === updated.id ? updated : f))
  }

  const handleFlowDeleted = (id: number) => {
    setFlows(prev => prev.filter(f => f.id !== id))
  }

  const handleAddFlow = async () => {
    const name = `Flow ${flows.length + 1}`
    const newFlow = await createFlow({ name, workstation_ids: [] })
    setFlows(prev => [...prev, newFlow])
  }

  // Chart data
  const chartData = (vsData?.weeks ?? []).map(wk => {
    const point: Record<string, number | string> = { week: wk.replace(/^\d{4}-/, '') }
    displayWorkstations.forEach(ws => {
      const wl = ws.weekly_loads.find(l => l.week_key === wk)
      point[ws.workstation_name] = wl ? wl.utilization_pct : 0
    })
    return point
  })

  const runOptions = [
    { value: '', label: 'Latest MRP run' },
    ...mrpRuns.map(r => ({ value: r.run_id, label: r.run_date ? `${r.run_date.slice(0, 10)} (${r.horizon_weeks}w)` : r.run_id })),
  ]

  // Sidebar
  useSidebarActionsEffect(
    <div className="flex flex-col gap-3">
      <p className="text-[9px] font-bold uppercase tracking-widest text-white/70">Controls</p>

      <div className="flex flex-col gap-1">
        <p className="text-[10px] text-white/40">MRP Run</p>
        <Select options={runOptions} value={selectedRunId ?? ''} onChange={v => setSelectedRunId(v || undefined)} />
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-[10px] text-white/40">Horizon</p>
        <Select options={HORIZON_OPTIONS} value={String(horizonWeeks)} onChange={v => setHorizonWeeks(parseInt(v))} />
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <p className="text-[10px] text-white/40">Bottleneck threshold</p>
          <span className="text-xs text-white font-medium">{(thresholdPct * 100).toFixed(0)}%</span>
        </div>
        <input type="range" min={50} max={100} step={1}
          value={thresholdPct * 100}
          onChange={e => setThresholdPct(parseInt(e.target.value) / 100)}
          className="w-full dark-slider"
          style={{ background: `linear-gradient(to right, #c46060 ${(thresholdPct * 100 - 50) / 50 * 100}%, rgba(255,255,255,0.12) ${(thresholdPct * 100 - 50) / 50 * 100}%)` }}
        />
      </div>

      <div className="border-t border-white/[0.07] pt-2" />
      <p className="text-[9px] font-bold uppercase tracking-widest text-white/70">Capacity Simulation</p>
      <p className="text-[10px] text-white/35">Simulate different operational hours/day</p>

      {displayWorkstations.map((ws, i) => {
        const hrs = hoursOverrides[ws.workstation_id] ?? ws.hours_per_day
        const simUnits = Math.round(hrs * 60 * ws.cycle_rate_units_per_min * ws.days_per_week)
        return (
          <div key={ws.workstation_id} className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-white/60 truncate max-w-[150px]" title={ws.workstation_name}>{ws.workstation_name}</span>
              <span className="text-[10px] text-white ml-2 shrink-0">{hrs}h/day</span>
            </div>
            <input
              type="range" min={1} max={24} step={0.5}
              value={hrs}
              onChange={e => setHoursOverrides(prev => ({ ...prev, [ws.workstation_id]: parseFloat(e.target.value) }))}
              className="w-full dark-slider"
              style={{ background: `linear-gradient(to right, ${VSM_COLORS[i % VSM_COLORS.length]} ${(hrs - 1) / 23 * 100}%, rgba(255,255,255,0.12) ${(hrs - 1) / 23 * 100}%)` }}
            />
            <p className="text-[10px] text-white/25">{simUnits} units/wk</p>
          </div>
        )
      })}

      <Button onClick={handleSimulate} disabled={simulating || displayWorkstations.length === 0} className="w-full mt-1">
        {simulating ? <Spinner className="h-4 w-4" /> : 'Run Simulation'}
      </Button>

      {simError && (
        <p className="text-xs text-rose-400 text-center">{simError}</p>
      )}

      {simulatedWs && (
        <button
          onClick={() => { setSimulatedWs(null); setSimError(null) }}
          className="text-xs text-white/40 hover:text-white/70 text-center transition-colors"
        >
          Clear simulation
        </button>
      )}

      {(vsData?.unassigned_products.length ?? 0) > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-2 text-xs text-amber-300 flex gap-1.5 items-start">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{vsData!.unassigned_products.length} top-level item{vsData!.unassigned_products.length !== 1 ? 's' : ''} have no production flow</span>
        </div>
      )}
    </div>,
    [displayWorkstations, hoursOverrides, horizonWeeks, thresholdPct, selectedRunId, simulating, simulatedWs, vsData, mrpRuns, simError]
  )

  if (loading) return <Spinner className="h-64" />

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <PageHeader title="Value Stream Mapping" />
        <button
          onClick={() => setShowManage(true)}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-white/10 text-white/60 hover:text-white hover:border-white/20 transition-colors"
        >
          <Settings className="w-3.5 h-3.5" />Manage Workstations
        </button>
      </div>

      {simulatedWs && (
        <div className="bg-brand-500/10 border border-brand-400/30 rounded-xl px-4 py-2.5 text-sm text-brand-300 flex items-center gap-2">
          <span className="font-medium">Simulation active</span>
          <span className="text-white/40">— showing adjusted shift capacity</span>
          <button onClick={() => setSimulatedWs(null)} className="ml-auto text-white/30 hover:text-white transition-colors text-lg leading-none">×</button>
        </div>
      )}

      {/* Section 1: Weekly Utilisation Chart (TOP) */}
      {displayWorkstations.length > 0 && chartData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Weekly Utilisation by Workstation</CardTitle>
          </CardHeader>
          <div className="px-6 pb-6">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} barCategoryGap="20%" barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="week" tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis
                  tickFormatter={v => `${(v * 100).toFixed(0)}%`}
                  domain={[0, Math.max(1, ...displayWorkstations.map(w => w.peak_utilization_pct))]}
                  tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 11 }}
                  axisLine={false} tickLine={false}
                />
                <Tooltip content={<VsmTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)', stroke: 'rgba(255,255,255,0.07)', strokeWidth: 1, radius: [4, 4, 4, 4] as unknown as number }} />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} formatter={(v) => <span style={{ color: 'rgba(255,255,255,0.75)' }}>{v}</span>} />
                <ReferenceLine
                  y={thresholdPct}
                  stroke="#c46060"
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  label={{ value: `${(thresholdPct * 100).toFixed(0)}% threshold`, fill: '#e07070', fontSize: 11, fontWeight: 700, position: 'insideTopRight' }}
                />
                {displayWorkstations.map((ws, i) => (
                  <Bar
                    key={ws.workstation_id}
                    dataKey={ws.workstation_name}
                    fill={VSM_COLORS[i % VSM_COLORS.length]}
                    radius={[3, 3, 0, 0]}
                    onClick={() => setSelectedWsId(selectedWsId === ws.workstation_id ? null : ws.workstation_id)}
                    style={{ cursor: 'pointer' }}
                    opacity={selectedWsId === null || selectedWsId === ws.workstation_id ? 1 : 0.3}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {/* Section 2: Production Flows */}
      <Card>
        <CardHeader>
          <CardTitle>Production Flows</CardTitle>
          <button
            onClick={handleAddFlow}
            className="ml-auto flex items-center gap-1.5 text-xs text-brand-400 hover:text-brand-300 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />Add Flow
          </button>
        </CardHeader>

        {displayWorkstations.length === 0 ? (
          <div className="px-6 pb-6 text-sm text-white/30 italic">
            No workstations configured. Click <strong>Manage Workstations</strong> to add them, then assign top-level BOM items on the <strong>Bill of Materials</strong> page.
          </div>
        ) : flows.length === 0 ? (
          <div className="px-6 pb-6 text-sm text-white/30 italic">
            No flows yet. Click <strong>+ Add Flow</strong> to create a production flow and drag workstations into sequence.
          </div>
        ) : (
          <div className="px-6 pb-6 flex flex-col gap-6">
            {flows.map(flow => (
              <FlowRow
                key={flow.id}
                flow={flow}
                workstationLoadMap={workstationLoadMap}
                allWorkstations={workstations}
                threshold={thresholdPct}
                selectedWsId={selectedWsId}
                onSelectWs={id => setSelectedWsId(selectedWsId === id ? null : id)}
                onFlowUpdated={handleFlowUpdated}
                onFlowDeleted={handleFlowDeleted}
                onEditWorkstation={handleEditWorkstation}
              />
            ))}
          </div>
        )}
      </Card>

      {/* Section 3: Detail Table */}
      <Card>
        <CardHeader>
          <CardTitle>
            {selectedWsId !== null
              ? `${displayWorkstations.find(w => w.workstation_id === selectedWsId)?.workstation_name ?? ''} — Weekly Detail`
              : 'Workstation Summary'}
          </CardTitle>
          {selectedWsId !== null && (
            <button onClick={() => setSelectedWsId(null)} className="text-xs text-white/40 hover:text-white/70 ml-auto transition-colors">
              Show all
            </button>
          )}
        </CardHeader>
        {displayWorkstations.length === 0 ? (
          <div className="px-6 pb-6 text-sm text-white/30 italic">No data.</div>
        ) : (
          <DetailTable workstations={displayWorkstations} selectedWsId={selectedWsId} threshold={thresholdPct} />
        )}
      </Card>

      {showManage && (
        <ManageWorkstationsModal
          workstations={workstations}
          onClose={() => setShowManage(false)}
          onChanged={async () => {
            const ws = await getWorkstations()
            setWorkstations(ws)
            await loadAll(true)
          }}
        />
      )}
    </div>
  )
}
