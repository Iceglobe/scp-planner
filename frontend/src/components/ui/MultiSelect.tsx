import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, X } from 'lucide-react'

interface Props {
  options: string[]
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
}

export function MultiSelect({ options, value, onChange, placeholder = 'Filter…' }: Props) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 })

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current && !containerRef.current.contains(e.target as Node) &&
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node)
      ) { setOpen(false); setSearch('') }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const openDropdown = () => {
    if (containerRef.current) {
      const r = containerRef.current.getBoundingClientRect()
      setPos({ top: r.bottom + 4, left: r.left, width: r.width })
    }
    setOpen(true)
  }

  const filtered = options.filter(o => o.toLowerCase().includes(search.toLowerCase()))

  const toggle = (opt: string) => {
    onChange(value.includes(opt) ? value.filter(s => s !== opt) : [...value, opt])
  }

  const displayValue = !open
    ? (value.length === 0 ? '' : value.length === 1 ? value[0] : `${value.length} selected`)
    : search

  const portal = document.getElementById('dropdown-portal')

  return (
    <>
      <div
        ref={containerRef}
        className="w-3/4 flex items-center border border-white/20 rounded-lg bg-white/[0.06] focus-within:ring-1 focus-within:ring-white/40"
      >
        <input
          ref={inputRef}
          type="text"
          value={displayValue}
          onChange={e => { setSearch(e.target.value); openDropdown() }}
          onKeyDown={e => { if (e.key === 'Enter' && filtered.length === 1) { toggle(filtered[0]); setSearch(''); setOpen(false) } }}
          onFocus={openDropdown}
          placeholder={placeholder}
          className="flex-1 min-w-0 text-xs bg-transparent px-2.5 py-1.5 text-white placeholder-white/30 focus:outline-none"
        />
        <button
          onMouseDown={e => { e.preventDefault(); open ? (setOpen(false), setSearch('')) : (openDropdown(), inputRef.current?.focus()) }}
          className="px-1.5 py-1.5 text-white/40 hover:text-white/70 transition-colors shrink-0"
        >
          <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {open && portal && createPortal(
        <div
          ref={dropdownRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: Math.max(pos.width, 200), zIndex: 9999, pointerEvents: 'all' }}
          className="bg-[#1e2330] border border-white/20 rounded-lg shadow-xl overflow-hidden"
        >
          {value.length > 0 && (
            <button
              onClick={() => onChange([])}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-white/50 hover:text-white/80 hover:bg-white/[0.04] transition-colors border-b border-white/10"
            >
              <X className="w-3 h-3" /> Clear all ({value.length})
            </button>
          )}
          <div className="overflow-y-auto" style={{ maxHeight: 240 }}>
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-white/30">No results</p>
            ) : (
              filtered.map(opt => (
                <label
                  key={opt}
                  className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-white/[0.06] transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={value.includes(opt)}
                    onChange={() => toggle(opt)}
                    className="accent-blue-400 w-3 h-3 shrink-0"
                  />
                  <span className="text-[11px] text-white/80 truncate">{opt}</span>
                </label>
              ))
            )}
          </div>
        </div>,
        portal
      )}
    </>
  )
}
