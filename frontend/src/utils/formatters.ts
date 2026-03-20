export const fmtCurrency = (v?: number, currency = 'USD') => {
  if (v == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(v)
}

export const fmtNumber = (v?: number, decimals = 0) => {
  if (v == null) return '—'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: decimals }).format(v)
}

export const fmtPct = (v?: number) => {
  if (v == null) return '—'
  return `${(v * 100).toFixed(0)}%`
}

export const fmtDate = (s?: string) => {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export const statusLabel = (s: string) => {
  const map: Record<string, string> = {
    recommended: 'Recommended', planned: 'Planned',
    confirmed: 'Confirmed', in_transit: 'In Transit',
    received: 'Received', cancelled: 'Cancelled',
  }
  return map[s] || s
}

export const statusVariant = (s: string) => {
  const map: Record<string, string> = {
    recommended: 'purple', planned: 'info', confirmed: 'success',
    in_transit: 'warning', received: 'default', cancelled: 'danger',
  }
  return (map[s] || 'default') as 'purple' | 'info' | 'success' | 'warning' | 'default' | 'danger'
}

export const ABC_COLORS = { A: '#059669', B: '#d97706', C: '#71717a' }
