from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import date, timedelta, datetime
from database import get_db
from models import SalesHistory, Product, Forecast, CustomerDemand, ForecastRun, BomItem, ForecastAdjustLog, CustomerPriority

router = APIRouter()


class DemandRecord(BaseModel):
    product_id: int
    period_date: date
    quantity: float
    revenue: float = 0.0
    source: str = "actual"
    customer: Optional[str] = None


@router.get("")
def list_demand(
    product_id: Optional[int] = None,
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    limit: int = 500,
    db: Session = Depends(get_db),
):
    q = db.query(SalesHistory)
    if product_id:
        q = q.filter(SalesHistory.product_id == product_id)
    if from_date:
        q = q.filter(SalesHistory.period_date >= from_date)
    if to_date:
        q = q.filter(SalesHistory.period_date <= to_date)
    rows = q.order_by(SalesHistory.period_date.desc()).limit(limit).all()
    return [
        {"id": r.id, "product_id": r.product_id, "period_date": r.period_date.isoformat(),
         "quantity": r.quantity, "revenue": r.revenue, "source": r.source, "customer": r.customer}
        for r in rows
    ]


@router.post("")
def create_demand(body: DemandRecord, db: Session = Depends(get_db)):
    existing = db.query(SalesHistory).filter(
        SalesHistory.product_id == body.product_id,
        SalesHistory.period_date == body.period_date,
        SalesHistory.customer == body.customer,
    ).first()
    if existing:
        existing.quantity = body.quantity
        existing.revenue = body.revenue
    else:
        db.add(SalesHistory(**body.model_dump()))
    db.commit()
    return {"ok": True}


@router.post("/bulk")
def bulk_demand(records: list[DemandRecord], db: Session = Depends(get_db)):
    for r in records:
        existing = db.query(SalesHistory).filter(
            SalesHistory.product_id == r.product_id,
            SalesHistory.period_date == r.period_date,
            SalesHistory.customer == r.customer,
        ).first()
        if existing:
            existing.quantity = r.quantity
            existing.revenue = r.revenue
        else:
            db.add(SalesHistory(**r.model_dump()))
    db.commit()
    return {"inserted": len(records)}


class CustomerForecastAdjust(BaseModel):
    product_id: int
    customer: str
    year_month: str   # "YYYY-MM"
    qty: float
    adjusted_by: str = "user"


@router.put("/customer-forecast/adjust")
def adjust_customer_forecast(body: CustomerForecastAdjust, db: Session = Depends(get_db)):
    """Update a single customer's forecast for a month, then re-aggregate to the Forecast table."""
    from sqlalchemy import func
    try:
        year, month = int(body.year_month[:4]), int(body.year_month[5:7])
    except (ValueError, IndexError):
        raise HTTPException(400, "year_month must be YYYY-MM")
    month_start = date(year, month, 1)

    # Upsert the CustomerDemand forecast row
    cd = db.query(CustomerDemand).filter(
        CustomerDemand.product_id == body.product_id,
        CustomerDemand.customer == body.customer,
        CustomerDemand.period_date == month_start,
        CustomerDemand.source == "forecast",
    ).first()
    old_qty = cd.quantity if cd else None
    if cd:
        cd.quantity = body.qty
        cd.is_adjusted = True
    else:
        cd = CustomerDemand(
            product_id=body.product_id, customer=body.customer,
            period_date=month_start, quantity=body.qty, source="forecast",
            is_adjusted=True,
        )
        db.add(cd)
    db.flush()

    # Log to adjustment log
    db.add(ForecastAdjustLog(
        product_id=body.product_id,
        period_date=month_start,
        old_qty=old_qty,
        new_qty=body.qty,
        changed_by=body.adjusted_by,
        customer=body.customer,
    ))
    db.flush()

    # Re-sum all customer forecasts for this product+month → update the Forecast row
    total_qty = db.query(func.sum(CustomerDemand.quantity)).filter(
        CustomerDemand.product_id == body.product_id,
        CustomerDemand.source == "forecast",
        CustomerDemand.period_date == month_start,
    ).scalar() or 0.0

    latest_run = db.query(ForecastRun).order_by(ForecastRun.created_at.desc()).first()
    if latest_run:
        f = db.query(Forecast).filter(
            Forecast.product_id == body.product_id,
            Forecast.period_date == month_start,
            Forecast.run_id == latest_run.run_id,
        ).first()
        if f:
            f.is_adjusted = True
            f.adjusted_qty = total_qty
            f.adjusted_by = body.adjusted_by
            f.adjusted_at = datetime.utcnow()

    db.commit()
    return {"ok": True, "month": body.year_month, "customer": body.customer, "qty": body.qty, "sku_total": total_qty}


class CustomerForecastNote(BaseModel):
    product_id: int
    customer: str
    year_month: str  # "YYYY-MM"
    note: Optional[str]


@router.patch("/customer-forecast/note")
def set_customer_forecast_note(body: CustomerForecastNote, db: Session = Depends(get_db)):
    """Set or clear the note on a customer forecast cell."""
    try:
        year, month = int(body.year_month[:4]), int(body.year_month[5:7])
    except (ValueError, IndexError):
        raise HTTPException(400, "year_month must be YYYY-MM")
    month_start = date(year, month, 1)

    cd = db.query(CustomerDemand).filter(
        CustomerDemand.product_id == body.product_id,
        CustomerDemand.customer == body.customer,
        CustomerDemand.period_date == month_start,
        CustomerDemand.source == "forecast",
    ).first()
    if not cd:
        raise HTTPException(404, "Customer forecast row not found")
    cd.note = body.note

    # Also update the most recent log entry for this product+customer+period
    log_entry = db.query(ForecastAdjustLog).filter(
        ForecastAdjustLog.product_id == body.product_id,
        ForecastAdjustLog.customer == body.customer,
        ForecastAdjustLog.period_date == month_start,
    ).order_by(ForecastAdjustLog.changed_at.desc()).first()
    if not log_entry:
        # Fallback: old entries created before migration 005 have customer=NULL
        log_entry = db.query(ForecastAdjustLog).filter(
            ForecastAdjustLog.product_id == body.product_id,
            ForecastAdjustLog.period_date == month_start,
            ForecastAdjustLog.customer == None,
            ForecastAdjustLog.forecast_id == None,
        ).order_by(ForecastAdjustLog.changed_at.desc()).first()
        if log_entry:
            log_entry.customer = body.customer  # backfill the customer while we're here
    if log_entry:
        log_entry.note = body.note

    db.commit()
    return {"ok": True}


class CustomerForecastRevert(BaseModel):
    product_id: int
    customer: str
    year_month: str  # "YYYY-MM"


@router.delete("/customer-forecast/adjust")
def revert_customer_forecast(body: CustomerForecastRevert, db: Session = Depends(get_db)):
    """Revert a customer forecast back to its pre-adjustment value."""
    from sqlalchemy import func
    try:
        year, month = int(body.year_month[:4]), int(body.year_month[5:7])
    except (ValueError, IndexError):
        raise HTTPException(400, "year_month must be YYYY-MM")
    month_start = date(year, month, 1)

    cd = db.query(CustomerDemand).filter(
        CustomerDemand.product_id == body.product_id,
        CustomerDemand.customer == body.customer,
        CustomerDemand.period_date == month_start,
        CustomerDemand.source == "forecast",
    ).first()
    if not cd:
        raise HTTPException(404, "Customer forecast row not found")

    # Delete the CustomerDemand row — no per-customer statistical forecast exists,
    # so removing it makes the cell show "—" and the SKU aggregate falls back to ML forecast_qty.
    db.delete(cd)
    db.flush()

    # Re-aggregate remaining customers to the Forecast table
    total_qty = db.query(func.sum(CustomerDemand.quantity)).filter(
        CustomerDemand.product_id == body.product_id,
        CustomerDemand.source == "forecast",
        CustomerDemand.period_date == month_start,
    ).scalar() or 0.0

    latest_run = db.query(ForecastRun).order_by(ForecastRun.created_at.desc()).first()
    if latest_run:
        f = db.query(Forecast).filter(
            Forecast.product_id == body.product_id,
            Forecast.period_date == month_start,
            Forecast.run_id == latest_run.run_id,
        ).first()
        if f:
            still_adjusted = db.query(CustomerDemand).filter(
                CustomerDemand.product_id == body.product_id,
                CustomerDemand.source == "forecast",
                CustomerDemand.period_date == month_start,
                CustomerDemand.is_adjusted == True,
            ).first()
            if still_adjusted:
                f.adjusted_qty = total_qty
            else:
                f.is_adjusted = False
                f.adjusted_qty = None
                f.adjusted_by = None
                f.adjusted_at = None

    db.commit()
    return {"ok": True, "month": body.year_month, "customer": body.customer}


@router.get("/priority")
def get_priorities(db: Session = Depends(get_db)):
    """Return all (customer, product_id) priority pairs."""
    rows = db.query(CustomerPriority).all()
    return [{"customer": r.customer, "product_id": r.product_id} for r in rows]


class PriorityToggleRequest(BaseModel):
    customer: str
    product_id: int


@router.post("/priority/toggle")
def toggle_priority(body: PriorityToggleRequest, db: Session = Depends(get_db)):
    """Toggle priority for a customer/product pair. Returns the new state."""
    existing = db.query(CustomerPriority).filter(
        CustomerPriority.customer == body.customer,
        CustomerPriority.product_id == body.product_id,
    ).first()
    if existing:
        db.delete(existing)
        db.commit()
        return {"customer": body.customer, "product_id": body.product_id, "is_priority": False}
    else:
        row = CustomerPriority(customer=body.customer, product_id=body.product_id)
        db.add(row)
        db.commit()
        return {"customer": body.customer, "product_id": body.product_id, "is_priority": True}


@router.get("/customers")
def list_customers(db: Session = Depends(get_db)):
    """Return all distinct customer names that have demand records."""
    from sqlalchemy import distinct
    rows = db.query(distinct(CustomerDemand.customer)).order_by(CustomerDemand.customer).all()
    return [r[0] for r in rows]


@router.get("/pivot")
def demand_pivot(
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    granularity: str = "week",
    forecast_run_id: Optional[str] = None,
    group_by: str = "sku",  # "sku" | "customer"
    include_bom_children: bool = False,
    db: Session = Depends(get_db),
):
    today = date.today()
    if not from_date:
        from_date = today - timedelta(weeks=52)

    # When loading a specific historical run, use its creation date as the perspective
    # so columns are split at the run's horizon (not today's date).
    run = None
    if forecast_run_id:
        run = db.query(ForecastRun).filter(ForecastRun.run_id == forecast_run_id).first()
    else:
        run = db.query(ForecastRun).order_by(ForecastRun.created_at.desc()).first()

    perspective_date = today
    if run and run.created_at:
        run_date = run.created_at.date()
        # Only shift perspective for historical runs (created more than 2 months ago)
        if run_date < today.replace(day=1) - timedelta(days=1):
            perspective_date = run_date

    if not to_date:
        if run and run.periods_ahead:
            to_date = perspective_date + timedelta(weeks=run.periods_ahead * 4)
        else:
            to_date = today + timedelta(weeks=78)  # fallback: 18-month horizon

    products_q = db.query(Product).filter(Product.active == True)
    if not include_bom_children:
        child_ids = {r.child_product_id for r in db.query(BomItem.child_product_id).all()}
        if child_ids:
            products_q = products_q.filter(~Product.id.in_(child_ids))
    products = products_q.order_by(Product.sku).all()
    periods = _generate_periods(from_date, to_date, granularity, perspective_date)

    if group_by == "customer":
        return _pivot_by_customer(products, periods, from_date, to_date, perspective_date, granularity, db)

    # ── SKU-level pivot (original behaviour) ─────────────────────────────────
    actuals = db.query(SalesHistory).filter(
        SalesHistory.period_date >= from_date,
        SalesHistory.period_date <= perspective_date,
    ).all()
    # Prefer NULL-customer aggregate rows to avoid double-counting when both
    # aggregate (customer=NULL) and per-customer rows exist for the same period.
    null_map: dict[tuple, float] = {}
    cust_map: dict[tuple, float] = {}
    for a in actuals:
        pk = _period_key(a.period_date, granularity)
        key = (a.product_id, pk)
        if a.customer is None:
            null_map[key] = null_map.get(key, 0) + a.quantity
        else:
            cust_map[key] = cust_map.get(key, 0) + a.quantity
    # Also include named-customer CustomerDemand actuals (matches customer pivot behaviour)
    cd_actuals = db.query(CustomerDemand).filter(
        CustomerDemand.source == "actual",
        CustomerDemand.customer.isnot(None),
        CustomerDemand.period_date >= from_date,
        CustomerDemand.period_date <= perspective_date,
    ).all()
    for a in cd_actuals:
        pk = _period_key(a.period_date, granularity)
        key = (a.product_id, pk)
        cust_map[key] = cust_map.get(key, 0) + a.quantity
    # Prefer per-customer sum when available (matches Demand Planning aggregate chart)
    actuals_map: dict[tuple, float] = {}
    for key in set(null_map.keys()) | set(cust_map.keys()):
        actuals_map[key] = cust_map[key] if key in cust_map else null_map[key]

    fq = db.query(Forecast)
    if forecast_run_id:
        fq = fq.filter(Forecast.run_id == forecast_run_id)
    else:
        from sqlalchemy import func
        latest = (
            db.query(Forecast.product_id, func.max(Forecast.created_at).label("latest"))
            .group_by(Forecast.product_id)
            .subquery()
        )
        fq = fq.join(latest, (Forecast.product_id == latest.c.product_id) &
                     (Forecast.created_at == latest.c.latest))

    forecasts = fq.filter(
        Forecast.period_date >= perspective_date.replace(day=1),
        Forecast.period_date <= to_date,
    ).all()

    forecast_map: dict[tuple, dict] = {}
    product_model_map: dict[int, str] = {}
    for f in forecasts:
        pk = _period_key(f.period_date, granularity)
        key = (f.product_id, pk)
        qty = f.adjusted_qty if f.is_adjusted else f.forecast_qty
        if key not in forecast_map:
            forecast_map[key] = {
                "id": f.id, "qty": qty or 0.0,
                "original": f.forecast_qty or 0.0, "adjusted": f.is_adjusted,
                "lower": f.lower_bound or 0.0, "upper": f.upper_bound or 0.0,
                "note": f.adjusted_note if f.is_adjusted else None,
            }
        else:
            forecast_map[key]["qty"] = (forecast_map[key]["qty"] or 0.0) + (qty or 0.0)
            forecast_map[key]["original"] = (forecast_map[key]["original"] or 0.0) + (f.forecast_qty or 0.0)
            forecast_map[key]["lower"] = (forecast_map[key]["lower"] or 0.0) + (f.lower_bound or 0.0)
            forecast_map[key]["upper"] = (forecast_map[key]["upper"] or 0.0) + (f.upper_bound or 0.0)
            if f.is_adjusted:
                forecast_map[key]["adjusted"] = True
        if f.product_id not in product_model_map and f.model:
            product_model_map[f.product_id] = f.model

    # Build avg_daily_demand fallback per product
    from models import Inventory as _Inv
    inv_map: dict[int, float] = {}
    for inv in db.query(_Inv).all():
        if inv.avg_daily_demand:
            inv_map[inv.product_id] = round(inv.avg_daily_demand * 7, 2)

    rows = []
    for p in products:
        row: dict = {
            "product_id": p.id, "sku": p.sku, "description": p.description,
            "abc_class": p.abc_class, "supplier": p.supplier.name if p.supplier else None,
            "lead_time_days": p.lead_time_days, "safety_stock_qty": p.safety_stock_qty,
            "selling_price": p.selling_price or 0,
            "forecast_model": product_model_map.get(p.id),
        }
        for period in periods:
            pk = period["key"]
            if period["is_future"]:
                fd = forecast_map.get((p.id, pk), {})
                qty = fd.get("qty")
                # Fall back to avg_daily_demand when no forecast row exists for this period
                if qty is None:
                    qty = inv_map.get(p.id)
                row[f"f_{pk}"] = qty
                row[f"fl_{pk}"] = fd.get("lower")
                row[f"fu_{pk}"] = fd.get("upper")
                row[f"fa_{pk}"] = fd.get("adjusted", False)
                row[f"fid_{pk}"] = fd.get("id")
                row[f"fn_{pk}"] = fd.get("note")
            else:
                row[f"a_{pk}"] = actuals_map.get((p.id, pk))
        rows.append(row)

    return {"periods": periods, "rows": rows}


def _pivot_by_customer(products, periods, from_date, to_date, today, granularity, db):
    """Build pivot grouped by customer × SKU."""
    from sqlalchemy import distinct

    # Customers come from SalesHistory (uploaded actuals with customer field)
    # merged with any customers in CustomerDemand (forecast-only records).
    sh_customers = [
        r[0] for r in db.query(distinct(SalesHistory.customer))
        .filter(SalesHistory.customer.isnot(None))
        .order_by(SalesHistory.customer).all()
    ]
    cd_customers = [
        r[0] for r in db.query(distinct(CustomerDemand.customer))
        .order_by(CustomerDemand.customer).all()
    ]
    customers = sorted(set(sh_customers) | set(cd_customers))

    # Actuals come from SalesHistory (where customer is set)
    sh_actuals = db.query(SalesHistory).filter(
        SalesHistory.customer.isnot(None),
        SalesHistory.period_date >= from_date,
        SalesHistory.period_date <= today,
    ).all()
    actuals_map: dict[tuple, float] = {}  # (product_id, customer, period_key) -> qty
    for a in sh_actuals:
        pk = _period_key(a.period_date, granularity)
        key = (a.product_id, a.customer, pk)
        actuals_map[key] = actuals_map.get(key, 0) + a.quantity

    # Also merge any actuals stored directly in CustomerDemand
    cd_actuals = db.query(CustomerDemand).filter(
        CustomerDemand.source == "actual",
        CustomerDemand.period_date >= from_date,
        CustomerDemand.period_date <= today,
    ).all()
    for a in cd_actuals:
        pk = _period_key(a.period_date, granularity)
        key = (a.product_id, a.customer, pk)
        actuals_map[key] = actuals_map.get(key, 0) + a.quantity

    # Fetch customer forecasts
    forecasts = db.query(CustomerDemand).filter(
        CustomerDemand.source == "forecast",
        CustomerDemand.period_date >= today.replace(day=1),
        CustomerDemand.period_date <= to_date,
    ).all()
    forecast_map: dict[tuple, float] = {}  # (product_id, customer, period_key) -> qty
    adjusted_map: dict[tuple, bool] = {}   # (product_id, customer, period_key) -> is_adjusted
    note_map: dict[tuple, str | None] = {} # (product_id, customer, period_key) -> note
    for f in forecasts:
        pk = _period_key(f.period_date, granularity)
        key = (f.product_id, f.customer, pk)
        forecast_map[key] = forecast_map.get(key, 0) + f.quantity
        if f.is_adjusted:
            adjusted_map[key] = True
            note_map[key] = f.note

    priority_set = {(r.customer, r.product_id) for r in db.query(CustomerPriority).all()}

    rows = []
    for p in products:
        for customer in customers:
            row: dict = {
                "product_id": p.id, "sku": p.sku, "description": p.description,
                "abc_class": p.abc_class, "customer": customer,
                "lead_time_days": p.lead_time_days, "safety_stock_qty": p.safety_stock_qty,
                "is_priority": (customer, p.id) in priority_set,
            }
            for period in periods:
                pk = period["key"]
                if period["is_future"]:
                    key = (p.id, customer, pk)
                    row[f"f_{pk}"] = forecast_map.get(key)
                    row[f"fa_{pk}"] = adjusted_map.get(key, False)
                    row[f"fn_{pk}"] = note_map.get(key)
                else:
                    row[f"a_{pk}"] = actuals_map.get((p.id, customer, pk))
            rows.append(row)

    return {"periods": periods, "rows": rows, "customers": customers}


def _period_key(d: date, granularity: str) -> str:
    if granularity == "month":
        return d.strftime("%Y-%m")
    # ISO week
    iso = d.isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def _generate_periods(from_date: date, to_date: date, granularity: str, perspective_date: date = None) -> list[dict]:
    today = perspective_date or date.today()
    current_period_key = _period_key(today, granularity)
    periods = []
    current = from_date
    seen = set()
    while current <= to_date:
        pk = _period_key(current, granularity)
        if pk not in seen:
            seen.add(pk)
            # Current period is treated as future (forecast) since it's incomplete
            is_future = pk >= current_period_key
            if granularity == "month":
                label = current.strftime("%b %Y")
            else:
                iso = current.isocalendar()
                label = f"W{iso[1]:02d} '{str(iso[0])[2:]}"
            periods.append({"key": pk, "label": label, "is_future": is_future, "date": current.isoformat()})
        current += timedelta(weeks=1) if granularity == "week" else timedelta(days=32)
        if granularity == "month":
            current = current.replace(day=1)
    return periods
