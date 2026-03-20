import { createContext, useContext, useState, ReactNode } from 'react'

interface FilterContextType {
  itemIds: string[]
  setItemIds: (v: string[]) => void
  productNames: string[]
  setProductNames: (v: string[]) => void
}

const FilterContext = createContext<FilterContextType>({
  itemIds: [], setItemIds: () => {},
  productNames: [], setProductNames: () => {},
})

export function FilterProvider({ children }: { children: ReactNode }) {
  const [itemIds, setItemIds] = useState<string[]>([])
  const [productNames, setProductNames] = useState<string[]>([])
  return (
    <FilterContext.Provider value={{ itemIds, setItemIds, productNames, setProductNames }}>
      {children}
    </FilterContext.Provider>
  )
}

export function useFilters() {
  return useContext(FilterContext)
}
