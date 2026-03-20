import math
from datetime import date, timedelta
from dataclasses import dataclass
from typing import Optional, Dict, Tuple, List


@dataclass
class MrpProduct:
    id: int
    sku: str
    supplier_id: Optional[int]
    lead_time_days: float
    moq: float
    reorder_point: float
    safety_stock_qty: float
    unit_cost: float
    max_weekly_capacity: Optional[float] = None


@dataclass
class MrpInventory:
    quantity_on_hand: float
    quantity_on_order: float
    quantity_reserved: float

    @property
    def position(self) -> float:
        return self.quantity_on_hand + self.quantity_on_order - self.quantity_reserved


@dataclass
class MrpRecommendation:
    product_id: int
    supplier_id: Optional[int]
    quantity: float
    order_date: date
    due_date: date
    unit_cost: float
    trigger_week: int
    projected_balance: float


def _consolidation_key(dt: date, consolidation: str):
    if consolidation == 'week':
        iso = dt.isocalendar()
        return (dt.year, iso[1])
    if consolidation == 'month':
        return (dt.year, dt.month)
    return dt  # 'day' — exact date


def run_mrp(
    products: List[MrpProduct],
    inventory_map: Dict[int, MrpInventory],
    forecast_map: Dict[Tuple[int, int], float],
    open_orders_map: Dict[Tuple[int, int], float],
    horizon_weeks: int = 12,
    today: Optional[date] = None,
    consolidation: str = 'day',
) -> List[MrpRecommendation]:
    if today is None:
        today = date.today()

    recommendations: List[MrpRecommendation] = []

    for product in products:
        inv = inventory_map.get(product.id)
        if inv is None:
            continue

        # Start from physical on-hand minus reserved.
        # open_orders_map schedules all confirmed/planned receipts week-by-week,
        # so including on_order in the starting position would double-count them.
        position = inv.quantity_on_hand - inv.quantity_reserved
        avg_demand = forecast_map.get((product.id, 0), 0)

        for week in range(horizon_weeks):
            gross_req = forecast_map.get((product.id, week), avg_demand)
            receipts = open_orders_map.get((product.id, week), 0.0)
            projected = position + receipts - gross_req

            if projected < product.reorder_point:
                # Subtract confirmed/planned POs already arriving within the lead-time window
                lead_time_weeks = math.ceil(product.lead_time_days / 7)
                confirmed_in_window = sum(
                    open_orders_map.get((product.id, week + w), 0.0)
                    for w in range(1, lead_time_weeks + 1)
                )
                raw_need = product.safety_stock_qty + gross_req - projected - confirmed_in_window
                if raw_need <= 0:
                    position = projected
                    continue
                effective_moq = max(product.moq, 1)
                units_of_moq = math.ceil(max(raw_need, effective_moq) / effective_moq)
                order_qty = units_of_moq * effective_moq
                if product.max_weekly_capacity:
                    order_qty = min(order_qty, product.max_weekly_capacity)

                # Order is placed as soon as shortage is detected (at the trigger week).
                # Arrival = order_date + lead_time_days — never earlier.
                trigger_dt = today + timedelta(weeks=week)
                order_dt = max(today, trigger_dt - timedelta(days=product.lead_time_days))
                due_dt = order_dt + timedelta(days=product.lead_time_days)

                # Consolidate into existing PO within the same bucket
                existing = next(
                    (r for r in recommendations
                     if r.product_id == product.id
                     and _consolidation_key(r.due_date, consolidation)
                        == _consolidation_key(due_dt, consolidation)),
                    None,
                )
                if existing:
                    existing.quantity += order_qty
                else:
                    recommendations.append(
                        MrpRecommendation(
                            product_id=product.id,
                            supplier_id=product.supplier_id,
                            quantity=order_qty,
                            order_date=order_dt,
                            due_date=due_dt,
                            unit_cost=product.unit_cost,
                            trigger_week=week,
                            projected_balance=projected,
                        )
                    )
                position = projected + order_qty
            else:
                position = projected

    return recommendations
