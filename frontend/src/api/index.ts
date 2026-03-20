import api from './client'
import type { PivotData, ForecastRun, Kpis, AbcItem, ProjectionWeek, MrpRun } from './types'

// Products
export const getProducts = (params?: Record<string, string>) =>
  api.get('/products', { params }).then(r => r.data)

export const createProduct = (body: Record<string, unknown>) =>
  api.post('/products', body).then(r => r.data)

export const updateProduct = (id: number, body: Record<string, unknown>) =>
  api.put(`/products/${id}`, body).then(r => r.data)

export const deleteProduct = (id: number) =>
  api.delete(`/products/${id}`).then(r => r.data)

export const getChangelog = (limit = 200) =>
  api.get('/products/changelog', { params: { limit } }).then(r => r.data)

export const recalculateAbc = () =>
  api.post('/products/recalculate-abc').then(r => r.data)

export const recalculateSafetyStock = () =>
  api.post('/products/recalculate-safety-stock').then(r => r.data)

export const recalculateRop = () =>
  api.post('/products/recalculate-rop').then(r => r.data)

export const setAbcServiceLevels = (body: { A: number; B: number; C: number }) =>
  api.put('/products/set-abc-service-levels', body).then(r => r.data)

// Suppliers
export const getSuppliers = () => api.get('/suppliers').then(r => r.data)
export const createSupplier = (body: Record<string, unknown>) =>
  api.post('/suppliers', body).then(r => r.data)
export const updateSupplier = (id: number, body: Record<string, unknown>) =>
  api.put(`/suppliers/${id}`, body).then(r => r.data)

// Demand / Pivot
export const getDemandPivot = (params?: Record<string, string>): Promise<PivotData> =>
  api.get('/demand/pivot', { params }).then(r => r.data)

export const getDemand = (params?: Record<string, string>) =>
  api.get('/demand', { params }).then(r => r.data)

export const getCustomers = (): Promise<string[]> =>
  api.get('/demand/customers').then(r => r.data)

// Forecasts
export const runForecast = (body: { model: string; periods: number; granularity: string }) =>
  api.post('/forecasts/run', body).then(r => r.data)

export const getForecastRuns = (): Promise<ForecastRun[]> =>
  api.get('/forecasts/runs').then(r => r.data)

export const getForecasts = (params?: Record<string, string>) =>
  api.get('/forecasts', { params }).then(r => r.data)

export const adjustForecast = (id: number, adjustedQty: number, adjustedBy = 'user') =>
  api.put(`/forecasts/${id}/adjust`, { adjusted_qty: adjustedQty, adjusted_by: adjustedBy }).then(r => r.data)

export const adjustForecastMonth = (body: { product_id: number; year_month: string; total_qty: number; run_id?: string }) =>
  api.put('/forecasts/adjust-month', body).then(r => r.data)

export const reforecastProduct = (body: { product_id: number; model: string; periods?: number; granularity?: string }) =>
  api.post('/forecasts/run-product', body).then(r => r.data)

export const getAdjustmentLog = (productId?: number) =>
  api.get('/forecasts/adjustment-log', { params: productId ? { product_id: productId } : {} }).then(r => r.data)

export const saveForecastRun = (runId: string, name: string) =>
  api.put(`/forecasts/runs/${runId}/save`, { name }).then(r => r.data)

export const getForecastAccuracy = (lagWeeks: number, runId?: string) =>
  api.get('/forecasts/accuracy', { params: { lag_weeks: lagWeeks, ...(runId ? { run_id: runId } : {}) } }).then(r => r.data)

// Inventory
export const getInventory = () => api.get('/inventory').then(r => r.data)
export const getInventoryAlerts = () => api.get('/inventory/alerts').then(r => r.data)
export const updateInventory = (productId: number, body: Record<string, number>) =>
  api.put(`/inventory/${productId}`, body).then(r => r.data)

// Supply / MRP
export const getPurchaseOrders = (params?: Record<string, string>) =>
  api.get('/supply/purchase-orders', { params }).then(r => r.data)

export const updatePo = (id: number, body: Record<string, unknown>) =>
  api.put(`/supply/purchase-orders/${id}`, body).then(r => r.data)

export const createPo = (body: { product_id: number; quantity: number; period_key: string }) =>
  api.post('/supply/purchase-orders', body).then(r => r.data)

export const confirmAllPos = (mrpRunId?: string, dueDateFrom?: string, dueDateTo?: string) =>
  api.post('/supply/purchase-orders/confirm-all', null, {
    params: {
      ...(mrpRunId ? { mrp_run_id: mrpRunId } : {}),
      ...(dueDateFrom ? { due_date_from: dueDateFrom } : {}),
      ...(dueDateTo ? { due_date_to: dueDateTo } : {}),
    },
  }).then(r => r.data)

export const runMrp = (body: { horizon_weeks: number; forecast_run_id?: string; consolidation?: string }) =>
  api.post('/supply/mrp/run', body).then(r => r.data)

export const getMrpRuns = (): Promise<MrpRun[]> =>
  api.get('/supply/mrp/runs').then(r => r.data)

export const getInventoryProjection = (productId: number, weeks?: number): Promise<ProjectionWeek[]> =>
  api.get(`/supply/projection/${productId}`, { params: { weeks } }).then(r => r.data)

export const getMrpPivot = (weeks?: number) =>
  api.get('/supply/mrp-pivot', { params: { weeks } }).then(r => r.data)

// Analytics
export const getKpis = (): Promise<Kpis> =>
  api.get('/analytics/kpis').then(r => r.data)

export const getAbcAnalysis = (): Promise<AbcItem[]> =>
  api.get('/analytics/abc').then(r => r.data)

export const getInventoryTrend = (weeks?: number) =>
  api.get('/analytics/inventory-trend', { params: { weeks } }).then(r => r.data)

export const getDemandTrend = (weeks?: number) =>
  api.get('/analytics/demand-trend', { params: { weeks } }).then(r => r.data)

// Connectors
export const getConnectors = () => api.get('/connectors').then(r => r.data)

export const uploadFile = (formData: FormData) =>
  api.post('/connectors/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data)

export const testSql = (body: { connection_string: string; query: string }) =>
  api.post('/connectors/test-sql', body).then(r => r.data)

export const refreshEntityFile = (entity: string) =>
  api.post(`/connectors/${entity}/refresh`).then(r => r.data)

export const fetchExcel = (body: { url: string; target_entity: string; column_mapping?: Record<string, string>; import_mode?: string }) =>
  api.post('/connectors/fetch-excel', body, { timeout: 90000 }).then(r => r.data)

// BOM
export const getBomTree = () => api.get('/bom/tree').then(r => r.data)
export const getBomItems = () => api.get('/bom').then(r => r.data)
export const addBomItem = (body: { parent_product_id: number; child_product_id: number; quantity_per: number }) =>
  api.post('/bom', body).then(r => r.data)
export const updateBomItem = (id: number, quantity_per: number) =>
  api.put(`/bom/${id}`, { quantity_per }).then(r => r.data)
export const deleteBomItem = (id: number) =>
  api.delete(`/bom/${id}`).then(r => r.data)
