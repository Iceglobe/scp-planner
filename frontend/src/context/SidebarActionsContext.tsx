import { createContext, useContext, useState, useEffect, ReactNode } from 'react'

interface SidebarActionsContextType {
  actions: ReactNode | null
  setActions: (node: ReactNode | null) => void
}

const SidebarActionsContext = createContext<SidebarActionsContextType>({
  actions: null,
  setActions: () => {},
})

export function SidebarActionsProvider({ children }: { children: ReactNode }) {
  const [actions, setActions] = useState<ReactNode | null>(null)
  return (
    <SidebarActionsContext.Provider value={{ actions, setActions }}>
      {children}
    </SidebarActionsContext.Provider>
  )
}

export function useSidebarActions() {
  return useContext(SidebarActionsContext)
}

/** Registers sidebar actions for the current page, clearing on unmount. */
export function useSidebarActionsEffect(node: ReactNode, deps: unknown[]) {
  const { setActions } = useSidebarActions()
  useEffect(() => {
    setActions(node)
    return () => setActions(null)
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
}
