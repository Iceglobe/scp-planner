import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { Component, ReactNode, useState, useCallback } from 'react'
import { Sidebar } from './components/layout/Sidebar'
import { AgentButton } from './components/AgentButton'
import { AgentModal, type AgentAnalysis } from './components/AgentModal'
import { SidebarActionsProvider } from './context/SidebarActionsContext'
import { FilterProvider } from './context/FilterContext'
import { runAgent } from './api'
import Dashboard from './pages/Dashboard'
import MasterData from './pages/MasterData'
import DemandPlanning from './pages/DemandPlanning'
import SupplyPlanning from './pages/SupplyPlanning'
import InventoryPage from './pages/Inventory'
import DataSources from './pages/DataSources'
import BOM from './pages/BOM'
import ValueStreamMapping from './pages/ValueStreamMapping'

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

function AppShell() {
  const location = useLocation()
  const [modalOpen, setModalOpen] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [analysis, setAnalysis] = useState<AgentAnalysis | null>(null)
  const [agentError, setAgentError] = useState<string | null>(null)

  const handleRun = useCallback(async () => {
    setModalOpen(true)
    setIsRunning(true)
    setAgentError(null)
    setAnalysis(null)
    try {
      const result = await runAgent()
      setAnalysis(result as AgentAnalysis)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string }
      setAgentError(err?.response?.data?.detail ?? err?.message ?? 'An unexpected error occurred.')
    } finally {
      setIsRunning(false)
    }
  }, [])

  return (
    <>
      {/* Outer background shell */}
      <div className="h-screen app-shell py-8 px-12">
        {/* Floating window */}
        <div className="flex h-full rounded-2xl glass shadow-2xl border border-white/30 overflow-hidden">
          <Sidebar />
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Top bar with AI button */}
            <div className="flex justify-end items-center px-6 py-3 shrink-0 border-b border-white/[0.06]">
              {location.pathname === '/supply-planning' && (
                <AgentButton onRun={handleRun} isRunning={isRunning} />
              )}
            </div>
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
                    <Route path="/bom" element={<BOM />} />
                    <Route path="/value-stream" element={<ValueStreamMapping />} />
                  </Routes>
                </ErrorBoundary>
              </div>
            </main>
          </div>
        </div>
      </div>

      {/* Agent modal — rendered via portal */}
      {modalOpen && (
        <AgentModal
          analysis={analysis}
          isLoading={isRunning}
          error={agentError}
          onClose={() => setModalOpen(false)}
          onRerun={handleRun}
        />
      )}
    </>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <FilterProvider>
      <SidebarActionsProvider>
        <AppShell />
      </SidebarActionsProvider>
      </FilterProvider>
    </BrowserRouter>
  )
}
