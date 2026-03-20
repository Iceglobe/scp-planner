import { NavLink } from 'react-router-dom'
import { useEffect, useState } from 'react'
import {
  LayoutDashboard, Package, TrendingUp, ShoppingCart,
  Warehouse, Database,
} from 'lucide-react'
import { useSidebarActions } from '../../context/SidebarActionsContext'
import { useFilters } from '../../context/FilterContext'
import { MultiSelect } from '../ui/MultiSelect'

const nav = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/demand-planning', label: 'Demand Planning', icon: TrendingUp },
  { to: '/supply-planning', label: 'Supply Planning', icon: ShoppingCart },
  { to: '/inventory', label: 'Inventory', icon: Warehouse },
  { to: '/master-data', label: 'Master Data', icon: Package },
  { to: '/data-sources', label: 'Data Sources', icon: Database },
]

export function Sidebar() {
  const { actions } = useSidebarActions()
  const { itemIds, setItemIds, productNames, setProductNames } = useFilters()
  const [skuOptions, setSkuOptions] = useState<string[]>([])
  const [nameOptions, setNameOptions] = useState<string[]>([])

  useEffect(() => {
    fetch('/api/products')
      .then(r => r.json())
      .then((data: { sku: string; description: string }[]) => {
        setSkuOptions(data.map(p => p.sku).sort())
        setNameOptions([...new Set(data.map(p => p.description).filter(Boolean))].sort())
      })
      .catch(() => {})
  }, [])

  return (
    <aside className="w-[312px] shrink-0 border-r border-white/20 flex flex-col h-full sticky top-0 glass-light">
      {/* Logo */}
      <div className="px-6 py-6">
        <div className="flex items-center gap-2.5">
          <svg width="24" height="24" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="18" cy="8" r="3" fill="#4ade80"/>
            <circle cx="7" cy="27" r="3" fill="#4ade80" opacity="0.8"/>
            <circle cx="29" cy="27" r="3" fill="#4ade80" opacity="0.8"/>
            <line x1="18" y1="8" x2="7" y2="27" stroke="#4ade80" stroke-width="1.5" stroke-linecap="round" stroke-opacity="0.6"/>
            <line x1="18" y1="8" x2="29" y2="27" stroke="#4ade80" stroke-width="1.5" stroke-linecap="round" stroke-opacity="0.6"/>
            <line x1="7" y1="27" x2="29" y2="27" stroke="#4ade80" stroke-width="1.5" stroke-linecap="round" stroke-opacity="0.4"/>
          </svg>
          <span className="text-sm font-bold text-white tracking-tight">AugmentedPlanning</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="px-3 space-y-0.5">
        {nav.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-all duration-200 ${
                isActive
                  ? 'text-white font-bold bg-white/10'
                  : 'text-white/80 hover:text-white hover:bg-white/[0.06]'
              }`
            }
          >
            <Icon className="w-4 h-4 shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Global filters */}
      <div className="mx-4 mt-4 border-t border-white/5" />
      <div className="px-5 pt-4 pb-2 flex flex-col items-start">
        <p className="w-3/4 text-[9px] font-bold uppercase tracking-widest text-white/70 mb-2">Filters</p>
        <div className="w-full flex flex-col items-start gap-1.5">
          <MultiSelect
            options={skuOptions}
            value={itemIds}
            onChange={setItemIds}
            placeholder="Item ID…"
          />
          <MultiSelect
            options={nameOptions}
            value={productNames}
            onChange={setProductNames}
            placeholder="Product name…"
          />
        </div>
      </div>

      {/* Contextual page actions */}
      {actions && (
        <>
          <div className="mx-4 mt-3 border-t border-white/5" />
          <div className="px-5 pt-4 pb-4 overflow-y-auto flex-1">
            {actions}
          </div>
        </>
      )}

      {/* Footer */}
      <div className="px-6 py-4 mt-auto">
        <p className="text-[10px] text-white/50 font-medium">v1.0.0</p>
      </div>
    </aside>
  )
}
