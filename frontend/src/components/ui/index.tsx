import { clsx } from 'clsx'
import { CSSProperties, ReactNode } from 'react'

// --- Card ---
export function Card({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={clsx('glass rounded-2xl p-6 transition-all duration-300 hover:bg-white/10', className)} style={style}>
      {children}
    </div>
  )
}

export function CardHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex items-center justify-between mb-4', className)}>
      {children}
    </div>
  )
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-[11px] font-bold uppercase tracking-widest text-white">{children}</h3>
}

// --- Badge ---
type BadgeVariant = 'default' | 'info' | 'success' | 'warning' | 'danger' | 'purple'

const badgeStyles: Record<BadgeVariant, string> = {
  default: 'bg-zinc-100 text-zinc-700',
  info: 'bg-blue-400/10 text-blue-400',
  success: 'bg-indigo-400/10 text-indigo-400',
  warning: 'bg-amber-400/10 text-amber-400',
  danger: 'bg-red-400/10 text-red-400',
  purple: 'bg-violet-400/10 text-violet-400',
}

export function Badge({ children, variant = 'default', className }: {
  children: ReactNode; variant?: BadgeVariant; className?: string;
}) {
  return (
    <span className={clsx('inline-flex px-1.5 py-0.5 rounded text-xs font-medium', badgeStyles[variant], className)}>
      {children}
    </span>
  )
}

export function AbcBadge({ cls }: { cls?: string }) {
  const v: Record<string, BadgeVariant> = { A: 'success', B: 'warning', C: 'default' }
  return cls ? <Badge variant={v[cls] || 'default'}>{cls}</Badge> : <span className="text-zinc-300 text-xs">—</span>
}

// --- KPI Card ---
export function KpiCard({
  label, value, sub, icon: Icon, alert, trend, className,
}: {
  label: string; value: string | number; sub?: string;
  icon?: React.FC<{ className?: string }>; alert?: boolean;
  trend?: number; // percent change, positive = up
  className?: string;
}) {
  return (
    <Card className={clsx('cursor-default relative overflow-hidden group', className)}>
      <div className="flex items-start justify-between mb-3">
        <p className="text-[10px] text-white/80 font-bold uppercase tracking-widest">{label}</p>
        {Icon && <Icon className={clsx('w-4 h-4 transition-transform group-hover:scale-110', alert ? 'text-red-400' : 'text-white/60')} />}
      </div>
      <p className={clsx('text-3xl font-bold tracking-tight leading-none text-white', alert && 'text-red-400')}>
        {value}
      </p>
      {(sub || trend != null) && (
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-white/10">
          {sub && <p className="text-[11px] text-white/70 font-medium">{sub}</p>}
          {trend != null && (
            <span className={clsx(
              'inline-flex items-center gap-0.5 text-[11px] font-bold px-1.5 py-0.5 rounded-md backdrop-blur-sm',
              trend > 0 ? 'text-indigo-400 bg-indigo-400/10' : trend < 0 ? 'text-red-400 bg-red-400/10' : 'text-white/20 bg-white/5'
            )}>
              {trend > 0 ? '↑' : trend < 0 ? '↓' : '—'} {Math.abs(trend).toFixed(1)}%
            </span>
          )}
        </div>
      )}
    </Card>
  )
}

// --- Button ---
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const buttonStyles: Record<ButtonVariant, string> = {
  primary: 'bg-brand-700 text-white hover:bg-brand-600',
  secondary: 'bg-brand-600 text-white hover:bg-brand-700',
  ghost: 'bg-transparent text-white border border-white/30 hover:bg-white/10',
  danger: 'bg-red-600 text-white hover:bg-red-700',
}

export function Button({
  children, variant = 'secondary', onClick, disabled, className, size = 'md', type = 'button',
}: {
  children: ReactNode; variant?: ButtonVariant; onClick?: () => void;
  disabled?: boolean; className?: string; size?: 'sm' | 'md';
  type?: 'button' | 'submit';
}) {
  const sizeStyles = size === 'sm'
    ? 'px-3 py-1.5 text-xs'
    : 'px-4 py-2 text-sm'
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-lg font-medium transition-colors',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        sizeStyles, buttonStyles[variant], className
      )}
    >
      {children}
    </button>
  )
}

// --- Status dot ---
export function StatusDot({ status }: { status: 'ok' | 'warning' | 'critical' }) {
  const colors = { ok: 'bg-white', warning: 'bg-amber-400', critical: 'bg-red-500' }
  return <span className={clsx('inline-block w-2 h-2 rounded-full', colors[status])} />
}

// --- Page Header ---
export function PageHeader({ title, description, actions }: {
  title: string; description?: string; actions?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between mb-8">
      <div>
        <h1 className="font-bold text-4xl text-white tracking-tight leading-tight">{title}</h1>
        {description && <p className="text-sm text-white/80 font-medium mt-1">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

// --- Select ---
export function Select({
  value, onChange, options, className,
}: {
  value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; className?: string;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className={clsx(
        'text-sm border border-white/20 rounded-lg px-3 py-1.5',
        'bg-white/[0.08] text-white focus:outline-none focus:ring-2 focus:ring-white/40 focus:border-transparent',
        className
      )}
    >
      {options.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

// --- Loading Spinner ---
export function Spinner({ className }: { className?: string }) {
  return (
    <div className={clsx('flex items-center justify-center', className)}>
      <div className="w-8 h-8 border-3 border-white/10 border-t-white rounded-full animate-spin" />
    </div>
  )
}

// --- Empty State ---
export function EmptyState({ message }: { message: string }) {
  return (
    <div className="py-16 text-center text-white/70 text-sm">{message}</div>
  )
}
