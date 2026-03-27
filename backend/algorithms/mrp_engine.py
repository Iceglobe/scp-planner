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
    health_target_multiplier: float = 5.0,
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
        lead_time_weeks = math.ceil(product.lead_time_days / 7)
        target = product.safety_stock_qty * health_target_multiplier

        for week in range(horizon_weeks):
            gross_req = forecast_map.get((product.id, week), avg_demand)
            receipts = open_orders_map.get((product.id, week), 0.0)
            projected = position + receipts - gross_req

            # Standard trigger: projected inventory falls below reorder point.
            rop_triggered = projected < product.reorder_point

            # ── Look-ahead trigger for capacity-constrained items ──────────────
            # When max_weekly_capacity limits how fast stock can be replenished,
            # a large future demand spike requires proactive stock build-up that
            # must begin several weeks in advance.  The standard ROP trigger fires
            # too late because by the time inventory crosses ROP, there are not
            # enough order cycles left to receive enough units.
            #
            # Check: "if I skip ordering THIS week, can I still avoid going below
            # safety stock at any future week by ordering at max capacity from
            # NEXT week onward?"
            #
            #   order_cycles_if_skipped = fw - lead_time_weeks
            #     (orders placed at W+1 … W+fw-LT arrive on or before W+fw)
            #
            # If the answer is NO for any future week → must order NOW at max cap.
            #
            # Crucially this check runs even when rop_triggered is True but
            # raw_need would be ≤ 0 (e.g. current position > target but well
            # below ROP), so the pre-build ramp is not suppressed in that case.
            lookahead_triggered = False
            max_deficit = 0.0
            if product.max_weekly_capacity:
                sim_pos = projected
                for fw in range(1, horizon_weeks - week):
                    fw_demand = forecast_map.get((product.id, week + fw), avg_demand)
                    fw_receipts = open_orders_map.get((product.id, week + fw), 0.0)
                    sim_pos = sim_pos + fw_receipts - fw_demand

                    # Orders available from next week onward (skip this week)
                    order_cycles = fw - lead_time_weeks
                    if order_cycles <= 0:
                        continue

                    max_additional = product.max_weekly_capacity * order_cycles
                    if sim_pos + max_additional < product.safety_stock_qty:
                        # Skipping this week makes future stockout unavoidable.
                        # Track the worst (maximum) deficit across all breach
                        # points so the order quantity is exactly what's needed,
                        # not a blanket max_cap that would over-build for steady
                        # demand items like P017.
                        deficit = product.safety_stock_qty - sim_pos - max_additional
                        if deficit > max_deficit:
                            max_deficit = deficit
                        lookahead_triggered = True
                        # Continue scanning — don't break early

            if lookahead_triggered:
                # Pre-build mode: order the minimum quantity that prevents the
                # worst projected breach, capped at max_weekly_capacity.
                # Use floor for the final cap to guarantee result ≤ max_cap.
                effective_moq = max(product.moq, 1)
                order_qty = math.ceil(max(max_deficit, effective_moq) / effective_moq) * effective_moq
                order_qty = min(order_qty, math.floor(product.max_weekly_capacity / effective_moq) * effective_moq)
                order_qty = max(order_qty, effective_moq)
                if order_qty <= 0:
                    position = projected
                    continue

            elif rop_triggered:
                # Normal ROP trigger: order up to health target.
                confirmed_in_window = sum(
                    open_orders_map.get((product.id, week + w), 0.0)
                    for w in range(1, lead_time_weeks + 1)
                )
                raw_need = target - projected - confirmed_in_window
                if raw_need <= 0:
                    position = projected
                    continue
                effective_moq = max(product.moq, 1)
                units_of_moq = math.ceil(max(raw_need, effective_moq) / effective_moq)
                order_qty = units_of_moq * effective_moq
                if product.max_weekly_capacity:
                    # Cap to max_weekly_capacity, then floor back to nearest MOQ
                    order_qty = math.floor(min(order_qty, product.max_weekly_capacity) / effective_moq) * effective_moq
                    order_qty = max(order_qty, effective_moq)

            else:
                position = projected
                continue

            trigger_dt = today + timedelta(weeks=week)
            if lookahead_triggered:
                # Proactive pre-build: place the order on the trigger week itself
                # so each week's order gets a distinct due_date.  (Backing off by
                # lead time would collapse early weeks onto the same due_date.)
                order_dt = trigger_dt
            else:
                # Standard: back off by lead time so goods arrive by the trigger week.
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
                # Ensure consolidation never pushes the total above max_weekly_capacity
                if product.max_weekly_capacity and existing.quantity > product.max_weekly_capacity:
                    effective_moq = max(product.moq, 1)
                    existing.quantity = max(
                        math.floor(product.max_weekly_capacity / effective_moq) * effective_moq,
                        effective_moq,
                    )
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

    return recommendations
