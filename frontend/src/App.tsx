import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Component, ReactNode } from 'react'
import { Sidebar } from './components/layout/Sidebar'
import { SidebarActionsProvider } from './context/SidebarActionsContext'
import { FilterProvider } from './context/FilterContext'
import Dashboard from './pages/Dashboard'
import MasterData from './pages/MasterData'
import DemandPlanning from './pages/DemandPlanning'
import SupplyPlanning from './pages/SupplyPlanning'
import InventoryPage from './pages/Inventory'
import DataSources from './pages/DataSources'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div className="p-8 text-red-700 bg-red-50 rounded-lg m-8">
          <h2 className="text-base font-semibold mb-2">Page Error</h2>
          <pre className="text-xs whitespace-pre-wrap">{(this.state.error as Error).message}</pre>
          <pre className="text-xs whitespace-pre-wrap mt-2 text-red-400">{(this.state.error as Error).stack}</pre>
          <button className="mt-4 text-xs underline" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  return (
    <BrowserRouter>
      <FilterProvider>
      <SidebarActionsProvider>
      {/* Outer background shell */}
      <div className="h-screen app-shell py-8 px-12">
        {/* Floating window */}
        <div className="flex h-full rounded-2xl overflow-hidden glass shadow-2xl border border-white/30">
          <Sidebar />
          <main className="flex-1 overflow-y-auto">
            <div className="w-full px-8 py-8">
              <ErrorBoundary>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/master-data" element={<MasterData />} />
                  <Route path="/demand-planning" element={<DemandPlanning />} />
                  <Route path="/supply-planning" element={<SupplyPlanning />} />
                  <Route path="/inventory" element={<InventoryPage />} />
                  <Route path="/data-sources" element={<DataSources />} />
                </Routes>
              </ErrorBoundary>
            </div>
          </main>
        </div>
      </div>
      </SidebarActionsProvider>
      </FilterProvider>
    </BrowserRouter>
  )
}
