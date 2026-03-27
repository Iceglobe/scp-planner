from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import date, timedelta, datetime
import uuid, statistics
from database import get_db
from models import Product, SalesHistory, Forecast, ForecastRun, ForecastAdjustLog, CustomerDemand
from algorithms.forecast_models import MODEL_FUNCTIONS, select_best_model, evaluate_forecast, confidence_bounds

router = APIRouter()


class ForecastRunRequest(BaseModel):
    product_ids: Optional[list[int]] = None
    model: str = "AUTO"
    periods: int = 12
    granularity: str = "week"
    as_of_date: Optional[str] = None  # "YYYY-MM-DD" — treat this date as "today" for historical runs


class ProductReforecastRequest(BaseModel):
    product_id: int
    model: str
    periods: int = 12
    granularity: str = "week"


class AdjustRequest(BaseModel):
    adjusted_qty: float
    adjusted_by: str = "user"
    note: Optional[str] = None


def _monthly_periods(current_month_start: date, n: int) -> list[date]:
    """Return the 1st-of-month dates for n months starting from current_month_start."""
    out = []
    for i in range(n):
        year = current_month_start.year + (current_month_start.month - 1 + i) // 12
        month = (current_month_start.month - 1 + i) % 12 + 1
        out.append(date(year, month, 1))
    return out


def _aggregate_monthly(rows, key_fn) -> dict[str, float]:
    """Aggregate rows into {YYYY-MM: total_qty} using key_fn(row) -> period_date."""
    totals: dict[str, float] = {}
    for r in rows:
        k = key_fn(r).strftime("%Y-%m")
        totals[k] = totals.get(k, 0) + r.quantity
    return totals


def _trim_history(history: list[float]) -> list[float]:
    if len(history) >= 4:
        mean_prior = sum(history[:-1]) / len(history[:-1])
        if mean_prior > 0 and history[-1] < 0.30 * mean_prior:
            return history[:-1]
    return history


def _run_product_forecast(p: Product, model_name: str, periods: int, granularity: str,
                          run_id: str, today: date, db: Session):
    """Forecast a single product per customer. Stores monthly rows in CustomerDemand
    (source='forecast') and aggregates into the Forecast table for MRP."""
    current_month_start = today.replace(day=1)
    period_dates = _monthly_periods(current_month_start, periods)

    hist_rows = db.query(SalesHistory).filter(
        SalesHistory.product_id == p.id,
        SalesHistory.period_date < current_month_start,
    ).all()

    # Separate history by customer
    by_customer: dict[str, list] = {}
    agg_rows = []
    for r in hist_rows:
        if r.customer:
            by_customer.setdefault(r.customer, []).append(r)
        agg_rows.append(r)

    # Overall aggregate history (all customers combined) for model selection + fallback
    agg_monthly = _aggregate_monthly(agg_rows, lambda r: r.period_date)
    agg_history = _trim_history([v for _, v in sorted(agg_monthly.items())])

    if not agg_history:
        from models import Inventory as _Inv
        inv = db.query(_Inv).filter(_Inv.product_id == p.id).first()
        avg_monthly = round((inv.avg_daily_demand or 0) * 30.5, 2) if inv else 0.0
        agg_history = [avg_monthly] * 4

    chosen_model = model_name if model_name != "AUTO" else select_best_model(agg_history)
    fn = MODEL_FUNCTIONS.get(chosen_model, MODEL_FUNCTIONS["SMA"])

    # MAPE on aggregate history
    mape = None
    test_actuals: list[float] = []
    test_preds: list[float] = []
    if len(agg_history) >= 8:
        train, test = agg_history[:-4], agg_history[-4:]
        preds = fn(train, periods=4)
        metrics = evaluate_forecast(test, preds)
        mape = metrics.get("mape")
        test_actuals = list(test)
        test_preds = list(preds)

    agg_std_dev = statistics.stdev(agg_history[-12:]) if len(agg_history) >= 2 else 0

    # ── Per-customer forecasts → CustomerDemand ──────────────────────────────
    # Each new run is a clean snapshot — delete all existing forecast rows and regenerate.
    db.query(CustomerDemand).filter(
        CustomerDemand.product_id == p.id,
        CustomerDemand.source == "forecast",
    ).delete(synchronize_session=False)

    # Maps period_date → aggregated qty across all customers (for Forecast table)
    agg_by_period: dict[date, float] = {pd: 0.0 for pd in period_dates}

    if by_customer:
        for customer, crows in by_customer.items():
            cust_monthly = _aggregate_monthly(crows, lambda r: r.period_date)
            cust_history = _trim_history([v for _, v in sorted(cust_monthly.items())])
            if not cust_history:
                cust_history = [0.0] * 4
            cust_fn = MODEL_FUNCTIONS.get(chosen_model, MODEL_FUNCTIONS["SMA"])
            cust_forecasts = cust_fn(cust_history, periods=periods)
            for period_dt, qty in zip(period_dates, cust_forecasts):
                qty = max(0.0, round(qty, 4))
                db.add(CustomerDemand(
                    product_id=p.id, customer=customer,
                    period_date=period_dt, quantity=qty, source="forecast",
                ))
                agg_by_period[period_dt] = agg_by_period.get(period_dt, 0.0) + qty
    else:
        # No customer-level data — use aggregate forecast as the only figure
        agg_forecasts = fn(agg_history, periods=periods)
        for period_dt, qty in zip(period_dates, agg_forecasts):
            agg_by_period[period_dt] = max(0.0, round(qty, 4))

    # ── SKU-level Forecast rows (aggregate, used by MRP) ─────────────────────
    agg_forecasts_list = [agg_by_period[pd] for pd in period_dates]
    for period_dt, qty in zip(period_dates, agg_forecasts_list):
        lb, ub = confidence_bounds(qty, agg_std_dev)
        existing = db.query(Forecast).filter(
            Forecast.product_id == p.id,
            Forecast.period_date == period_dt,
            Forecast.run_id == run_id,
        ).first()
        if not existing:
            db.add(Forecast(
                product_id=p.id, run_id=run_id, model=chosen_model,
                period_date=period_dt, forecast_qty=qty,
                lower_bound=lb, upper_bound=ub,
            ))

    return mape, test_actuals, test_preds


@router.post("/run")
def run_forecast(body: ForecastRunRequest, db: Session = Depends(get_db)):
    run_id = str(uuid.uuid4())
    if body.as_of_date:
        today = date.fromisoformat(body.as_of_date)
    else:
        today = date.today()

    products = db.query(Product).filter(Product.active == True)
    if body.product_ids:
        products = products.filter(Product.id.in_(body.product_ids))
    products = products.all()

    all_test_actuals: list[float] = []
    all_test_preds: list[float] = []
    for p in products:
        _, test_actuals, test_preds = _run_product_forecast(
            p, body.model, body.periods, body.granularity,
            run_id, today, db,
        )
        all_test_actuals.extend(test_actuals)
        all_test_preds.extend(test_preds)

    agg_metrics = evaluate_forecast(all_test_actuals, all_test_preds) if all_test_actuals else {}
    avg_mape = round(agg_metrics["mape"], 2) if agg_metrics.get("mape") is not None else None

    run = ForecastRun(
        run_id=run_id,
        model=body.model,
        periods_ahead=body.periods,
        granularity=body.granularity,
        mape=avg_mape,
    )
    db.add(run)
    db.commit()

    return {"run_id": run_id, "products_forecasted": len(products), "mape": avg_mape}


@router.post("/run-product")
def reforecast_product(body: ProductReforecastRequest, db: Session = Depends(get_db)):
    """Re-run forecast for a single product with a specific model, appended to the latest run."""
    today = date.today()

    p = db.query(Product).filter(Product.id == body.product_id, Product.active == True).first()
    if not p:
        raise HTTPException(404, "Product not found")

    # Find latest run_id to append into
    latest_run = db.query(ForecastRun).order_by(ForecastRun.created_at.desc()).first()
    if not latest_run:
        raise HTTPException(400, "No forecast run exists — run a full forecast first")
    run_id = latest_run.run_id

    # Delete existing forecasts for this product in the latest run
    db.query(Forecast).filter(
        Forecast.product_id == body.product_id,
        Forecast.run_id == run_id,
    ).delete()
    db.flush()

    mape, _, _ = _run_product_forecast(
        p, body.model, body.periods, body.granularity,
        run_id, today, db,
    )
    db.commit()
    return {"run_id": run_id, "product_id": body.product_id, "model": body.model, "mape": mape}


@router.get("/runs")
def list_runs(db: Session = Depends(get_db)):
    runs = db.query(ForecastRun).order_by(ForecastRun.created_at.desc()).limit(100).all()
    return [
        {"run_id": r.run_id, "name": r.name, "model": r.model, "periods_ahead": r.periods_ahead,
         "granularity": r.granularity, "mape": r.mape,
         "created_at": r.created_at.isoformat() if r.created_at else None}
        for r in runs
    ]


class SaveRunRequest(BaseModel):
    name: str


@router.patch("/runs/{run_id}/created-at")
def patch_run_created_at(run_id: str, body: dict, db: Session = Depends(get_db)):
    run = db.query(ForecastRun).filter(ForecastRun.run_id == run_id).first()
    if not run:
        raise HTTPException(404, "Run not found")
    from datetime import datetime as _dt
    run.created_at = _dt.fromisoformat(body["created_at"])
    db.commit()
    return {"ok": True, "run_id": run_id, "created_at": run.created_at.isoformat()}


@router.put("/runs/{run_id}/save")
def save_run(run_id: str, body: SaveRunRequest, db: Session = Depends(get_db)):
    run = db.query(ForecastRun).filter(ForecastRun.run_id == run_id).first()
    if not run:
        raise HTTPException(404, "Run not found")

    # Enforce max 5 named saves (excluding the run being saved/renamed)
    named_runs = (
        db.query(ForecastRun)
        .filter(ForecastRun.name != None, ForecastRun.run_id != run_id)
        .order_by(ForecastRun.created_at.asc())
        .all()
    )
    if len(named_runs) >= 5:
        # Delete the oldest named run to make room
        oldest = named_runs[0]
        db.query(Forecast).filter(Forecast.run_id == oldest.run_id).delete()
        db.delete(oldest)

    run.name = body.name.strip()
    db.commit()
    return {"run_id": run_id, "name": run.name}


@router.delete("/runs/{run_id}")
def delete_run(run_id: str, db: Session = Depends(get_db)):
    run = db.query(ForecastRun).filter(ForecastRun.run_id == run_id).first()
    if not run:
        raise HTTPException(404, "Run not found")
    db.query(Forecast).filter(Forecast.run_id == run_id).delete()
    db.delete(run)
    db.commit()
    return {"ok": True, "run_id": run_id}


@router.get("/accuracy")
def forecast_accuracy(lag_weeks: int = 4, run_id: Optional[str] = None, period: Optional[str] = None, db: Session = Depends(get_db)):
    """
    Compare forecasts against actual demand.
    If run_id is provided, compare all forecast periods from that run that now have actuals.
    Otherwise use lag_weeks to find old runs within a rolling window.
    Returns per-product (with customer breakdown) and overall MAPE / MAE / bias.
    """
    today = date.today()

    if run_id:
        specific_run = db.query(ForecastRun).filter(ForecastRun.run_id == run_id).first()
        if not specific_run:
            return {"lag_weeks": lag_weeks, "runs_found": 0, "products": [], "overall": None}
        old_runs = [specific_run]
        # For a specific run: look at all forecast periods that have now passed
        earliest_date = date(2000, 1, 1)
    else:
        lag_start = today - timedelta(weeks=lag_weeks + 1)
        lag_end   = today - timedelta(weeks=lag_weeks - 1)
        old_runs = db.query(ForecastRun).filter(
            ForecastRun.created_at >= lag_start,
            ForecastRun.created_at <= lag_end,
        ).all()
        earliest_date = today - timedelta(weeks=lag_weeks + 8)

    if not old_runs:
        return {"lag_weeks": lag_weeks, "runs_found": 0, "products": [], "overall": None}

    run_ids = [r.run_id for r in old_runs]

    # Fetch all forecast rows whose period has now passed (used to determine available periods)
    all_past_forecasts = db.query(Forecast).filter(
        Forecast.run_id.in_(run_ids),
        Forecast.period_date < today.replace(day=1),
        Forecast.period_date >= earliest_date,
    ).all()

    # Derive available periods for the frontend dropdown
    available_periods = sorted({f.period_date.strftime("%Y-%m") for f in all_past_forecasts})

    # Filter to a specific period if requested
    if period:
        old_forecasts = [f for f in all_past_forecasts if f.period_date.strftime("%Y-%m") == period]
    else:
        old_forecasts = all_past_forecasts

    # Build actuals map keyed by (product_id, "YYYY-MM") — aggregate weekly rows into months
    actuals_raw = db.query(SalesHistory).filter(
        SalesHistory.period_date < today.replace(day=1),
        SalesHistory.period_date >= earliest_date,
    ).all()
    actuals_map: dict[tuple, float] = {}          # (product_id, "YYYY-MM") -> qty
    cust_actuals_map: dict[tuple, float] = {}      # (product_id, customer, "YYYY-MM") -> qty
    for a in actuals_raw:
        ym = a.period_date.strftime("%Y-%m")
        key = (a.product_id, ym)
        actuals_map[key] = actuals_map.get(key, 0.0) + (a.quantity or 0.0)
        if a.customer:
            ckey = (a.product_id, a.customer, ym)
            cust_actuals_map[ckey] = cust_actuals_map.get(ckey, 0.0) + (a.quantity or 0.0)

    # Build forecast map keyed by (product_id, "YYYY-MM")
    forecast_by_ym: dict[tuple, float] = {}
    forecast_product_map: dict[int, object] = {}
    for f in old_forecasts:
        ym = f.period_date.strftime("%Y-%m")
        key = (f.product_id, ym)
        used_qty = f.adjusted_qty if f.is_adjusted else f.forecast_qty
        forecast_by_ym[key] = (forecast_by_ym.get(key) or 0.0) + (used_qty or 0.0)
        if f.product_id not in forecast_product_map:
            forecast_product_map[f.product_id] = f.product

    # Compute per-product errors (matched by YYYY-MM)
    product_errors: dict = {}
    for (pid, ym), actual in actuals_map.items():
        forecast = forecast_by_ym.get((pid, ym))
        if forecast is None:
            continue
        if pid not in product_errors:
            product_errors[pid] = {"actuals": [], "forecasts": [], "product": forecast_product_map.get(pid)}
        product_errors[pid]["actuals"].append(actual)
        product_errors[pid]["forecasts"].append(forecast)

    # Per-customer errors: distribute SKU forecast proportionally by customer's actual share
    cust_errors: dict[tuple, dict] = {}  # (pid, customer) -> {actuals, forecasts}
    for (pid, customer, ym), actual_qty in cust_actuals_map.items():
        sku_forecast = forecast_by_ym.get((pid, ym))
        if sku_forecast is None:
            continue
        total_actual = actuals_map.get((pid, ym), 0.0)
        if total_actual <= 0:
            continue
        cust_forecast_share = sku_forecast * (actual_qty / total_actual)
        ck = (pid, customer)
        if ck not in cust_errors:
            cust_errors[ck] = {"actuals": [], "forecasts": [], "customer": customer}
        cust_errors[ck]["actuals"].append(actual_qty)
        cust_errors[ck]["forecasts"].append(cust_forecast_share)

    products_out = []
    all_actuals, all_forecasts = [], []
    for pid, d in product_errors.items():
        metrics = evaluate_forecast(d["actuals"], d["forecasts"])
        p = d["product"]
        # Build customer breakdown for this product
        customers_out = []
        for (cpid, customer), cd in cust_errors.items():
            if cpid != pid:
                continue
            cm = evaluate_forecast(cd["actuals"], cd["forecasts"])
            customers_out.append({
                "customer": customer,
                "periods_compared": len(cd["actuals"]),
                "total_actual": round(sum(cd["actuals"]), 1),
                "total_forecast": round(sum(cd["forecasts"]), 1),
                "mape": cm["mape"],
                "mae": cm["mae"],
                "bias": cm["bias"],
            })
        customers_out.sort(key=lambda x: x["customer"] or "")
        products_out.append({
            "product_id": pid,
            "sku": p.sku if p else None,
            "description": p.description if p else None,
            "abc_class": p.abc_class if p else None,
            "periods_compared": len(d["actuals"]),
            "total_actual": round(sum(d["actuals"]), 1),
            "total_forecast": round(sum(d["forecasts"]), 1),
            "mape": metrics["mape"],
            "mae": metrics["mae"],
            "bias": metrics["bias"],
            "customers": customers_out,
        })
        all_actuals.extend(d["actuals"])
        all_forecasts.extend(d["forecasts"])

    overall = evaluate_forecast(all_actuals, all_forecasts) if all_actuals else None
    products_out.sort(key=lambda x: (x["mape"] or 9999))

    return {
        "lag_weeks": lag_weeks,
        "runs_found": len(old_runs),
        "run_dates": [r.created_at.isoformat() for r in old_runs if r.created_at],
        "available_periods": available_periods,
        "selected_period": period,
        "products": products_out,
        "overall": overall,
    }


@router.get("")
def list_forecasts(
    product_id: Optional[int] = None,
    run_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = db.query(Forecast)
    if product_id:
        q = q.filter(Forecast.product_id == product_id)
    if run_id:
        q = q.filter(Forecast.run_id == run_id)
    rows = q.order_by(Forecast.period_date).limit(500).all()
    return [
        {"id": r.id, "product_id": r.product_id, "run_id": r.run_id, "model": r.model,
         "period_date": r.period_date.isoformat(), "forecast_qty": r.forecast_qty,
         "lower_bound": r.lower_bound, "upper_bound": r.upper_bound,
         "is_adjusted": r.is_adjusted, "adjusted_qty": r.adjusted_qty,
         "adjusted_by": r.adjusted_by,
         "adjusted_at": r.adjusted_at.isoformat() if r.adjusted_at else None}
        for r in rows
    ]


class AdjustMonthRequest(BaseModel):
    product_id: int
    year_month: str        # "YYYY-MM"
    total_qty: float
    run_id: Optional[str] = None
    adjusted_by: str = "user"
    note: Optional[str] = None


@router.put("/adjust-month")
def adjust_month(body: AdjustMonthRequest, db: Session = Depends(get_db)):
    """Update the single monthly Forecast row for a product/month."""
    try:
        year, month = int(body.year_month[:4]), int(body.year_month[5:7])
    except (ValueError, IndexError):
        raise HTTPException(400, "year_month must be YYYY-MM")

    month_start = date(year, month, 1)

    fq = db.query(Forecast).filter(
        Forecast.product_id == body.product_id,
        Forecast.period_date == month_start,
    )
    if body.run_id:
        fq = fq.filter(Forecast.run_id == body.run_id)
    else:
        latest_run = db.query(ForecastRun).order_by(ForecastRun.created_at.desc()).first()
        if latest_run:
            fq = fq.filter(Forecast.run_id == latest_run.run_id)

    f = fq.first()
    if not f:
        raise HTTPException(404, "No forecast record found for this month — run a forecast first")

    old_qty = f.adjusted_qty if f.is_adjusted else f.forecast_qty
    f.is_adjusted = True
    f.adjusted_qty = body.total_qty
    f.adjusted_by = body.adjusted_by
    f.adjusted_at = datetime.utcnow()
    f.adjusted_note = body.note or None
    db.add(ForecastAdjustLog(
        forecast_id=f.id, product_id=f.product_id, period_date=f.period_date,
        old_qty=old_qty, new_qty=body.total_qty, changed_by=body.adjusted_by, note=body.note or None,
    ))
    db.commit()
    return {"ok": True, "month": body.year_month, "total_qty": body.total_qty}


class RevertMonthRequest(BaseModel):
    product_id: int
    year_month: str
    run_id: Optional[str] = None


@router.delete("/adjust-month")
def revert_month(body: RevertMonthRequest, db: Session = Depends(get_db)):
    """Revert a monthly forecast back to the statistical (un-adjusted) value."""
    try:
        year, month = int(body.year_month[:4]), int(body.year_month[5:7])
    except (ValueError, IndexError):
        raise HTTPException(400, "year_month must be YYYY-MM")
    month_start = date(year, month, 1)
    fq = db.query(Forecast).filter(
        Forecast.product_id == body.product_id,
        Forecast.period_date == month_start,
    )
    if body.run_id:
        fq = fq.filter(Forecast.run_id == body.run_id)
    else:
        latest_run = db.query(ForecastRun).order_by(ForecastRun.created_at.desc()).first()
        if latest_run:
            fq = fq.filter(Forecast.run_id == latest_run.run_id)
    f = fq.first()
    if not f:
        raise HTTPException(404)
    f.is_adjusted = False
    f.adjusted_qty = None
    f.adjusted_by = None
    f.adjusted_at = None
    f.adjusted_note = None
    db.commit()
    return {"ok": True, "forecast_qty": f.forecast_qty}


@router.put("/{fid}/adjust")
def adjust_forecast(fid: int, body: AdjustRequest, db: Session = Depends(get_db)):
    f = db.query(Forecast).filter(Forecast.id == fid).first()
    if not f:
        raise HTTPException(404)
    old_qty = f.adjusted_qty if f.is_adjusted else f.forecast_qty
    f.is_adjusted = True
    f.adjusted_qty = body.adjusted_qty
    f.adjusted_by = body.adjusted_by
    f.adjusted_at = datetime.utcnow()
    f.adjusted_note = body.note or None

    log = ForecastAdjustLog(
        forecast_id=fid,
        product_id=f.product_id,
        period_date=f.period_date,
        old_qty=old_qty,
        new_qty=body.adjusted_qty,
        changed_by=body.adjusted_by,
        note=body.note or None,
    )
    db.add(log)
    db.commit()
    return {"ok": True}


class NoteRequest(BaseModel):
    note: Optional[str] = None


@router.patch("/{fid}/note")
def set_forecast_note(fid: int, body: NoteRequest, db: Session = Depends(get_db)):
    f = db.query(Forecast).filter(Forecast.id == fid).first()
    if not f:
        raise HTTPException(404)
    f.adjusted_note = body.note or None
    # Update the most recent adjustment log entry for this forecast
    log_entry = (
        db.query(ForecastAdjustLog)
        .filter(ForecastAdjustLog.forecast_id == fid)
        .order_by(ForecastAdjustLog.changed_at.desc())
        .first()
    )
    if not log_entry:
        # Fallback: match by product + period (covers older entries where forecast_id may be null)
        log_entry = (
            db.query(ForecastAdjustLog)
            .filter(
                ForecastAdjustLog.product_id == f.product_id,
                ForecastAdjustLog.period_date == f.period_date,
                ForecastAdjustLog.customer == None,
            )
            .order_by(ForecastAdjustLog.changed_at.desc())
            .first()
        )
    if log_entry:
        log_entry.note = body.note or None
    else:
        # No prior log entry — create one so the note is always recorded
        db.add(ForecastAdjustLog(
            forecast_id=fid,
            product_id=f.product_id,
            period_date=f.period_date,
            old_qty=f.adjusted_qty if f.is_adjusted else f.forecast_qty,
            new_qty=f.adjusted_qty if f.is_adjusted else f.forecast_qty,
            changed_by=f.adjusted_by or "user",
            note=body.note or None,
        ))
    db.commit()
    return {"ok": True}


@router.get("/adjustment-log")
def adjustment_log(product_id: Optional[int] = None, limit: int = 100,
                   db: Session = Depends(get_db)):
    q = db.query(ForecastAdjustLog)
    if product_id:
        q = q.filter(ForecastAdjustLog.product_id == product_id)
    rows = q.order_by(ForecastAdjustLog.changed_at.desc()).limit(limit).all()
    return [
        {
            "id": r.id,
            "product_id": r.product_id,
            "sku": r.product.sku if r.product else None,
            "description": r.product.description if r.product else None,
            "period_date": r.period_date.isoformat(),
            "old_qty": r.old_qty,
            "new_qty": r.new_qty,
            "changed_by": r.changed_by,
            "note": r.note,
            "customer": r.customer,
            "changed_at": r.changed_at.isoformat() if r.changed_at else None,
        }
        for r in rows
    ]
