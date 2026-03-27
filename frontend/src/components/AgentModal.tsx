import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { executeAgentAction } from '../api'

// ── Types ────────────────────────────────────────────────────────────────────

interface InvFinding {
  sku: string
  description: string
  abc_class?: string
  status: string
  position: number
  safety_stock: number
  days_of_supply?: number
  root_cause: string
  action_plan: string
  urgency: string
  related_po_ids?: number[]
}

interface PoItem {
  po_id: number
  sku: string
  quantity: number
  due_date: string
  total_value: number
  recommendation: string
  reasoning: string
}

interface PoGroup {
  supplier: string
  items: PoItem[]
}

interface AgentAction {
  id: string
  title: string
  description: string
  type: string
  params: Record<string, unknown>
  priority: string
  estimated_impact: string
}

export interface AgentAnalysis {
  executive_summary: string
  inventory_health: {
    overall_status: string
    findings: InvFinding[]
  }
  po_review: {
    total_pos: number
    total_value: number
    overall_recommendation: string
    summary: string
    groups: PoGroup[]
  }
  actions: AgentAction[]
  _context: {
    today: string
    kpis: {
      total_products: number
      stockout_count: number
      below_safety_stock_count: number
      total_inventory_value: number
      suggested_po_count: number
      suggested_po_value: number
    }
    latest_mrp: { run_date: string; horizon_weeks: number } | null
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return new Intl.NumberFormat('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n)
}

function fmtCcy(n: number) {
  return '£' + fmt(n)
}

const URGENCY_COLORS: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-300 border-red-500/30',
  high:     'bg-orange-500/20 text-orange-300 border-orange-500/30',
  medium:   'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  low:      'bg-blue-500/20 text-blue-300 border-blue-500/30',
}

const STATUS_COLORS: Record<string, string> = {
  stockout:            'text-red-400',
  projected_stockout:  'text-orange-400',
  below_safety_stock:  'text-yellow-400',
  healthy:             'text-emerald-400',
  overstocked:         'text-zinc-400',
  excess:              'text-zinc-400',
}

const STATUS_LABELS: Record<string, string> = {
  stockout:            'Stockout',
  projected_stockout:  'Proj. Stockout',
  below_safety_stock:  'Below SS',
  healthy:             'Healthy',
  overstocked:         'Excess',
  excess:              'Excess',
}

const PRIORITY_ICON: Record<string, string> = {
  critical: '🔴',
  high:     '🟠',
  medium:   '🟡',
  low:      '🔵',
}

function StockBar({ position, safetyStock }: { position: number; safetyStock: number }) {
  const max = Math.max(safetyStock * 3, position, 10)
  const ssWidth = Math.min(100, (safetyStock / max) * 100)
  const posWidth = Math.min(100, (Math.max(0, position) / max) * 100)
  const isLow = position <= 0 || position < safetyStock

  return (
    <div className="relative h-2 bg-white/10 rounded-full w-24 overflow-visible">
      {/* Safety stock marker */}
      <div
        className="absolute top-0 bottom-0 w-px bg-yellow-400/60 z-10"
        style={{ left: `${ssWidth}%` }}
        title={`Safety stock: ${fmt(safetyStock)}`}
      />
      {/* Position bar */}
      <div
        className={`h-full rounded-full transition-all ${isLow ? 'bg-red-400' : 'bg-emerald-400'}`}
        style={{ width: `${posWidth}%` }}
      />
    </div>
  )
}

// ── Sub-sections ─────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h3 className="text-xs font-bold uppercase tracking-widest text-white/40 mb-3">{title}</h3>
      {children}
    </div>
  )
}

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="glass-light border border-white/10 rounded-xl px-4 py-3">
      <div className="text-lg font-semibold text-white">{value}</div>
      <div className="text-xs text-white/50 mt-0.5">{label}</div>
      {sub && <div className="text-xs text-white/30 mt-0.5">{sub}</div>}
    </div>
  )
}

// ── Main modal ───────────────────────────────────────────────────────────────

interface Props {
  analysis: AgentAnalysis | null
  isLoading: boolean
  error: string | null
  onClose: () => void
  onRerun: () => void
}

export function AgentModal({ analysis, isLoading, error, onClose, onRerun }: Props) {
  // Track which action IDs the user has approved / skipped
  const [approved, setApproved] = useState<Set<string>>(new Set())
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const [executing, setExecuting] = useState(false)
  const [execResults, setExecResults] = useState<Record<string, string>>({})
  const [activeTab, setActiveTab] = useState<'summary' | 'inventory' | 'pos' | 'actions'>('summary')

  // Reset state when new analysis arrives
  useEffect(() => {
    if (analysis) {
      setApproved(new Set())
      setSkipped(new Set())
      setExecResults({})
      setActiveTab('summary')
    }
  }, [analysis])

  const toggleApprove = useCallback((id: string) => {
    setApproved(prev => {
      const next = new Set(prev)
      if (next.has(id)) { next.delete(id) } else { next.add(id); setSkipped(s => { const n2 = new Set(s); n2.delete(id); return n2 }) }
      return next
    })
  }, [])

  const toggleSkip = useCallback((id: string) => {
    setSkipped(prev => {
      const next = new Set(prev)
      if (next.has(id)) { next.delete(id) } else { next.add(id); setApproved(a => { const n2 = new Set(a); n2.delete(id); return n2 }) }
      return next
    })
  }, [])

  async function handleExecute() {
    if (!analysis) return
    setExecuting(true)
    const results: Record<string, string> = {}
    for (const action of analysis.actions) {
      if (!approved.has(action.id)) continue
      try {
        const res = await executeAgentAction(action.type, action.params)
        results[action.id] = res.message || `Done (${JSON.stringify(res)})`
      } catch (e: unknown) {
        const err = e as { response?: { data?: { detail?: string } }; message?: string }
        results[action.id] = `Error: ${err?.response?.data?.detail ?? err?.message ?? 'Unknown error'}`
      }
    }
    setExecResults(results)
    setExecuting(false)
  }

  const approvedCount = approved.size
  const hasResults = Object.keys(execResults).length > 0

  const modal = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)' }}
    >
      <div
        className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-2xl border border-white/15 shadow-2xl"
        style={{ background: 'rgba(10,10,20,0.95)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-white/10 flex items-center justify-center">
              <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="1.8">
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">AI Supply Planner</h2>
              {analysis && (
                <p className="text-xs text-white/40">
                  Analysis as of {analysis._context.today}
                  {analysis._context.latest_mrp && ` · MRP horizon ${analysis._context.latest_mrp.horizon_weeks}w`}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {analysis && !isLoading && (
              <button
                onClick={onRerun}
                className="text-xs text-white/50 hover:text-white px-3 py-1.5 rounded-lg
                           border border-white/10 hover:border-white/20 transition-colors"
              >
                Re-run
              </button>
            )}
            <button
              onClick={onClose}
              className="w-7 h-7 rounded-lg hover:bg-white/10 flex items-center justify-center
                         text-white/50 hover:text-white transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Loading state */}
        {isLoading && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 py-20">
            <div className="relative">
              <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center">
                <svg className="w-8 h-8 animate-spin text-white/30" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              </div>
            </div>
            <div className="text-center">
              <p className="text-white/70 font-medium text-sm">Analysing your supply chain…</p>
              <p className="text-white/30 text-xs mt-1">Reviewing inventory, POs and forecasts</p>
            </div>
          </div>
        )}

        {/* Error state */}
        {!isLoading && error && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 py-16 px-8">
            <div className="w-12 h-12 rounded-xl bg-red-500/10 flex items-center justify-center">
              <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15.75h.007v.008H12v-.008z" />
              </svg>
            </div>
            <div className="text-center">
              <p className="text-red-300 font-medium text-sm">Analysis failed</p>
              <p className="text-white/40 text-xs mt-2 max-w-sm">{error}</p>
            </div>
            <button
              onClick={onRerun}
              className="px-4 py-2 text-sm bg-white/10 hover:bg-white/15 border border-white/15
                         rounded-xl text-white transition-colors"
            >
              Try again
            </button>
          </div>
        )}

        {/* Analysis content */}
        {!isLoading && !error && analysis && (
          <>
            {/* Tab bar */}
            <div className="flex items-center gap-1 px-6 pt-3 pb-0 shrink-0">
              {(
                [
                  { key: 'summary', label: 'Summary' },
                  {
                    key: 'inventory',
                    label: `Inventory ${analysis.inventory_health.findings.length > 0 ? `(${analysis.inventory_health.findings.length})` : ''}`,
                  },
                  { key: 'pos', label: `POs (${analysis.po_review.total_pos})` },
                  { key: 'actions', label: `Actions (${analysis.actions.length})` },
                ] as const
              ).map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`px-4 py-2 text-xs font-medium rounded-t-lg border-b-2 transition-colors
                    ${activeTab === tab.key
                      ? 'border-white text-white'
                      : 'border-transparent text-white/40 hover:text-white/70'}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="h-px bg-white/10 shrink-0 mx-0" />

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto px-6 py-5">

              {/* ── Summary tab ──────────────────────────────────────── */}
              {activeTab === 'summary' && (
                <>
                  {/* Overall status badge */}
                  <div className="flex items-center gap-2 mb-4">
                    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border
                      ${analysis.inventory_health.overall_status === 'critical'
                        ? 'bg-red-500/20 text-red-300 border-red-500/30'
                        : analysis.inventory_health.overall_status === 'warning'
                          ? 'bg-orange-500/20 text-orange-300 border-orange-500/30'
                          : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full inline-block
                        ${analysis.inventory_health.overall_status === 'critical' ? 'bg-red-400'
                          : analysis.inventory_health.overall_status === 'warning' ? 'bg-orange-400'
                          : 'bg-emerald-400'}`} />
                      {analysis.inventory_health.overall_status.toUpperCase()}
                    </span>
                  </div>

                  {/* Executive summary */}
                  <div className="glass-light border border-white/10 rounded-xl p-4 mb-5">
                    <p className="text-sm text-white/80 leading-relaxed">
                      {analysis.executive_summary}
                    </p>
                  </div>

                  {/* KPI cards */}
                  <Section title="Snapshot">
                    <div className="grid grid-cols-3 gap-3">
                      <KpiCard
                        label="Inventory Value"
                        value={fmtCcy(analysis._context.kpis.total_inventory_value)}
                        sub={`${analysis._context.kpis.total_products} active SKUs`}
                      />
                      <KpiCard
                        label="At Risk"
                        value={String(
                          analysis._context.kpis.stockout_count +
                          analysis._context.kpis.below_safety_stock_count
                        )}
                        sub={`${analysis._context.kpis.stockout_count} stockout · ${analysis._context.kpis.below_safety_stock_count} below SS`}
                      />
                      <KpiCard
                        label="Suggested POs"
                        value={fmtCcy(analysis._context.kpis.suggested_po_value)}
                        sub={`${analysis._context.kpis.suggested_po_count} purchase orders`}
                      />
                    </div>
                  </Section>

                  {/* Quick action buttons */}
                  {analysis.actions.length > 0 && (
                    <Section title="Recommended Actions">
                      <div className="space-y-2">
                        {analysis.actions.slice(0, 3).map(action => (
                          <div
                            key={action.id}
                            className="flex items-start gap-3 glass-light border border-white/10
                                       rounded-xl px-4 py-3"
                          >
                            <span className="text-base mt-0.5">{PRIORITY_ICON[action.priority] ?? '⚪'}</span>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-white">{action.title}</p>
                              <p className="text-xs text-white/50 mt-0.5">{action.estimated_impact}</p>
                            </div>
                            <button
                              onClick={() => { setActiveTab('actions') }}
                              className="text-xs text-white/40 hover:text-white/70 shrink-0"
                            >
                              Review →
                            </button>
                          </div>
                        ))}
                      </div>
                    </Section>
                  )}
                </>
              )}

              {/* ── Inventory tab ─────────────────────────────────────── */}
              {activeTab === 'inventory' && (
                <>
                  {analysis.inventory_health.findings.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-center">
                      <div className="text-3xl mb-3">✅</div>
                      <p className="text-white/60 text-sm">All inventory positions are healthy.</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {analysis.inventory_health.findings.map((f, i) => (
                        <div
                          key={i}
                          className="glass-light border border-white/10 rounded-xl p-4"
                        >
                          <div className="flex items-start justify-between gap-3 mb-3">
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-sm text-white font-medium">{f.sku}</span>
                                {f.abc_class && (
                                  <span className="text-xs bg-white/10 px-1.5 py-0.5 rounded text-white/60">
                                    {f.abc_class}
                                  </span>
                                )}
                                <span className={`text-xs font-medium ${STATUS_COLORS[f.status] ?? 'text-white/60'}`}>
                                  {STATUS_LABELS[f.status] ?? f.status}
                                </span>
                              </div>
                              <p className="text-xs text-white/50 mt-0.5">{f.description}</p>
                            </div>
                            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium shrink-0
                              ${URGENCY_COLORS[f.urgency] ?? 'bg-white/10 text-white/50 border-white/10'}`}>
                              {f.urgency}
                            </span>
                          </div>

                          {/* Stock bar */}
                          <div className="flex items-center gap-3 mb-3">
                            <StockBar position={f.position} safetyStock={f.safety_stock} />
                            <span className="text-xs text-white/50">
                              {fmt(f.position)} / SS {fmt(f.safety_stock)}
                              {f.days_of_supply != null && ` · ${f.days_of_supply}d supply`}
                            </span>
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <p className="text-xs text-white/30 uppercase tracking-wide mb-1">Root Cause</p>
                              <p className="text-xs text-white/70">{f.root_cause}</p>
                            </div>
                            <div>
                              <p className="text-xs text-white/30 uppercase tracking-wide mb-1">Action Plan</p>
                              <p className="text-xs text-white/70">{f.action_plan}</p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* ── POs tab ────────────────────────────────────────────── */}
              {activeTab === 'pos' && (
                <>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="glass-light border border-white/10 rounded-xl px-4 py-2 text-xs text-white/60">
                      {analysis.po_review.total_pos} suggested POs · {fmtCcy(analysis.po_review.total_value)} total
                    </div>
                    <span className={`text-xs px-3 py-1.5 rounded-full border font-medium
                      ${analysis.po_review.overall_recommendation === 'approve_all'
                        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                        : analysis.po_review.overall_recommendation === 'defer'
                          ? 'bg-blue-500/20 text-blue-300 border-blue-500/30'
                          : 'bg-orange-500/20 text-orange-300 border-orange-500/30'}`}>
                      {analysis.po_review.overall_recommendation.replace('_', ' ')}
                    </span>
                  </div>
                  <p className="text-xs text-white/50 mb-4">{analysis.po_review.summary}</p>

                  {analysis.po_review.groups.length === 0 ? (
                    <div className="text-center py-12 text-white/40 text-sm">No suggested POs in latest MRP.</div>
                  ) : (
                    <div className="space-y-4">
                      {analysis.po_review.groups.map((g, gi) => (
                        <div key={gi} className="glass-light border border-white/10 rounded-xl overflow-hidden">
                          <div className="px-4 py-2.5 border-b border-white/10">
                            <p className="text-xs font-semibold text-white/70">{g.supplier || 'Unknown Supplier'}</p>
                          </div>
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b border-white/5">
                                <th className="px-4 py-2 text-left text-white/30 font-normal">SKU</th>
                                <th className="px-4 py-2 text-right text-white/30 font-normal">Qty</th>
                                <th className="px-4 py-2 text-right text-white/30 font-normal">Value</th>
                                <th className="px-4 py-2 text-left text-white/30 font-normal">Due</th>
                                <th className="px-4 py-2 text-left text-white/30 font-normal">Rec.</th>
                                <th className="px-4 py-2 text-left text-white/30 font-normal">Reasoning</th>
                              </tr>
                            </thead>
                            <tbody>
                              {g.items.map((item, ii) => (
                                <tr key={ii} className="border-b border-white/5 last:border-0 hover:bg-white/5">
                                  <td className="px-4 py-2.5 font-mono text-white/80">{item.sku}</td>
                                  <td className="px-4 py-2.5 text-right text-white/70">{fmt(item.quantity)}</td>
                                  <td className="px-4 py-2.5 text-right text-white/70">{fmtCcy(item.total_value)}</td>
                                  <td className="px-4 py-2.5 text-white/60">{item.due_date}</td>
                                  <td className="px-4 py-2.5">
                                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium
                                      ${item.recommendation === 'approve'
                                        ? 'bg-emerald-500/20 text-emerald-300'
                                        : item.recommendation === 'defer'
                                          ? 'bg-blue-500/20 text-blue-300'
                                          : 'bg-yellow-500/20 text-yellow-300'}`}>
                                      {item.recommendation}
                                    </span>
                                  </td>
                                  <td className="px-4 py-2.5 text-white/40 max-w-xs truncate"
                                    title={item.reasoning}>
                                    {item.reasoning}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* ── Actions tab ───────────────────────────────────────── */}
              {activeTab === 'actions' && (
                <>
                  {hasResults && (
                    <div className="glass-light border border-emerald-500/20 rounded-xl p-4 mb-4">
                      <p className="text-xs font-semibold text-emerald-400 mb-2">Execution Results</p>
                      {Object.entries(execResults).map(([id, msg]) => (
                        <p key={id} className="text-xs text-white/60 mb-1">
                          <span className="text-white/30">{id}: </span>{msg}
                        </p>
                      ))}
                    </div>
                  )}

                  <div className="space-y-3 mb-4">
                    {analysis.actions.map(action => {
                      const isApproved = approved.has(action.id)
                      const isSkipped = skipped.has(action.id)
                      const result = execResults[action.id]
                      return (
                        <div
                          key={action.id}
                          className={`glass-light border rounded-xl p-4 transition-colors
                            ${isApproved ? 'border-emerald-500/30 bg-emerald-500/5'
                              : isSkipped ? 'border-white/5 opacity-50'
                              : 'border-white/10'}`}
                        >
                          <div className="flex items-start gap-3">
                            <span className="text-lg shrink-0">{PRIORITY_ICON[action.priority] ?? '⚪'}</span>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start justify-between gap-2">
                                <p className="text-sm font-medium text-white">{action.title}</p>
                                <span className={`text-xs px-2 py-0.5 rounded-full border shrink-0
                                  ${URGENCY_COLORS[action.priority] ?? 'bg-white/10 text-white/50 border-white/10'}`}>
                                  {action.priority}
                                </span>
                              </div>
                              <p className="text-xs text-white/50 mt-1">{action.description}</p>
                              {action.estimated_impact && (
                                <p className="text-xs text-white/30 mt-1 italic">{action.estimated_impact}</p>
                              )}
                              {result && (
                                <p className="text-xs text-emerald-400 mt-2">✓ {result}</p>
                              )}
                            </div>
                          </div>
                          {!result && (
                            <div className="flex gap-2 mt-3 ml-8">
                              <button
                                onClick={() => toggleApprove(action.id)}
                                className={`px-3 py-1.5 text-xs rounded-lg border transition-colors
                                  ${isApproved
                                    ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                                    : 'border-white/15 text-white/50 hover:border-emerald-500/30 hover:text-emerald-300'}`}
                              >
                                {isApproved ? '✓ Approved' : 'Approve'}
                              </button>
                              <button
                                onClick={() => toggleSkip(action.id)}
                                className={`px-3 py-1.5 text-xs rounded-lg border transition-colors
                                  ${isSkipped
                                    ? 'border-white/15 text-white/30'
                                    : 'border-white/10 text-white/30 hover:border-white/20 hover:text-white/50'}`}
                              >
                                Skip
                              </button>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </div>

            {/* Footer */}
            {activeTab === 'actions' && (
              <div className="px-6 py-4 border-t border-white/10 shrink-0 flex items-center justify-between gap-3">
                <p className="text-xs text-white/30">
                  {approvedCount} action{approvedCount !== 1 ? 's' : ''} approved
                </p>
                <button
                  onClick={handleExecute}
                  disabled={approvedCount === 0 || executing || hasResults}
                  className="px-5 py-2 text-sm font-medium rounded-xl border transition-all
                             disabled:opacity-40 disabled:cursor-not-allowed
                             bg-white/10 border-white/20 hover:bg-white/15 text-white"
                >
                  {executing
                    ? 'Executing…'
                    : hasResults
                      ? 'Done'
                      : `Execute ${approvedCount > 0 ? approvedCount : ''} Action${approvedCount !== 1 ? 's' : ''}`}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}
