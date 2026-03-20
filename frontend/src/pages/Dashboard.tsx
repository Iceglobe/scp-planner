import { useEffect, useState } from 'react'
import { Package, ShoppingCart, AlertTriangle, CheckSquare } from 'lucide-react'
import { getKpis, getInventoryAlerts, getInventoryTrend, getDemandTrend } from '../api'
import type { Kpis, TrendPoint } from '../api/types'
import { KpiCard, Card, CardHeader, CardTitle, Badge, Spinner, PageHeader, AbcBadge } from '../components/ui'
import { InventoryTrendChart, DemandTrendChart } from '../components/charts/TrendChart'
import { fmtCurrency, fmtNumber } from '../utils/formatters'

export default function Dashboard() {
  const [kpis, setKpis] = useState<Kpis | null>(null)
  const [alerts, setAlerts] = useState<Record<string, unknown>[]>([])
  const [invTrendData, setInvTrendData] = useState<TrendPoint[]>([])
  const [demTrendData, setDemTrendData] = useState<TrendPoint[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      getKpis(),
      getInventoryAlerts(),
      getInventoryTrend(12),
      getDemandTrend(12),
    ]).then(([k, a, it, dt]) => {
      setKpis(k); setAlerts(a); setInvTrendData(it); setDemTrendData(dt)
    }).finally(() => setLoading(false))
  }, [])

  if (loading) return <Spinner className="h-64" />

  return (
    <div>
      <PageHeader
        title="Executive Dashboard"
        description="Live supply chain overview and risk monitor"
      />

      {/* KPI row */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        <KpiCard
          label="Inventory Value"
          value={fmtCurrency(kpis?.inventory_value)}
          sub={`${kpis?.total_products} active SKUs`}
          icon={Package}
        />
        <KpiCard
          label="Confirmed POs"
          value={fmtCurrency(kpis?.confirmed_po_value)}
          sub="confirmed + in transit"
          icon={CheckSquare}
        />
        <KpiCard
          label="All Open POs"
          value={`${kpis?.open_po_count ?? 0}`}
          sub={fmtCurrency(kpis?.open_po_value) + ' total value'}
          icon={ShoppingCart}
        />
        <KpiCard
          label="Items at Risk"
          value={`${kpis?.items_at_risk ?? 0}`}
          sub="below safety stock"
          icon={AlertTriangle}
          alert={(kpis?.items_at_risk ?? 0) > 0}
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-2 gap-6 mb-6">
        <Card>
          <CardHeader>
            <CardTitle>Inventory Value — hist. + projected (DKK)</CardTitle>
          </CardHeader>
          <InventoryTrendChart data={invTrendData} />
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Demand Revenue — hist. + forecasted (DKK)</CardTitle>
          </CardHeader>
          <DemandTrendChart data={demTrendData} />
        </Card>
      </div>

      {/* Risk alerts */}
      <Card className="p-0 overflow-hidden">
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <h3 className="text-[11px] font-medium uppercase tracking-widest text-white">Risk Alerts</h3>
          <span className="text-xs text-white/70">{alerts.length} items below safety stock</span>
        </div>
        {alerts.length === 0 ? (
          <div className="py-12 text-center text-white/70 text-sm">No active alerts</div>
        ) : (
          <div className="divide-y divide-zinc-50">
            {alerts.map((a, i) => (
              <div key={i} className="flex items-center justify-between px-5 py-3 hover:bg-white/[0.06]">
                <div className="flex items-center gap-3">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${a.severity === 'red' ? 'bg-red-500' : 'bg-orange-400'}`} />
                  <div>
                    <span className="text-[11px] font-mono text-white/70 mr-2">{a.sku as string}</span>
                    <span className="text-sm text-white">{a.description as string}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-xs text-white/70 flex-shrink-0">
                  <AbcBadge cls={a.abc_class as string} />
                  <span>pos: <b className="text-white">{fmtNumber(a.position as number)}</b></span>
                  <span>SS: <b className="text-orange-500">{fmtNumber(a.safety_stock_qty as number)}</b></span>
                  <Badge variant={a.severity === 'red' ? 'danger' : 'warning'}>
                    {a.severity as string}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
