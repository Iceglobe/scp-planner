from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, and_
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import date, timedelta
from database import get_db
from models import Workstation, Product, PurchaseOrder, MrpRun, BomItem, CustomerPriority

router = APIRouter()


class SimulateRequest(BaseModel):
    mrp_run_id: Optional[str] = None
    horizon_weeks: int = 12
    threshold_pct: float = 0.85
    # hours_per_day_overrides: workstation_id (str key) -> hours override
    hours_per_day_overrides: dict = {}


def _build_week_list(horizon_weeks: int):
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    weeks = []
    for i in range(horizon_weeks):
        d = monday + timedelta(weeks=i)
        iso = d.isocalendar()
        week_key = f"{iso[0]}-W{iso[1]:02d}"
        week_label = f"W{iso[1]:02d}"
        weeks.append((week_key, week_label, d))
    return weeks


def _compute_load(db: Session, mrp_run_id: Optional[str], horizon_weeks: int, threshold_pct: float, hours_overrides: dict):
    weeks = _build_week_list(horizon_weeks)
    week_keys = {wk for wk, _, _ in weeks}

    # Resolve MRP run
    if mrp_run_id:
        run_id = mrp_run_id
    else:
        latest = db.query(MrpRun).order_by(MrpRun.created_at.desc()).first()
        run_id = latest.run_id if latest else None

    # Production plan = recommended POs from selected run + all confirmed POs
    if run_id:
        pos = db.query(PurchaseOrder).filter(
            or_(
                and_(PurchaseOrder.mrp_run_id == run_id, PurchaseOrder.status == "recommended"),
                PurchaseOrder.status == "confirmed",
            )
        ).all()
    else:
        pos = db.query(PurchaseOrder).filter(PurchaseOrder.status == "confirmed").all()

    # Build po_qty_map: (product_id, week_key) -> total qty
    po_qty_map: dict = {}
    for po in pos:
        if not po.due_date:
            continue
        dd = po.due_date
        if hasattr(dd, 'date'):
            dd = dd.date()
        monday = dd - timedelta(days=dd.weekday())
        iso = monday.isocalendar()
        wk = f"{iso[0]}-W{iso[1]:02d}"
        if wk in week_keys:
            key = (po.product_id, wk)
            po_qty_map[key] = po_qty_map.get(key, 0.0) + po.quantity

    # Priority product IDs: any product with a priority customer, plus all BOM descendants
    priority_product_ids = {r.product_id for r in db.query(CustomerPriority).all()}
    # Build parent→children map and BFS to include all sub-components
    bom_edges = db.query(BomItem.parent_product_id, BomItem.child_product_id).all()
    bom_children_map: dict = {}
    for parent_id, child_id in bom_edges:
        bom_children_map.setdefault(parent_id, set()).add(child_id)
    queue = list(priority_product_ids)
    while queue:
        pid = queue.pop()
        for child_id in bom_children_map.get(pid, set()):
            if child_id not in priority_product_ids:
                priority_product_ids.add(child_id)
                queue.append(child_id)

    # BOM parents: products that appear as parent_product_id in bom_items
    bom_parent_ids = {row[0] for row in db.query(BomItem.parent_product_id).all()}

    # Load products: BOM parents with a workstation assigned
    load_products = db.query(Product).filter(
        Product.id.in_(bom_parent_ids),
        Product.workstation_id.isnot(None),
        Product.active == True,
    ).all() if bom_parent_ids else []

    # Build ws_to_products: ws_id -> list of Product
    ws_to_products: dict = {}
    for p in load_products:
        ws_to_products.setdefault(p.workstation_id, []).append(p)

    # Unassigned: BOM parents with no workstation_id
    unassigned = db.query(Product).filter(
        Product.id.in_(bom_parent_ids),
        Product.workstation_id.is_(None),
        Product.active == True,
    ).all() if bom_parent_ids else []

    workstations = db.query(Workstation).order_by(Workstation.created_at, Workstation.name).all()

    results = []
    for ws in workstations:
        effective_hours = float(hours_overrides.get(str(ws.id), hours_overrides.get(ws.id, ws.hours_per_day)))
        rate = ws.cycle_rate_units_per_min
        days = ws.days_per_week
        # Operational minutes per week
        capacity_min_per_week = effective_hours * 60.0 * days
        capacity_units = round(effective_hours * 60.0 * rate * days, 0) if rate > 0 else 0.0

        assigned = ws_to_products.get(ws.id, [])

        weekly_loads = []
        for (week_key, week_label, week_date) in weeks:
            load_min = 0.0
            product_loads = []
            for p in assigned:
                qty = po_qty_map.get((p.id, week_key), 0.0)
                if qty > 0:
                    mins = qty / rate if rate > 0 else 0.0
                    load_min += mins
                    product_loads.append({
                        "product_id": p.id,
                        "sku": p.sku,
                        "description": p.description,
                        "qty": qty,
                        "load_minutes": mins,
                        "has_priority_demand": p.id in priority_product_ids,
                    })
            util = load_min / capacity_min_per_week if capacity_min_per_week > 0 else 0.0
            weekly_loads.append({
                "week_key": week_key,
                "week_label": week_label,
                "week_date": week_date.isoformat(),
                "load_minutes": load_min,
                "capacity_minutes": capacity_min_per_week,
                "utilization_pct": util,
                "is_bottleneck": util > threshold_pct,
                "products": product_loads,
            })

        peak = max((wl["utilization_pct"] for wl in weekly_loads), default=0.0)
        avg = sum(wl["utilization_pct"] for wl in weekly_loads) / len(weekly_loads) if weekly_loads else 0.0

        results.append({
            "workstation_id": ws.id,
            "workstation_name": ws.name,
            "department": ws.department,
            "hours_per_day": effective_hours,
            "days_per_week": days,
            "cycle_rate_units_per_min": rate,
            "capacity_units_per_week": capacity_units,
            "cycle_time_minutes": ws.cycle_time_minutes,
            "weekly_loads": weekly_loads,
            "peak_utilization_pct": peak,
            "avg_utilization_pct": avg,
        })

    return results, unassigned, weeks


@router.get("/load")
def get_load(
    horizon_weeks: int = Query(12, ge=1, le=52),
    threshold_pct: float = Query(0.85, ge=0.0, le=1.0),
    mrp_run_id: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    results, unassigned, weeks = _compute_load(db, mrp_run_id, horizon_weeks, threshold_pct, {})

    used_run_id = mrp_run_id
    if not used_run_id:
        latest = db.query(MrpRun).order_by(MrpRun.created_at.desc()).first()
        used_run_id = latest.run_id if latest else None

    return {
        "mrp_run_id": used_run_id,
        "horizon_weeks": horizon_weeks,
        "threshold_pct": threshold_pct,
        "weeks": [wk for wk, _, _ in weeks],
        "workstations": results,
        "unassigned_products": [
            {"product_id": p.id, "sku": p.sku, "description": p.description}
            for p in unassigned
        ],
    }


@router.post("/simulate")
def simulate(body: SimulateRequest, db: Session = Depends(get_db)):
    results, _, _ = _compute_load(
        db, body.mrp_run_id, body.horizon_weeks, body.threshold_pct, body.hours_per_day_overrides
    )
    return {"workstations": results}
