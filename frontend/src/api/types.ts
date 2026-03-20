export interface Supplier {
  id: number; code: string; name: string; contact_email?: string;
  lead_time_days: number; min_order_qty: number; currency: string; active: boolean;
}

export interface Product {
  id: number; sku: string; description: string; category?: string;
  unit_of_measure: string; cost: number; selling_price: number;
  supplier_id?: number; supplier_name?: string; lead_time_days: number;
  moq: number; reorder_point: number; safety_stock_days: number;
  safety_stock_qty: number; service_level: number; abc_class?: string;
  item_type: string; max_weekly_capacity?: number;
  smoothing_alpha: number; active: boolean;
  on_hand: number; on_order: number; reserved: number; position: number;
}

export interface SalesRecord {
  id: number; product_id: number; period_date: string;
  quantity: number; revenue: number; source: string;
}

export interface PeriodInfo {
  key: string; label: string; is_future: boolean; date: string;
}

export interface PivotRow {
  product_id: number; sku: string; description: string;
  abc_class?: string; supplier?: string; lead_time_days: number;
  safety_stock_qty: number; customer?: string;
  [key: string]: number | string | boolean | undefined;
}

export interface PivotData {
  periods: PeriodInfo[];
  rows: PivotRow[];
  customers?: string[];
}

export interface ForecastRun {
  run_id: string; name?: string; model: string; periods_ahead: number;
  granularity: string; mape?: number; created_at: string;
}

export interface Forecast {
  id: number; product_id: number; run_id: string; model: string;
  period_date: string; forecast_qty: number; lower_bound?: number;
  upper_bound?: number; is_adjusted: boolean; adjusted_qty?: number;
}

export interface InventoryRow {
  id: number; product_id: number; sku: string; description: string;
  category?: string; abc_class?: string; supplier?: string;
  quantity_on_hand: number; quantity_on_order: number; quantity_reserved: number;
  position: number; safety_stock_qty: number; reorder_point: number;
  service_level?: number;
  days_of_supply?: number; avg_daily_demand: number;
  cost: number; inventory_value: number;
  status: 'stockout' | 'below_ss' | 'healthy' | 'overstocked';
}

export interface PurchaseOrder {
  id: number; po_number?: string; product_id: number;
  sku?: string; description?: string; abc_class?: string;
  supplier_id?: number; supplier_name?: string;
  status: string; quantity: number; unit_cost?: number; total_cost: number;
  order_date?: string; due_date?: string; received_date?: string;
  notes?: string; mrp_run_id?: string; created_at?: string;
}

export interface MrpRun {
  run_id: string; run_date: string; horizon_weeks: number;
  po_count: number; total_po_value: number; status: string;
}

export interface Kpis {
  inventory_value: number; open_po_count: number; open_po_value: number;
  confirmed_po_value: number;
  items_at_risk: number; total_products: number;
  abc_counts: { A: number; B: number; C: number };
}

export interface TrendPoint {
  date?: string; label?: string; period?: string;
  value?: number; quantity?: number; revenue?: number;
  is_projected?: boolean;
}

export interface AbcItem {
  product_id: number; sku: string; description: string;
  category?: string; abc_class?: string; revenue: number;
  revenue_pct: number; cumulative_pct: number;
}

export interface ChangeLogEntry {
  id: number; entity_type: string; entity_id: number;
  entity_name?: string; field: string;
  old_value?: string; new_value?: string;
  changed_by: string; changed_at: string;
}

export interface MrpPeriod {
  key: string; label: string; date: string;
}

export interface MrpRow {
  row_type: 'on_hand' | 'customer_orders' | 'forecast' | 'confirmed_po' | 'suggested_po' | 'ending_inv';
  product_id: number;
  sku: string | null;
  description: string | null;
  abc_class: string | null;
  supplier: string | null;
  label: string;
  safety_stock: number | null;
  moq: number | null;
  max_weekly_capacity: number | null;
  item_type: string | null;
  reorder_point: number | null;
  on_hand_today: number | null;
  lead_time_days: number | null;
  work_center: string | null;
  spo_ids?: Record<string, number[]>;
  [key: string]: unknown;
}

export interface MrpPivotData {
  periods: MrpPeriod[];
  rows: MrpRow[];
}

export interface ProjectionWeek {
  week: number; date: string; demand: number; supply: number;
  position: number; safety_stock: number; reorder_point: number;
}

export interface BomItem {
  id: number;
  parent_product_id: number;
  parent_sku?: string;
  child_product_id: number;
  child_sku?: string;
  quantity_per: number;
}

export interface BomTreeNode {
  product_id: number;
  sku: string;
  description: string;
  unit_of_measure: string;
  level: number;
  bom_id?: number;
  quantity_per?: number;
  children: BomTreeNode[];
}
