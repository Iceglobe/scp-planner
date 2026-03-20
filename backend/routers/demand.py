from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import date, timedelta
from database import get_db
from models import SalesHistory, Product, Forecast, CustomerDemand, ForecastRun, BomItem

router = APIRouter()


class DemandRecord(BaseModel):
    product_id: int
    period_date: date
    quantity: float
    revenue: float = 0.0
    source: str = "actual"


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
         "quantity": r.quantity, "revenue": r.revenue, "source": r.source}
        for r in rows
    ]


@router.post("")
def create_demand(body: DemandRecord, db: Session = Depends(get_db)):
    existing = db.query(SalesHistory).filter(
        SalesHistory.product_id == body.product_id,
        SalesHistory.period_date == body.period_date,
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
        ).first()
        if existing:
            existing.quantity = r.quantity
            existing.revenue = r.revenue
        else:
            db.add(SalesHistory(**r.model_dump()))
    db.commit()
    return {"inserted": len(records)}


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
    if not to_date:
        # Use the forecast run's periods_ahead (in months) to set the horizon
        if forecast_run_id:
            run = db.query(ForecastRun).filter(ForecastRun.run_id == forecast_run_id).first()
        else:
            run = db.query(ForecastRun).order_by(ForecastRun.created_at.desc()).first()
        if run and run.periods_ahead:
            to_date = today + timedelta(weeks=run.periods_ahead * 4)
        else:
            to_date = today + timedelta(weeks=78)  # fallback: 18-month horizon

    products_q = db.query(Product).filter(Product.active == True)
    if not include_bom_children:
        child_ids = {r.child_product_id for r in db.query(BomItem.child_product_id).all()}
        if child_ids:
            products_q = products_q.filter(~Product.id.in_(child_ids))
    products = products_q.order_by(Product.sku).all()
    periods = _generate_periods(from_date, to_date, granularity)

    if group_by == "customer":
        return _pivot_by_customer(products, periods, from_date, to_date, today, granularity, db)

    # ── SKU-level pivot (original behaviour) ─────────────────────────────────
    actuals = db.query(SalesHistory).filter(
        SalesHistory.period_date >= from_date,
        SalesHistory.period_date <= today,
    ).all()
    actuals_map: dict[tuple, float] = {}
    for a in actuals:
        pk = _period_key(a.period_date, granularity)
        key = (a.product_id, pk)
        actuals_map[key] = actuals_map.get(key, 0) + a.quantity

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
        Forecast.period_date >= today,
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
            else:
                row[f"a_{pk}"] = actuals_map.get((p.id, pk))
        rows.append(row)

    return {"periods": periods, "rows": rows}


def _pivot_by_customer(products, periods, from_date, to_date, today, granularity, db):
    """Build pivot grouped by customer × SKU."""
    from sqlalchemy import distinct

    # Fetch all distinct customers
    customer_rows = db.query(distinct(CustomerDemand.customer)).order_by(CustomerDemand.customer).all()
    customers = [r[0] for r in customer_rows]

    # Fetch customer actuals
    actuals = db.query(CustomerDemand).filter(
        CustomerDemand.source == "actual",
        CustomerDemand.period_date >= from_date,
        CustomerDemand.period_date <= today,
    ).all()
    actuals_map: dict[tuple, float] = {}  # (product_id, customer, period_key) -> qty
    for a in actuals:
        pk = _period_key(a.period_date, granularity)
        key = (a.product_id, a.customer, pk)
        actuals_map[key] = actuals_map.get(key, 0) + a.quantity

    # Fetch customer forecasts
    forecasts = db.query(CustomerDemand).filter(
        CustomerDemand.source == "forecast",
        CustomerDemand.period_date > today,
        CustomerDemand.period_date <= to_date,
    ).all()
    forecast_map: dict[tuple, float] = {}  # (product_id, customer, period_key) -> qty
    for f in forecasts:
        pk = _period_key(f.period_date, granularity)
        key = (f.product_id, f.customer, pk)
        forecast_map[key] = forecast_map.get(key, 0) + f.quantity

    product_map = {p.id: p for p in products}
    rows = []
    for p in products:
        for customer in customers:
            row: dict = {
                "product_id": p.id, "sku": p.sku, "description": p.description,
                "abc_class": p.abc_class, "customer": customer,
                "lead_time_days": p.lead_time_days, "safety_stock_qty": p.safety_stock_qty,
            }
            for period in periods:
                pk = period["key"]
                if period["is_future"]:
                    row[f"f_{pk}"] = forecast_map.get((p.id, customer, pk))
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


def _generate_periods(from_date: date, to_date: date, granularity: str) -> list[dict]:
    today = date.today()
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
