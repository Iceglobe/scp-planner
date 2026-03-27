from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import date, timedelta
import uuid
from database import get_db
from models import Product, Inventory, Forecast, PurchaseOrder, MrpRun, ProductionOrder, BomItem
from algorithms.mrp_engine import run_mrp, MrpProduct, MrpInventory

router = APIRouter()


class MrpRunRequest(BaseModel):
    horizon_weeks: int = 12
    forecast_run_id: Optional[str] = None
    consolidation: str = 'day'  # 'day' | 'week' | 'month'
    health_target_multiplier: float = 5.0  # PO targets position = this * safety_stock
    min_weeks_cover: float = 0  # floor SS to this many weeks of avg demand


class PoUpdate(BaseModel):
    status: Optional[str] = None
    quantity: Optional[float] = None
    order_date: Optional[date] = None
    due_date: Optional[date] = None
    notes: Optional[str] = None


class PoCreate(BaseModel):
    product_id: int
    quantity: float
    period_key: str  # ISO week key e.g. "2026-W13"


def po_to_dict(po: PurchaseOrder) -> dict:
    return {
        "id": po.id, "po_number": po.po_number,
        "product_id": po.product_id,
        "sku": po.product.sku if po.product else None,
        "description": po.product.description if po.product else None,
        "abc_class": po.product.abc_class if po.product else None,
        "supplier_id": po.supplier_id,
        "supplier_name": po.supplier.name if po.supplier else None,
        "status": po.status,
        "quantity": po.quantity,
        "unit_cost": po.unit_cost,
        "total_cost": round((po.quantity or 0) * (po.unit_cost or 0), 2),
        "order_date": po.order_date.isoformat() if po.order_date else None,
        "due_date": po.due_date.isoformat() if po.due_date else None,
        "received_date": po.received_date.isoformat() if po.received_date else None,
        "notes": po.notes,
        "mrp_run_id": po.mrp_run_id,
        "created_at": po.created_at.isoformat() if po.created_at else None,
    }


@router.post("/purchase-orders")
def create_po(body: PoCreate, db: Session = Depends(get_db)):
    """Create a new recommended PO for a given product and order-week period key."""
    product = db.query(Product).filter(Product.id == body.product_id).first()
    if not product:
        raise HTTPException(404)
    # Parse ISO week key "YYYY-Www" → Monday of that week
    year = int(body.period_key[:4])
    week = int(body.period_key[6:])
    order_date = date.fromisocalendar(year, week, 1)
    due_date = order_date + timedelta(days=product.lead_time_days or 0)
    today = date.today()
    from sqlalchemy import func as sqlfunc
    max_id = db.query(sqlfunc.max(PurchaseOrder.id)).scalar() or 0
    po = PurchaseOrder(
        po_number=f"PO-{today.year}-{max_id + 1:04d}",
        product_id=product.id,
        supplier_id=product.supplier_id,
        status="recommended",
        quantity=body.quantity,
        unit_cost=product.cost,
        order_date=order_date,
        due_date=due_date,
    )
    db.add(po)
    db.commit()
    db.refresh(po)
    return po_to_dict(po)


@router.get("/purchase-orders")
def list_pos(
    status: Optional[str] = None,
    supplier_id: Optional[int] = None,
    product_id: Optional[int] = None,
    db: Session = Depends(get_db),
):
    q = db.query(PurchaseOrder)
    if status:
        q = q.filter(PurchaseOrder.status == status)
    if supplier_id:
        q = q.filter(PurchaseOrder.supplier_id == supplier_id)
    if product_id:
        q = q.filter(PurchaseOrder.product_id == product_id)
    return [po_to_dict(po) for po in q.order_by(PurchaseOrder.due_date).all()]


@router.put("/purchase-orders/{po_id}")
def update_po(po_id: int, body: PoUpdate, db: Session = Depends(get_db)):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == po_id).first()
    if not po:
        raise HTTPException(404)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(po, k, v)
    db.commit()
    return po_to_dict(po)


@router.post("/purchase-orders/confirm-all")
def confirm_all(
    mrp_run_id: Optional[str] = None,
    due_date_from: Optional[date] = None,
    due_date_to: Optional[date] = None,
    db: Session = Depends(get_db),
):
    q = db.query(PurchaseOrder).filter(PurchaseOrder.status == "recommended")
    if mrp_run_id:
        q = q.filter(PurchaseOrder.mrp_run_id == mrp_run_id)
    if due_date_from:
        q = q.filter(PurchaseOrder.due_date >= due_date_from)
    if due_date_to:
        q = q.filter(PurchaseOrder.due_date <= due_date_to)
    pos = q.all()
    for po in pos:
        po.status = "planned"
    db.commit()
    return {"confirmed": len(pos)}


@router.post("/mrp/run")
def run_mrp_endpoint(body: MrpRunRequest, db: Session = Depends(get_db)):
    mrp_run_id = str(uuid.uuid4())
    today = date.today()

    # Clear previous recommended POs so stale suggestions don't pollute the plan
    db.query(PurchaseOrder).filter(PurchaseOrder.status == "recommended").delete()
    db.flush()

    products = db.query(Product).filter(Product.active == True).all()

    inv_rows = db.query(Inventory).all()
    inventory_map = {
        inv.product_id: MrpInventory(
            quantity_on_hand=inv.quantity_on_hand,
            quantity_on_order=inv.quantity_on_order,
            quantity_reserved=inv.quantity_reserved,
        )
        for inv in inv_rows
    }
    avg_weekly_by_product = {inv.product_id: (inv.avg_daily_demand or 0) * 7 for inv in inv_rows}

    def effective_ss(product) -> float:
        base_ss = product.safety_stock_qty or 0
        if body.min_weeks_cover > 0:
            return max(base_ss, body.min_weeks_cover * avg_weekly_by_product.get(product.id, 0))
        return base_ss

    mrp_products = [
        MrpProduct(
            id=p.id, sku=p.sku, supplier_id=p.supplier_id,
            lead_time_days=p.lead_time_days, moq=p.moq,
            reorder_point=p.reorder_point, safety_stock_qty=effective_ss(p),
            unit_cost=p.cost, max_weekly_capacity=p.max_weekly_capacity,
        )
        for p in products
    ]

    # Build forecast map (product_id, week_index) -> qty
    fq = db.query(Forecast)
    if body.forecast_run_id:
        fq = fq.filter(Forecast.run_id == body.forecast_run_id)
    else:
        from sqlalchemy import func
        latest = (
            db.query(Forecast.product_id, func.max(Forecast.created_at).label("latest"))
            .group_by(Forecast.product_id)
            .subquery()
        )
        fq = fq.join(latest, (Forecast.product_id == latest.c.product_id) &
                     (Forecast.created_at == latest.c.latest))

    forecast_rows = fq.filter(
        Forecast.period_date >= today.replace(day=1),
        Forecast.period_date <= today + timedelta(weeks=body.horizon_weeks + 6),
    ).all()

    # Convert monthly forecast rows to weekly demand (monthly / 4.2 weeks per month)
    WEEKS_PER_MONTH = 4.2
    forecast_map: dict[tuple, float] = {}
    for f in forecast_rows:
        qty = f.adjusted_qty if f.is_adjusted else f.forecast_qty
        weekly_qty = (qty or 0) / WEEKS_PER_MONTH
        month_str = f.period_date.strftime("%Y-%m")
        for week_idx in range(body.horizon_weeks + 3):
            if (today + timedelta(weeks=week_idx)).strftime("%Y-%m") == month_str:
                forecast_map[(f.product_id, week_idx)] = weekly_qty

    # For products with no forecast data, fall back to avg_daily_demand * 7
    # so the engine uses the same demand baseline as the MRP pivot display.
    products_with_forecast = {k[0] for k in forecast_map}
    for inv in inv_rows:
        if inv.product_id not in products_with_forecast:
            avg = (inv.avg_daily_demand or 0) * 7
            if avg > 0:
                for w in range(body.horizon_weeks + 2):
                    forecast_map[(inv.product_id, w)] = avg

    # Net customer orders (quantity_reserved) against week-0 forecast so the
    # MRP engine doesn't suggest POs for demand already covered by firm orders.
    reserved_map = {inv.product_id: inv.quantity_reserved for inv in inv_rows}
    for pid, reserved in reserved_map.items():
        if reserved > 0:
            key0 = (pid, 0)
            current = forecast_map.get(key0, 0)
            forecast_map[key0] = max(0.0, current - reserved)

    # Open orders arriving map
    open_pos = db.query(PurchaseOrder).filter(
        PurchaseOrder.status.in_(["planned", "confirmed", "in_transit"])
    ).all()
    open_orders_map: dict[tuple, float] = {}
    for po in open_pos:
        if po.due_date:
            week_idx = max(0, (po.due_date - today).days // 7)
            key = (po.product_id, week_idx)
            open_orders_map[key] = open_orders_map.get(key, 0) + po.quantity

    # ── BOM explosion ──────────────────────────────────────────────────────────
    bom_rows = db.query(BomItem).all()
    all_child_ids = {b.child_product_id for b in bom_rows}
    parent_to_children: dict[int, list] = {}
    for b in bom_rows:
        parent_to_children.setdefault(b.parent_product_id, []).append((b.child_product_id, b.quantity_per))

    # Level 0: products NOT listed as children in any BOM (top-level + standalone)
    level0 = [p for p in mrp_products if p.id not in all_child_ids]
    bom_children = [p for p in mrp_products if p.id in all_child_ids]

    level0_recs = run_mrp(
        level0, inventory_map, forecast_map, open_orders_map,
        horizon_weeks=body.horizon_weeks, today=today, consolidation=body.consolidation,
        health_target_multiplier=body.health_target_multiplier,
    )
    recommendations = list(level0_recs)

    if bom_children:
        # Derive demand for each child from parent PO quantities × qty_per.
        #
        # Week-0 confirmed parent PO arrivals: reflected by increasing the
        # child's quantity_reserved so avg_demand stays 0 (not the spike).
        # Future-week arrivals: added as explicit forecast demand entries.
        #
        # Critically: only seed from level0 parents here. BOM sub-parents
        # (e.g. P003 whose own confirmed POs drive grandchild P017) are
        # propagated level-by-level inside the loop below, ensuring each
        # grandchild is processed in the correct BOM level with full demand.
        product_map = {p.id: p for p in mrp_products}
        derived_demand: dict[tuple, float] = {}
        child_extra_reserved: dict[int, float] = {}

        # Pre-index confirmed POs by parent for efficient per-level lookup
        confirmed_by_parent: dict[int, list] = {}
        for (parent_id, week_idx), qty in open_orders_map.items():
            confirmed_by_parent.setdefault(parent_id, []).append((week_idx, qty))

        def _seed_confirmed(product_id: int) -> None:
            """Propagate confirmed PO demand from product_id to its direct children."""
            for week_idx, qty in confirmed_by_parent.get(product_id, []):
                for child_id, qty_per in parent_to_children.get(product_id, []):
                    demand = qty * qty_per
                    if week_idx == 0:
                        child_extra_reserved[child_id] = child_extra_reserved.get(child_id, 0) + demand
                    else:
                        k = (child_id, week_idx)
                        derived_demand[k] = derived_demand.get(k, 0) + demand

        # Seed confirmed demand only from level0 parents
        for p in level0:
            _seed_confirmed(p.id)

        # Children with extra_reserved need a sentinel week-0 entry so they
        # appear in level_ids and avg_demand stays 0 (not the spike value).
        for child_id in child_extra_reserved:
            derived_demand.setdefault((child_id, 0), 0.0)

        # Build modified inventory map with BOM-driven reservations
        child_inventory_map = dict(inventory_map)
        for child_id, extra in child_extra_reserved.items():
            if child_id in child_inventory_map:
                inv = child_inventory_map[child_id]
                child_inventory_map[child_id] = MrpInventory(
                    quantity_on_hand=inv.quantity_on_hand,
                    quantity_on_order=inv.quantity_on_order,
                    quantity_reserved=inv.quantity_reserved + extra,
                )

        # Also include demand from newly recommended parent POs
        for rec in level0_recs:
            week_idx = max(0, (rec.due_date - today).days // 7)
            for child_id, qty_per in parent_to_children.get(rec.product_id, []):
                k = (child_id, week_idx)
                derived_demand[k] = derived_demand.get(k, 0) + rec.quantity * qty_per

        processed_ids = {p.id for p in level0}
        for _level in range(10):  # safety cap on depth
            level_ids = {k[0] for k in derived_demand if k[0] not in processed_ids}
            if not level_ids:
                break
            level_products = [p for p in bom_children if p.id in level_ids]
            level_forecast = {k: v for k, v in derived_demand.items() if k[0] in level_ids}
            level_recs = run_mrp(
                level_products, child_inventory_map, level_forecast, open_orders_map,
                horizon_weeks=body.horizon_weeks, today=today, consolidation=body.consolidation,
                health_target_multiplier=body.health_target_multiplier,
            )
            recommendations.extend(level_recs)
            processed_ids.update(level_ids)

            # Propagate confirmed POs from this level's products to their children,
            # then rebuild child_inventory_map for any newly reserved children.
            for lp in level_products:
                _seed_confirmed(lp.id)
            for child_id, extra in child_extra_reserved.items():
                if child_id in processed_ids:
                    continue
                base_inv = inventory_map.get(child_id)
                if base_inv is None:
                    continue
                child_inventory_map[child_id] = MrpInventory(
                    quantity_on_hand=base_inv.quantity_on_hand,
                    quantity_on_order=base_inv.quantity_on_order,
                    quantity_reserved=base_inv.quantity_reserved + extra,
                )
                derived_demand.setdefault((child_id, 0), 0.0)

            # Propagate recommendations from this level to their children
            for rec in level_recs:
                week_idx = max(0, (rec.due_date - today).days // 7)
                for child_id, qty_per in parent_to_children.get(rec.product_id, []):
                    if child_id not in processed_ids:
                        k = (child_id, week_idx)
                        derived_demand[k] = derived_demand.get(k, 0) + rec.quantity * qty_per

    from sqlalchemy import func
    year_prefix = f"PO-{today.year}-"
    max_po_this_year = db.query(func.max(PurchaseOrder.po_number)).filter(
        PurchaseOrder.po_number.like(f"{year_prefix}%")
    ).scalar()
    if max_po_this_year:
        try:
            po_counter = int(max_po_this_year.split("-")[-1]) + 1
        except ValueError:
            po_counter = 1
    else:
        po_counter = 1
    new_pos = []
    for i, rec in enumerate(recommendations):
        po_num = f"PO-{today.year}-{(po_counter + i):04d}"
        po = PurchaseOrder(
            po_number=po_num,
            product_id=rec.product_id,
            supplier_id=rec.supplier_id,
            status="recommended",
            quantity=rec.quantity,
            unit_cost=rec.unit_cost,
            order_date=rec.order_date,
            due_date=rec.due_date,
            mrp_run_id=mrp_run_id,
        )
        db.add(po)
        new_pos.append(po)

    total_value = sum(r.quantity * r.unit_cost for r in recommendations)

    mrp = MrpRun(
        run_id=mrp_run_id, horizon_weeks=body.horizon_weeks,
        po_count=len(recommendations), total_po_value=total_value,
    )
    db.add(mrp)
    db.commit()

    return {
        "run_id": mrp_run_id,
        "po_count": len(recommendations),
        "total_value": round(total_value, 2),
    }


@router.get("/mrp/runs")
def list_mrp_runs(db: Session = Depends(get_db)):
    runs = db.query(MrpRun).order_by(MrpRun.created_at.desc()).limit(10).all()
    return [
        {"run_id": r.run_id, "run_date": r.run_date.isoformat() if r.run_date else None,
         "horizon_weeks": r.horizon_weeks, "po_count": r.po_count,
         "total_po_value": r.total_po_value, "status": r.status}
        for r in runs
    ]


@router.get("/mrp-pivot")
def mrp_pivot(weeks: int = 12, db: Session = Depends(get_db)):
    from sqlalchemy import func
    today = date.today()

    periods = []
    for w in range(weeks):
        dt = today + timedelta(weeks=w)
        iso = dt.isocalendar()
        periods.append({"key": f"{iso[0]}-W{iso[1]:02d}", "label": f"W{iso[1]}",
                         "date": dt.isoformat(), "week_idx": w})

    products = db.query(Product).filter(Product.active == True).order_by(Product.abc_class, Product.sku).all()
    inv_map = {inv.product_id: inv for inv in db.query(Inventory).all()}

    latest_subq = (
        db.query(Forecast.product_id, func.max(Forecast.created_at).label("latest"))
        .group_by(Forecast.product_id).subquery()
    )
    forecast_rows = db.query(Forecast).join(
        latest_subq,
        (Forecast.product_id == latest_subq.c.product_id) &
        (Forecast.created_at == latest_subq.c.latest)
    ).filter(
        Forecast.period_date >= today.replace(day=1),
        Forecast.period_date <= today + timedelta(weeks=weeks + 6),
    ).all()

    # Convert monthly forecast rows to weekly demand (monthly / 4.2 weeks per month)
    forecast_map: dict = {}
    for f in forecast_rows:
        qty = f.adjusted_qty if f.is_adjusted else f.forecast_qty
        weekly_qty = (qty or 0) / 4.2
        month_str = f.period_date.strftime("%Y-%m")
        for w_idx in range(weeks):
            if (today + timedelta(weeks=w_idx)).strftime("%Y-%m") == month_str:
                forecast_map[(f.product_id, w_idx)] = weekly_qty

    all_pos = db.query(PurchaseOrder).filter(
        PurchaseOrder.status.in_(["planned", "confirmed", "in_transit", "recommended"])
    ).all()
    confirmed_map: dict = {}          # keyed by arrival week (due_date) — for inventory balance
    suggested_arrival_map: dict = {}  # keyed by arrival week (due_date) — for inventory balance
    suggested_order_map: dict = {}    # keyed by order week  (order_date) — for display row
    suggested_order_ids: dict = {}    # (product_id, w_idx) -> [po.id, ...] — for inline editing
    for po in all_pos:
        if po.status in ["planned", "confirmed", "in_transit"]:
            if po.due_date:
                # Overdue POs (past due date) are treated as arriving in week 0,
                # matching the MRP engine's max(0, ...) logic so display stays consistent.
                w_idx = max(0, (po.due_date - today).days // 7)
                if w_idx < weeks:
                    confirmed_map[(po.product_id, w_idx)] = confirmed_map.get((po.product_id, w_idx), 0) + po.quantity
        else:  # recommended
            if po.due_date:
                w_idx = max(0, (po.due_date - today).days // 7)
                if w_idx < weeks:
                    suggested_arrival_map[(po.product_id, w_idx)] = suggested_arrival_map.get((po.product_id, w_idx), 0) + po.quantity
            if po.order_date:
                w_idx = max(0, (po.order_date - today).days // 7)
                if 0 <= w_idx < weeks:
                    suggested_order_map[(po.product_id, w_idx)] = suggested_order_map.get((po.product_id, w_idx), 0) + po.quantity
                    suggested_order_ids.setdefault((po.product_id, w_idx), []).append(po.id)

    # ── BOM-derived demand for child products ─────────────────────────────────
    # Child products have no independent demand — their demand is driven by the
    # parent's confirmed + suggested PO arrivals × qty_per (BOM explosion).
    bom_all = db.query(BomItem).all()
    parent_to_children_bom: dict[int, list] = {}
    bom_child_ids: set[int] = set()
    for b in bom_all:
        parent_to_children_bom.setdefault(b.parent_product_id, []).append(
            (b.child_product_id, b.quantity_per)
        )
        bom_child_ids.add(b.child_product_id)

    # confirmed PO arrivals of parent → child's customer orders (firm demand)
    derived_confirmed_map: dict[tuple, float] = {}
    for (pid, w_idx), qty in confirmed_map.items():
        for child_id, qty_per in parent_to_children_bom.get(pid, []):
            k = (child_id, w_idx)
            derived_confirmed_map[k] = derived_confirmed_map.get(k, 0) + qty * qty_per

    # suggested PO arrival weeks of parent → child's forecast
    # Keyed by due_date (arrival) to match derived_confirmed_map and the MRP engine,
    # so proj. inventory correctly reflects when components are actually consumed.
    derived_forecast_map: dict[tuple, float] = {}
    for (pid, w_idx), qty in suggested_arrival_map.items():
        for child_id, qty_per in parent_to_children_bom.get(pid, []):
            k = (child_id, w_idx)
            derived_forecast_map[k] = derived_forecast_map.get(k, 0) + qty * qty_per

    # Work center lookup for produced items — take most recent non-null entry per product
    work_center_map: dict = {}
    for pid, wc in db.query(ProductionOrder.product_id, ProductionOrder.work_center).filter(
        ProductionOrder.work_center.isnot(None)
    ).all():
        if pid not in work_center_map:
            work_center_map[pid] = wc

    result_rows = []
    for product in products:
        inv = inv_map.get(product.id)
        on_hand = inv.quantity_on_hand if inv else 0
        reserved = inv.quantity_reserved if inv else 0
        avg_demand = (inv.avg_daily_demand or 0) * 7 if inv else 0
        supplier_name = product.supplier.name if product.supplier else None
        ss = product.safety_stock_qty or 0
        lead_time = product.lead_time_days or 0

        beg: dict = {}
        cust_d: dict = {}
        forecast_d: dict = {}
        confirmed_d: dict = {}
        suggested_d: dict = {}
        spo_ids_d: dict = {}
        ending_d: dict = {}

        is_bom_child = product.id in bom_child_ids
        balance = on_hand
        for period in periods:
            w_idx = period["week_idx"]
            k = period["key"]
            if is_bom_child:
                # Firm demand = parent's confirmed PO arrivals; forecast = parent's suggested POs
                cust_orders = derived_confirmed_map.get((product.id, w_idx), 0.0)
                forecast_qty = derived_forecast_map.get((product.id, w_idx), 0.0)
            else:
                cust_orders = reserved if w_idx == 0 else 0
                forecast_qty = forecast_map.get((product.id, w_idx), avg_demand)
            net_forecast = max(0.0, forecast_qty - cust_orders)  # forecast consumed by firm orders
            gross_demand = cust_orders + net_forecast             # = max(cust_orders, forecast_qty)
            confirmed = confirmed_map.get((product.id, w_idx), 0)
            # Inventory balance uses ARRIVAL week; display row uses ORDER week
            suggested_arrival = suggested_arrival_map.get((product.id, w_idx), 0)
            suggested_order = suggested_order_map.get((product.id, w_idx), 0)
            beg[k] = round(balance, 1)
            cust_d[k] = round(cust_orders, 1)
            forecast_d[k] = round(net_forecast, 1)        # net after consumption
            confirmed_d[k] = round(confirmed, 1)
            suggested_d[k] = round(suggested_order, 1)   # show when to ACT
            spo_ids_d[k] = suggested_order_ids.get((product.id, w_idx), [])
            balance = balance + confirmed + suggested_arrival - gross_demand  # use arrival for balance
            ending_d[k] = round(balance, 1)

        base = {"product_id": product.id, "sku": product.sku, "description": product.description,
                "abc_class": product.abc_class, "supplier": supplier_name, "safety_stock": ss,
                "avg_weekly_demand": round(avg_demand, 2),
                "moq": product.moq or 0, "max_weekly_capacity": product.max_weekly_capacity,
                "item_type": product.item_type or "purchased",
                "reorder_point": product.reorder_point or 0,
                "on_hand_today": round(on_hand, 1), "lead_time_days": lead_time,
                "work_center": work_center_map.get(product.id),
                "unit_cost": product.cost or 0, "selling_price": product.selling_price or 0}
        sub = {"sku": None, "description": None, "abc_class": None, "supplier": None,
               "on_hand_today": None, "lead_time_days": None, "moq": None,
               "max_weekly_capacity": None, "item_type": None, "reorder_point": None}
        result_rows.append({**base, "row_type": "on_hand", "label": "On Hand", **beg})
        result_rows.append({**base, **sub, "row_type": "customer_orders", "label": "Customer Orders", **cust_d})
        result_rows.append({**base, **sub, "row_type": "forecast", "label": "Forecast", **forecast_d})
        result_rows.append({**base, **sub, "row_type": "confirmed_po", "label": "Confirmed POs", **confirmed_d})
        result_rows.append({**base, **sub, "row_type": "suggested_po", "label": "Suggested PO", **suggested_d, "spo_ids": spo_ids_d})
        result_rows.append({**base, **sub, "row_type": "ending_inv", "label": "Proj. Inventory", **ending_d})

    return {
        "periods": [{"key": p["key"], "label": p["label"], "date": p["date"]} for p in periods],
        "rows": result_rows,
    }


@router.get("/projection/{product_id}")
def inventory_projection(product_id: int, weeks: int = 12, db: Session = Depends(get_db)):
    today = date.today()
    inv = db.query(Inventory).filter(Inventory.product_id == product_id).first()
    if not inv:
        raise HTTPException(404)
    product = db.query(Product).filter(Product.id == product_id).first()

    from sqlalchemy import func
    latest = (
        db.query(Forecast.product_id, func.max(Forecast.created_at).label("latest"))
        .filter(Forecast.product_id == product_id)
        .group_by(Forecast.product_id)
        .subquery()
    )
    forecasts = db.query(Forecast).join(
        latest, (Forecast.product_id == latest.c.product_id) &
                (Forecast.created_at == latest.c.latest)
    ).filter(
        Forecast.product_id == product_id,
        Forecast.period_date >= today,
    ).order_by(Forecast.period_date).limit(weeks).all()

    open_pos = db.query(PurchaseOrder).filter(
        PurchaseOrder.product_id == product_id,
        PurchaseOrder.status.in_(["planned", "confirmed", "in_transit"]),
    ).all()

    open_map: dict[int, float] = {}
    for po in open_pos:
        if po.due_date:
            week_idx = max(0, (po.due_date - today).days // 7)
            open_map[week_idx] = open_map.get(week_idx, 0) + po.quantity

    projection = []
    # Start from on_hand only — open POs are added week-by-week from open_map.
    # Including quantity_on_order here would double-count those same POs.
    position = inv.quantity_on_hand - inv.quantity_reserved
    avg_demand = inv.avg_daily_demand * 7 if inv.avg_daily_demand else 0

    for w in range(weeks):
        f = forecasts[w] if w < len(forecasts) else None
        demand = (f.adjusted_qty if f and f.is_adjusted else f.forecast_qty) if f else avg_demand
        supply = open_map.get(w, 0)
        position = position + supply - demand
        dt = today + timedelta(weeks=w)
        projection.append({
            "week": w + 1,
            "date": dt.isoformat(),
            "demand": round(demand, 1),
            "supply": round(supply, 1),
            "position": round(position, 1),
            "safety_stock": product.safety_stock_qty if product else 0,
            "reorder_point": product.reorder_point if product else 0,
        })

    return projection
