import { useState, useRef, forwardRef, useImperativeHandle, useEffect } from 'react'
import { Upload, Database, Globe, CheckCircle, XCircle, ChevronDown, RefreshCw } from 'lucide-react'
import { uploadFile, testSql, refreshEntityFile, fetchExcel } from '../api'
import { Card, CardHeader, CardTitle, PageHeader, Button } from '../components/ui'

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export interface EntitySectionHandle { refresh: () => void; hasFile: () => boolean; isIncluded: () => boolean }

// ── Constants ────────────────────────────────────────────────────────────────

const CONNECTION_TYPES = [
  { value: '', label: 'Select connection type…' },
  { value: 'file', label: 'File upload (CSV / Excel)' },
  { value: 'sql', label: 'SQL database' },
  { value: 'rest', label: 'REST API / ERP' },
  { value: 'excel_link', label: 'Excel file link (URL)' },
]

const ENTITIES = [
  {
    value: 'sales_history',
    label: 'Sales History',
    description: 'Historical sales by SKU and period',
    csvTemplate: 'sku,period_date,quantity,revenue,customers\nSKU-001,2026-01-06,45,32400,Acme Corp',
    requiredColumns: ['sku', 'period_date', 'quantity'],
    optionalColumns: ['revenue', 'customers'],
  },
  {
    value: 'inventory',
    label: 'Inventory',
    description: 'Current stock quantities on hand',
    csvTemplate: 'sku,quantity_on_hand\nSKU-001,250',
    requiredColumns: ['sku', 'quantity_on_hand'],
    optionalColumns: [],
  },
  {
    value: 'products',
    label: 'Products',
    description: 'Product master data (SKUs, costs, lead times)',
    csvTemplate: 'sku,description,cost,selling_price,lead_time_days\nSKU-001,Widget A,100,720,7',
    requiredColumns: ['sku'],
    optionalColumns: ['description', 'category', 'cost', 'selling_price', 'lead_time_days', 'moq', 'unit_of_measure', 'smoothing_alpha', 'service_level', 'safety_stock_days', 'item_type', 'max_weekly_capacity'],
  },
  {
    value: 'purchase_orders',
    label: 'Purchase Orders',
    description: 'Open purchase orders and delivery dates',
    csvTemplate: 'po_number,sku,quantity,unit_cost,order_date,due_date\nPO-2026-0001,SKU-001,500,100,2026-03-01,2026-03-14',
    requiredColumns: ['sku', 'quantity'],
    optionalColumns: ['po_number', 'unit_cost', 'order_date', 'due_date'],
  },
  {
    value: 'customer_orders',
    label: 'Customer Orders',
    description: 'Open customer orders by SKU, customer, and due date',
    csvTemplate: 'sku,customer,due_date,quantity,revenue\nSKU-001,Acme Corp,2026-04-01,50,36000',
    requiredColumns: ['sku', 'quantity'],
    optionalColumns: ['customer', 'due_date', 'revenue'],
  },
  {
    value: 'production_orders',
    label: 'Production Orders',
    description: 'Confirmed work orders for manufactured items',
    csvTemplate: 'po_number,sku,work_center,quantity,unit_cost,order_date,due_date\nWO-2026-0001,SKU-001,Assembly,500,80,2026-03-01,2026-03-14',
    requiredColumns: ['sku', 'quantity'],
    optionalColumns: ['po_number', 'work_center', 'unit_cost', 'order_date', 'due_date'],
  },
]

// ── Per-entity section ────────────────────────────────────────────────────────

const EntitySection = forwardRef<EntitySectionHandle, { entity: typeof ENTITIES[0] }>(function EntitySection({ entity }, ref) {
  const lsKey = `ds_${entity.value}`

  // Restore persisted state from localStorage
  const stored = (() => { try { return JSON.parse(localStorage.getItem(lsKey) || '{}') } catch { return {} } })()

  const [includeInRefreshAll, setIncludeInRefreshAll] = useState<boolean>(stored.includeInRefreshAll !== false)
  const [connType, setConnType] = useState<string>(stored.connType || stored.lastConnType || '')
  const [file, setFile] = useState<File | null>(null)
  const [lastFileName, setLastFileName] = useState<string>(stored.lastFileName || '')
  const [lastConnType, setLastConnType] = useState<string>(stored.lastConnType || '')
  const [lastSyncTime, setLastSyncTime] = useState<string>(stored.lastSyncTime || '')
  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<{ rows_imported: number; total_rows: number; columns_found?: string[]; error?: string } | null>(stored.uploadResult || null)
  const [uploadError, setUploadError] = useState('')
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>(stored.columnMapping || {})
  const [showMapping, setShowMapping] = useState(false)
  const [importMode, setImportMode] = useState<'append' | 'replace'>(stored.importMode || 'append')
  const fileRef = useRef<HTMLInputElement>(null)

  const [sqlConn, setSqlConn] = useState<string>(stored.sqlConn || '')
  const [sqlQuery, setSqlQuery] = useState<string>(stored.sqlQuery || `SELECT * FROM ${entity.value} LIMIT 10`)
  const [sqlTesting, setSqlTesting] = useState(false)
  const [sqlResult, setSqlResult] = useState<{ success: boolean; preview?: Record<string, unknown>[]; error?: string } | null>(null)

  const [erpUrl, setErpUrl] = useState<string>(stored.erpUrl || '')
  const [erpAuth, setErpAuth] = useState<string>(stored.erpAuth || '')
  const [erpEndpoint, setErpEndpoint] = useState<string>(stored.erpEndpoint || '')

  const [excelLink, setExcelLink] = useState<string>(stored.excelLink || '')

  // Persist state to localStorage whenever relevant values change
  useEffect(() => {
    localStorage.setItem(lsKey, JSON.stringify({
      connType, lastFileName, lastConnType, lastSyncTime,
      uploadResult, columnMapping, importMode,
      sqlConn, sqlQuery,
      erpUrl, erpAuth, erpEndpoint,
      excelLink, includeInRefreshAll,
    }))
  }, [connType, lastFileName, lastConnType, lastSyncTime, uploadResult, columnMapping, importMode, sqlConn, sqlQuery, erpUrl, erpAuth, erpEndpoint, excelLink, includeInRefreshAll, lsKey])

  const handleUpload = async (mapping?: Record<string, string>) => {
    if (!file) return
    setUploading(true); setUploadError(''); setUploadResult(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('target_entity', entity.value)
      fd.append('column_mapping', JSON.stringify(mapping ?? columnMapping))
      fd.append('import_mode', importMode)
      const result = await uploadFile(fd)
      setUploadResult(result)
      if (file) setLastFileName(file.name)
      setLastConnType('file')
      setLastSyncTime(new Date().toISOString())
      // Auto-show mapping UI if zero rows imported and we have detected columns
      if (result.rows_imported === 0 && result.columns_found && result.columns_found.length > 0) {
        setShowMapping(true)
      }
    } catch (e: unknown) {
      setUploadError((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  const allExpectedColumns = [...(entity.requiredColumns ?? []), ...(entity.optionalColumns ?? [])]

  useImperativeHandle(ref, () => ({
    refresh: () => handleRefresh(),
    hasFile: () => !!file || !!lastConnType,
    isIncluded: () => includeInRefreshAll,
  }), [file, lastConnType, excelLink, sqlConn, includeInRefreshAll])

  const handleTestSQL = async () => {
    setSqlTesting(true); setSqlResult(null)
    try {
      const result = await testSql({ connection_string: sqlConn, query: sqlQuery })
      setSqlResult(result)
      if (result.success) { setLastConnType('sql'); setLastSyncTime(new Date().toISOString()) }
    } finally {
      setSqlTesting(false)
    }
  }

  const handleRefresh = async () => {
    setRefreshResult(null); setRefreshError('')
    setRefreshing(true)
    try {
      let result: { rows_imported: number; total_rows?: number } | null = null
      if (lastConnType === 'file') {
        if (file) {
          // Re-upload the in-memory file
          const fd = new FormData()
          fd.append('file', file)
          fd.append('target_entity', entity.value)
          fd.append('column_mapping', JSON.stringify(columnMapping))
          fd.append('import_mode', importMode)
          result = await uploadFile(fd)
          setUploadResult(result as typeof uploadResult)
          setLastSyncTime(new Date().toISOString())
        } else {
          // Re-import from server-saved copy
          result = await refreshEntityFile(entity.value)
          setLastSyncTime(new Date().toISOString())
        }
      } else if (lastConnType === 'excel_link') {
        result = await fetchExcel({ url: excelLink, target_entity: entity.value, column_mapping: columnMapping, import_mode: importMode })
        setExcelResult(result as typeof excelResult)
        setLastSyncTime(new Date().toISOString())
      } else if (lastConnType === 'sql') {
        setRefreshing(false)
        handleTestSQL()
        return
      }
      if (result) {
        setRefreshResult(result)
        window.dispatchEvent(new CustomEvent('datasource-refreshed'))
      }
    } catch (e: unknown) {
      setRefreshError((e as Error).message || 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  const [excelFetching, setExcelFetching] = useState(false)
  const [excelResult, setExcelResult] = useState<{ rows_imported: number; total_rows: number } | null>(null)
  const [excelError, setExcelError] = useState('')

  const handleFetchExcel = async () => {
    setExcelFetching(true); setExcelResult(null); setExcelError('')
    try {
      const result = await fetchExcel({ url: excelLink, target_entity: entity.value, column_mapping: columnMapping, import_mode: importMode })
      setExcelResult(result)
      setLastConnType('excel_link')
      setLastSyncTime(new Date().toISOString())
      window.dispatchEvent(new CustomEvent('datasource-refreshed'))
    } catch (e: unknown) {
      setExcelError((e as Error).message || 'Fetch failed')
    } finally {
      setExcelFetching(false)
    }
  }

  const [refreshResult, setRefreshResult] = useState<{ rows_imported: number; total_rows?: number } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')

  const lastConnLabel = CONNECTION_TYPES.find(t => t.value === lastConnType)?.label ?? ''
  const isRefreshing = uploading || sqlTesting || refreshing || excelFetching

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{entity.label}</CardTitle>
          <p className="text-xs text-white/70 mt-0.5">{entity.description}</p>
        </div>
        <button
          onClick={() => setIncludeInRefreshAll(v => !v)}
          title={includeInRefreshAll ? 'Included in Refresh All — click to exclude' : 'Excluded from Refresh All — click to include'}
          className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border transition-colors ${
            includeInRefreshAll
              ? 'border-emerald-700 bg-emerald-700 text-white font-semibold'
              : 'border-white/20 bg-white/[0.06] text-white/70'
          }`}
        >
          <RefreshCw className="w-3 h-3" />
          {includeInRefreshAll ? 'Incl. in refresh all' : 'Incl. in refresh all'}
        </button>
      </CardHeader>

      {/* Connection type selector */}
      <div className="mb-4 space-y-2">
        <div className="relative">
          <select
            value={connType}
            onChange={e => { setConnType(e.target.value); setUploadResult(null); setUploadError(''); setSqlResult(null); setShowMapping(false); setColumnMapping({}) }}
            className="w-full text-sm border border-white/20 rounded-lg px-3 py-2 pr-8 bg-white/[0.08] text-white focus:outline-none focus:ring-2 focus:ring-brand-500 appearance-none"
          >
            {CONNECTION_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/70 pointer-events-none" />
        </div>
        {lastConnType && lastSyncTime && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between bg-white/[0.06] border border-white/20 rounded-lg px-3 py-2">
              <span className="text-xs text-white/80 leading-tight">
                <span className="text-white/70">Last:</span>{' '}
                <span className="text-white font-medium">{lastConnLabel}</span>
                {lastConnType === 'file' && lastFileName && (
                  <span className="font-mono text-white/80"> · {lastFileName}</span>
                )}
                <span className="text-white/70"> · {formatRelativeTime(lastSyncTime)}</span>
              </span>
              <button
                onClick={handleRefresh}
                disabled={isRefreshing}
                className="ml-2 flex items-center gap-1 text-xs text-white/80 hover:text-white disabled:text-white/70 disabled:cursor-not-allowed transition-colors"
              >
                <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
                {isRefreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
            {refreshResult && (
              <div className={`flex items-center gap-2 text-xs rounded-lg px-3 py-1.5 ${refreshResult.rows_imported > 0 ? 'text-emerald-400 bg-emerald-400/10' : 'text-amber-400 bg-amber-400/10'}`}>
                <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />
                Refreshed — {refreshResult.rows_imported}{refreshResult.total_rows != null ? ` of ${refreshResult.total_rows}` : ''} rows imported
              </div>
            )}
            {refreshError && (
              <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 rounded-lg px-3 py-1.5">
                <XCircle className="w-3.5 h-3.5 flex-shrink-0" />
                {refreshError}
              </div>
            )}
          </div>
        )}
      </div>

      {/* File upload */}
      {connType === 'file' && (
        <div className="space-y-3">
          <div className="bg-white/[0.06] rounded-lg p-3">
            <p className="text-xs font-medium text-white/80 mb-1">Expected format:</p>
            <pre className="text-xs text-white/90 font-mono whitespace-pre-wrap">{entity.csvTemplate}</pre>
          </div>
          <div
            className="border-2 border-dashed border-zinc-300 rounded-xl p-6 text-center cursor-pointer hover:border-brand-400 hover:bg-white/[0.06] transition-colors"
            onClick={() => fileRef.current?.click()}
          >
            {file ? (
              <div>
                <CheckCircle className="w-5 h-5 text-emerald-500 mx-auto mb-1" />
                <p className="text-sm font-medium text-zinc-800">{file.name}</p>
                <p className="text-xs text-white/70">{(file.size / 1024).toFixed(1)} KB</p>
              </div>
            ) : (
              <div>
                <Upload className="w-5 h-5 text-white/70 mx-auto mb-1" />
                <p className="text-sm text-white/90">Drop file or click to browse</p>
                <p className="text-xs text-white/70 mt-0.5">.csv or .xlsx</p>
              </div>
            )}
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden"
              onChange={e => { setFile(e.target.files?.[0] || null); setUploadResult(null); setShowMapping(false); setColumnMapping({}) }} />
          </div>
          <div className="flex items-center gap-1 bg-zinc-100 rounded-lg p-1 text-xs">
            {(['append', 'replace'] as const).map(m => (
              <button
                key={m}
                onClick={() => setImportMode(m)}
                className={`flex-1 py-1 rounded-md capitalize transition-colors ${importMode === m ? 'bg-white/25 shadow-sm text-white font-medium' : 'text-white/80 hover:text-white'}`}
              >
                {m === 'append' ? 'Append' : 'Replace all'}
              </button>
            ))}
          </div>
          {importMode === 'replace' && (
            <p className="text-xs text-amber-600 bg-amber-50 rounded px-3 py-1.5">
              All existing {entity.label.toLowerCase()} data will be deleted before import.
            </p>
          )}
          <Button variant="primary" onClick={() => handleUpload()} disabled={!file || uploading} className="w-full justify-center">
            {uploading ? 'Importing…' : 'Import'}
          </Button>
          {!file && lastFileName && (
            <p className="text-xs text-white/70 text-center">Last: <span className="font-mono text-white/80">{lastFileName}</span> — select file again to refresh</p>
          )}
          {uploadResult && (
            <div className="space-y-2">
              <div className={`flex items-center gap-2 text-sm rounded-lg px-4 py-2 ${uploadResult.rows_imported > 0 ? 'text-emerald-400 bg-emerald-400/10' : 'text-amber-400 bg-amber-400/10'}`}>
                <CheckCircle className="w-4 h-4 flex-shrink-0" />
                Imported {uploadResult.rows_imported} of {uploadResult.total_rows} rows
              </div>
              {uploadResult.rows_imported === 0 && uploadResult.columns_found && uploadResult.columns_found.length > 0 && (
                <div className="bg-white/[0.06] rounded-lg px-4 py-3 space-y-3">
                  <div>
                    <p className="text-xs font-medium text-white/90">Columns found in file:</p>
                    <p className="text-xs font-mono text-white/80 mt-0.5">{uploadResult.columns_found.join(', ')}</p>
                    {uploadResult.error && (
                      <p className="text-xs text-red-600 mt-1">Error: {uploadResult.error}</p>
                    )}
                  </div>
                  {showMapping ? (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-white">Map your columns → expected columns:</p>
                      {allExpectedColumns.map(expected => {
                        const isRequired = entity.requiredColumns?.includes(expected)
                        const mappedFrom = Object.keys(columnMapping).find(k => columnMapping[k] === expected) ?? ''
                        return (
                          <div key={expected} className="flex items-center gap-2">
                            <span className={`text-xs font-mono w-36 flex-shrink-0 ${isRequired ? 'text-zinc-800 font-semibold' : 'text-white/80'}`}>
                              {expected}{isRequired ? ' *' : ''}
                            </span>
                            <select
                              value={mappedFrom}
                              onChange={e => {
                                const fileCol = e.target.value
                                setColumnMapping(prev => {
                                  const next = { ...prev }
                                  // Remove any existing mapping to this expected col
                                  Object.keys(next).forEach(k => { if (next[k] === expected) delete next[k] })
                                  if (fileCol) next[fileCol] = expected
                                  return next
                                })
                              }}
                              className="flex-1 text-xs border border-white/20 rounded px-2 py-1 bg-white/[0.08] text-white focus:outline-none focus:ring-1 focus:ring-brand-500"
                            >
                              <option value="">— same name / skip —</option>
                              {uploadResult.columns_found!.map(col => (
                                <option key={col} value={col}>{col}</option>
                              ))}
                            </select>
                          </div>
                        )
                      })}
                      <Button variant="primary" onClick={() => handleUpload(columnMapping)} disabled={uploading} className="w-full justify-center mt-1">
                        {uploading ? 'Importing…' : 'Re-import with mapping'}
                      </Button>
                    </div>
                  ) : (
                    <button onClick={() => setShowMapping(true)} className="text-xs text-white/80 hover:underline">
                      Map columns manually →
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {uploadError && (
            <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 rounded-lg px-4 py-2">
              <XCircle className="w-4 h-4 flex-shrink-0" />
              {uploadError}
            </div>
          )}
        </div>
      )}

      {/* SQL */}
      {connType === 'sql' && (
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-white/90 block mb-1">Connection string</label>
            <input type="text" value={sqlConn} onChange={e => setSqlConn(e.target.value)}
              placeholder="postgresql://user:pass@host:5432/db"
              className="w-full text-sm border border-white/20 rounded-lg px-3 py-2 bg-white text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          <div>
            <label className="text-xs font-medium text-white/90 block mb-1">SQL query</label>
            <textarea value={sqlQuery} onChange={e => setSqlQuery(e.target.value)} rows={3}
              className="w-full text-sm border border-white/20 rounded-lg px-3 py-2 font-mono bg-white text-zinc-900 focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none" />
          </div>
          <Button variant="secondary" onClick={handleTestSQL} disabled={!sqlConn || sqlTesting} className="w-full justify-center">
            <Database className="w-3.5 h-3.5" />
            {sqlTesting ? 'Testing…' : 'Test & Preview'}
          </Button>
          {sqlResult && (
            sqlResult.success ? (
              <div>
                <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 rounded-lg px-4 py-2 mb-2">
                  <CheckCircle className="w-4 h-4" /> Connection successful
                </div>
                {sqlResult.preview && sqlResult.preview.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="text-xs w-full">
                      <thead>
                        <tr className="border-b border-white/20">
                          {Object.keys(sqlResult.preview[0]).map(k => (
                            <th key={k} className="text-left text-white/80 font-medium pb-1 pr-3">{k}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sqlResult.preview.map((row, i) => (
                          <tr key={i} className="border-b border-white/5">
                            {Object.values(row).map((v, j) => (
                              <td key={j} className="py-1 pr-3 text-white">{String(v)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 rounded-lg px-4 py-2">
                <XCircle className="w-4 h-4" /> {sqlResult.error}
              </div>
            )
          )}
        </div>
      )}

      {/* REST API / ERP */}
      {connType === 'rest' && (
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-white/90 block mb-1">Base URL</label>
            <input type="text" value={erpUrl} onChange={e => setErpUrl(e.target.value)}
              placeholder="https://your-erp.com/api/v1"
              className="w-full text-sm border border-white/20 rounded-lg px-3 py-2 bg-white text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          <div>
            <label className="text-xs font-medium text-white/90 block mb-1">Auth header</label>
            <input type="text" value={erpAuth} onChange={e => setErpAuth(e.target.value)}
              placeholder="Bearer your-api-key"
              className="w-full text-sm border border-white/20 rounded-lg px-3 py-2 bg-white text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          <div>
            <label className="text-xs font-medium text-white/90 block mb-1">Endpoint path</label>
            <input type="text" value={erpEndpoint} onChange={e => setErpEndpoint(e.target.value)}
              placeholder="/sales-orders"
              className="w-full text-sm border border-white/20 rounded-lg px-3 py-2 bg-white text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          <Button variant="secondary" disabled={!erpUrl} className="w-full justify-center">
            <Globe className="w-3.5 h-3.5" />
            Test Connection
          </Button>
          <p className="text-xs text-white/70">Supports SAP S/4HANA, Microsoft Dynamics 365, Oracle NetSuite, Odoo, and any REST/JSON API.</p>
        </div>
      )}

      {/* Excel link */}
      {connType === 'excel_link' && (
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-white/90 block mb-1">Excel / SharePoint file URL</label>
            <input type="text" value={excelLink} onChange={e => { setExcelLink(e.target.value); setExcelResult(null); setExcelError('') }}
              placeholder="https://drive.google.com/file/d/…/view"
              className="w-full text-sm border border-white/20 rounded-lg px-3 py-2 bg-white text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          <Button variant="primary" onClick={handleFetchExcel} disabled={!excelLink || excelFetching} className="w-full justify-center">
            {excelFetching ? 'Fetching…' : 'Fetch & Import'}
          </Button>
          {excelResult && (
            <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 rounded-lg px-4 py-2">
              <CheckCircle className="w-4 h-4 flex-shrink-0" />
              Imported {excelResult.rows_imported} of {excelResult.total_rows} rows
            </div>
          )}
          {excelError && (
            <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 rounded-lg px-4 py-2">
              <XCircle className="w-4 h-4 flex-shrink-0" />
              {excelError}
            </div>
          )}
          <div className="text-xs text-white/70 space-y-1">
            <p><span className="text-emerald-600 font-medium">✓ Google Drive</span> — Share → "Anyone with the link can view" → paste the link here. Auto-converted.</p>
            <p><span className="text-emerald-600 font-medium">✓ Dropbox</span> — change <code>dl=0</code> to <code>dl=1</code> in the link.</p>
            <p><span className="text-red-400 font-medium">✗ OneDrive personal</span> — not supported (Microsoft blocks server-side access).</p>
          </div>
        </div>
      )}
    </Card>
  )
})

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DataSources() {
  const refs = useRef<(EntitySectionHandle | null)[]>([])
  const [refreshingAll, setRefreshingAll] = useState(false)

  const handleRefreshAll = async () => {
    setRefreshingAll(true)
    refs.current.forEach(r => r?.hasFile() && r.isIncluded() && r.refresh())
    setTimeout(() => setRefreshingAll(false), 2000)
  }

  return (
    <div>
      <PageHeader
        title="Data Sources"
        description="Connect each data entity to its source — file upload, SQL, REST API, or Excel link"
      />
      <div className="flex justify-end mb-4">
        <Button variant="secondary" size="sm" onClick={handleRefreshAll} disabled={refreshingAll}>
          <RefreshCw className="w-3.5 h-3.5" />
          {refreshingAll ? 'Refreshing…' : 'Refresh All'}
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-6">
        {ENTITIES.map((entity, i) => (
          <EntitySection key={entity.value} entity={entity} ref={el => { refs.current[i] = el }} />
        ))}
      </div>
    </div>
  )
}
