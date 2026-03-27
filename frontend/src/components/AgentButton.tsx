import { useState, useRef, useEffect } from 'react'

interface Schedule {
  enabled: boolean
  dayOfWeek: number   // 0=Sun … 6=Sat
  hour: number
  minute: number
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const STORAGE_KEY = 'scp_agent_schedule'

function loadSchedule(): Schedule {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return { enabled: false, dayOfWeek: 1, hour: 9, minute: 0 }
}

function saveSchedule(s: Schedule) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
}

interface Props {
  onRun: () => void
  isRunning: boolean
}

export function AgentButton({ onRun, isRunning }: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [schedule, setSchedule] = useState<Schedule>(loadSchedule)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close menu on outside click
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  // Auto-run check on mount and every minute
  useEffect(() => {
    function checkSchedule() {
      const s = loadSchedule()
      if (!s.enabled) return
      const now = new Date()
      if (
        now.getDay() === s.dayOfWeek &&
        now.getHours() === s.hour &&
        now.getMinutes() === s.minute
      ) {
        const lastRun = localStorage.getItem('scp_agent_last_auto_run')
        const key = `${now.toDateString()}-${s.hour}:${s.minute}`
        if (lastRun !== key) {
          localStorage.setItem('scp_agent_last_auto_run', key)
          onRun()
        }
      }
    }
    checkSchedule()
    const id = setInterval(checkSchedule, 60000)
    return () => clearInterval(id)
  }, [onRun])

  function updateSchedule(patch: Partial<Schedule>) {
    const next = { ...schedule, ...patch }
    setSchedule(next)
    saveSchedule(next)
  }

  const hourStr = String(schedule.hour).padStart(2, '0')
  const minStr = String(schedule.minute).padStart(2, '0')

  return (
    <div className="relative" ref={menuRef}>
      {/* Main button */}
      <div className="flex items-center gap-1">
        <button
          onClick={onRun}
          disabled={isRunning}
          title="Run AI Supply Planner"
          className="flex items-center gap-2 px-3 py-2 rounded-xl glass-light border border-white/20
                     hover:bg-white/15 transition-all duration-200 disabled:opacity-50
                     disabled:cursor-not-allowed text-white text-sm font-medium"
        >
          {isRunning ? (
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
            </svg>
          )}
          <span className="hidden sm:inline">
            {isRunning ? 'Analysing…' : 'Supply Planner Agent'}
          </span>
        </button>

        {/* Schedule chevron */}
        <button
          onClick={() => setMenuOpen(v => !v)}
          title="Schedule settings"
          className="p-2 rounded-xl glass-light border border-white/20 hover:bg-white/15
                     transition-all duration-200 text-white"
        >
          {schedule.enabled ? (
            /* Clock icon when scheduled */
            <svg className="w-3.5 h-3.5 text-emerald-400" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5 opacity-60" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          )}
        </button>
      </div>

      {/* Schedule dropdown */}
      {menuOpen && (
        <div className="absolute right-0 top-full mt-2 w-72 z-50
                        border border-white/15 rounded-2xl p-4 shadow-2xl" style={{ background: 'rgba(15,15,25,0.97)', backdropFilter: 'blur(20px)' }}>
          <p className="text-xs font-semibold uppercase tracking-widest text-white/50 mb-3">
            Scheduled Run
          </p>

          {/* Enable toggle */}
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm text-white/80">Auto-run weekly</span>
            <button
              onClick={() => updateSchedule({ enabled: !schedule.enabled })}
              className={`relative w-10 h-5 rounded-full transition-colors duration-200
                ${schedule.enabled ? 'bg-emerald-500' : 'bg-white/20'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full
                transition-transform duration-200 ${schedule.enabled ? 'translate-x-5' : ''}`} />
            </button>
          </div>

          {schedule.enabled && (
            <>
              {/* Day picker */}
              <div className="mb-3">
                <label className="text-xs text-white/50 mb-1 block">Day</label>
                <select
                  value={schedule.dayOfWeek}
                  onChange={e => updateSchedule({ dayOfWeek: Number(e.target.value) })}
                  className="w-full bg-white/10 border border-white/15 rounded-lg px-3 py-1.5
                             text-sm text-white outline-none"
                >
                  {DAY_NAMES.map((d, i) => (
                    <option key={i} value={i} className="bg-zinc-900">{d}</option>
                  ))}
                </select>
              </div>

              {/* Time picker */}
              <div className="mb-4">
                <label className="text-xs text-white/50 mb-1 block">Time</label>
                <div className="flex gap-2 items-center">
                  <input
                    type="number" min="0" max="23" value={schedule.hour}
                    onChange={e => updateSchedule({ hour: Math.min(23, Math.max(0, Number(e.target.value))) })}
                    className="w-16 bg-white/10 border border-white/15 rounded-lg px-2 py-1.5
                               text-sm text-white text-center outline-none"
                  />
                  <span className="text-white/50">:</span>
                  <input
                    type="number" min="0" max="59" step="15" value={schedule.minute}
                    onChange={e => updateSchedule({ minute: Math.min(59, Math.max(0, Number(e.target.value))) })}
                    className="w-16 bg-white/10 border border-white/15 rounded-lg px-2 py-1.5
                               text-sm text-white text-center outline-none"
                  />
                </div>
              </div>

              <p className="text-xs text-emerald-400/80">
                Runs every {DAY_NAMES[schedule.dayOfWeek]} at {hourStr}:{minStr}
              </p>
            </>
          )}

          {!schedule.enabled && (
            <p className="text-xs text-white/30">Enable to auto-run weekly analysis.</p>
          )}
        </div>
      )}
    </div>
  )
}
