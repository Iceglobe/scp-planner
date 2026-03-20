// AG Grid React cell renderers must return React elements, not DOM nodes.
// Using React.createElement so this can live in a .ts file (no JSX transform needed).
import { createElement } from 'react'

const ABC_COLORS: Record<string, { bg: string; text: string }> = {
  A: { bg: 'rgba(5,150,105,0.15)', text: '#6ee7b7' },
  B: { bg: 'rgba(217,119,6,0.15)', text: '#fcd34d' },
  C: { bg: 'rgba(82,82,91,0.15)', text: 'rgba(255,255,255,0.5)' },
}

export function abcCellRenderer(p: { value?: string }) {
  if (!p.value) return createElement('span', { style: { color: 'rgba(255,255,255,0.25)' } }, '—')
  const c = ABC_COLORS[p.value]
  return createElement('span', {
    style: {
      display: 'inline-flex', alignItems: 'center', padding: '1px 6px',
      borderRadius: 4, fontSize: 11, fontWeight: 600,
      background: c?.bg ?? '#f4f4f5', color: c?.text ?? '#52525b',
    },
  }, p.value)
}

export function itemTypeCellRenderer(p: { value?: string }) {
  if (!p.value) return createElement('span', { style: { color: 'rgba(255,255,255,0.25)' } }, '—')
  const isPurchased = p.value === 'purchased'
  return createElement('span', {
    style: {
      display: 'inline-flex', alignItems: 'center', padding: '1px 6px',
      borderRadius: 4, fontSize: 11, fontWeight: 600,
      background: isPurchased ? 'rgba(29,78,216,0.2)' : 'rgba(5,150,105,0.2)',
      color: isPurchased ? '#93c5fd' : '#6ee7b7',
    },
  }, p.value)
}

export function activeCellRenderer(p: { value?: boolean }) {
  return createElement('span', {
    style: { fontSize: 12, fontWeight: 500, color: p.value ? '#6ee7b7' : 'rgba(255,255,255,0.35)' },
  }, p.value ? 'Active' : 'Inactive')
}

export function trashCellRenderer() {
  return createElement('button', {
    className: 'delete-btn',
    style: {
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: 28, height: 28, border: 'none', background: 'transparent',
      cursor: 'pointer', borderRadius: 4, color: 'rgba(255,255,255,0.3)',
    },
    onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => {
      e.currentTarget.style.color = '#ef4444'
      e.currentTarget.style.background = 'rgba(239,68,68,0.15)'
    },
    onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => {
      e.currentTarget.style.color = 'rgba(255,255,255,0.3)'
      e.currentTarget.style.background = 'transparent'
    },
  }, createElement('svg', {
    xmlns: 'http://www.w3.org/2000/svg', width: 14, height: 14,
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  },
    createElement('polyline', { points: '3 6 5 6 21 6' }),
    createElement('path', { d: 'M19 6l-1 14H6L5 6' }),
    createElement('path', { d: 'M10 11v6' }),
    createElement('path', { d: 'M14 11v6' }),
    createElement('path', { d: 'M9 6V4h6v2' }),
  ))
}
