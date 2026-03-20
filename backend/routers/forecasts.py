from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import date, timedelta, datetime
import uuid, statistics
from database import get_db
from models import Product, SalesHistory, Forecast, ForecastRun, ForecastAdjustLog
from algorithms.forecast_models import MODEL_FUNCTIONS, select_best_model, evaluate_forecast, confidence_bounds

router = APIRouter()


class ForecastRunRequest(BaseModel):
    product_ids: Optional[list[int]] = None
    model: str = "AUTO"
    periods: int = 12
    granularity: str = "week"


class ProductReforecastRequest(BaseModel):
    product_id: int
    model: str
    periods: int = 12
    granularity: str = "week"


class AdjustRequest(BaseModel):
    adjusted_qty: float
    adjusted_by: str = "user"


def _run_product_forecast(p: Product, model_name: str, periods: int, granularity: str,
                          run_id: str, today: date, db: Session,
                          prior_adjustments: dict = None):
    """Forecast a single product and write Forecast rows. Returns (mape, test_actuals, test_preds)."""
    # Exclude the current (incomplete) week so partial data doesn't drag models down
    current_week_start = today - timedelta(days=today.weekday())
    hist_rows = sorted(
        db.query(SalesHistory).filter(
            SalesHistory.product_id == p.id,
            SalesHistory.period_date < current_week_start,
        ).all(),
        key=lambda r: r.period_date,
    )
    history = [r.quantity for r in hist_rows]
    # Drop the last period if it looks like a partial week (< 30% of the mean of
    # the preceding periods). Happens when data is imported mid-week.
    if len(history) >= 4:
        mean_prior = sum(history[:-1]) / len(history[:-1])
        if mean_prior > 0 and history[-1] < 0.30 * mean_prior:
            history = history[:-1]
    if not history:
        # No sales data — fall back to avg_daily_demand from inventory, else flat zero
        from models import Inventory as _Inv
        inv = db.query(_Inv).filter(_Inv.product_id == p.id).first()
        avg_weekly = round((inv.avg_daily_demand or 0) * 7, 2) if inv else 0.0
        history = [avg_weekly] * 4  # minimal seed so model has something to project

    chosen_model = model_name if model_name != "AUTO" else select_best_model(history)
    fn = MODEL_FUNCTIONS.get(chosen_model, MODEL_FUNCTIONS["SMA"])

    mape = None
    test_actuals: list[float] = []
    test_preds: list[float] = []
    if len(history) >= 8:
        train, test = history[:-4], history[-4:]
        preds = fn(train, periods=4)
        metrics = evaluate_forecast(test, preds)
        mape = metrics.get("mape")
        test_actuals = list(test)
        test_preds = list(preds)

    std_dev = statistics.stdev(history[-12:]) if len(history) >= 2 else 0
    # Always generate weekly forecast rows — the pivot layer aggregates into months.
    # periods is always expressed in months, so convert to weeks.
    weekly_periods = periods * 4
    forecasts_out = fn(history, periods=weekly_periods)

    for i, qty in enumerate(forecasts_out):
        period_dt = today + timedelta(weeks=i)  # i=0 → current week

        lb, ub = confidence_bounds(qty, std_dev)

        # Carry over prior adjustment for this product+period if any
        prior = prior_adjustments.get((p.id, period_dt)) if prior_adjustments else None

        existing = db.query(Forecast).filter(
            Forecast.product_id == p.id,
            Forecast.period_date == period_dt,
            Forecast.run_id == run_id,
        ).first()
        if not existing:
            f = Forecast(
                product_id=p.id,
                run_id=run_id,
                model=chosen_model,
                period_date=period_dt,
                forecast_qty=qty,
                lower_bound=lb,
                upper_bound=ub,
            )
            if prior:
                f.is_adjusted = True
                f.adjusted_qty = prior["adjusted_qty"]
                f.adjusted_by = prior["adjusted_by"]
                f.adjusted_at = prior["adjusted_at"]
            db.add(f)

    return mape, test_actuals, test_preds


@router.post("/run")
def run_forecast(body: ForecastRunRequest, db: Session = Depends(get_db)):
    run_id = str(uuid.uuid4())
    today = date.today()

    products = db.query(Product).filter(Product.active == True)
    if body.product_ids:
        products = products.filter(Product.id.in_(body.product_ids))
    products = products.all()

    # Collect prior adjustments: (product_id, period_date) -> {adjusted_qty, adjusted_by, adjusted_at}
    prior_adj_rows = db.query(Forecast).filter(
        Forecast.is_adjusted == True,
        Forecast.period_date >= today,
    ).all()
    prior_adjustments: dict = {}
    for f in prior_adj_rows:
        key = (f.product_id, f.period_date)
        # Keep the most recent adjustment per product+period
        if key not in prior_adjustments or (f.adjusted_at and (prior_adjustments[key].get("adjusted_at") or datetime.min) < f.adjusted_at):
            prior_adjustments[key] = {
                "adjusted_qty": f.adjusted_qty,
                "adjusted_by": f.adjusted_by,
                "adjusted_at": f.adjusted_at,
            }

    all_test_actuals: list[float] = []
    all_test_preds: list[float] = []
    for p in products:
        _, test_actuals, test_preds = _run_product_forecast(
            p, body.model, body.periods, body.granularity,
            run_id, today, db, prior_adjustments,
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

    # Carry over prior adjustments for this product
    prior_adj_rows = db.query(Forecast).filter(
        Forecast.product_id == body.product_id,
        Forecast.is_adjusted == True,
        Forecast.period_date >= today,
    ).all()
    prior_adjustments = {
        (f.product_id, f.period_date): {
            "adjusted_qty": f.adjusted_qty,
            "adjusted_by": f.adjusted_by,
            "adjusted_at": f.adjusted_at,
        }
        for f in prior_adj_rows
    }

    mape, _, _ = _run_product_forecast(
        p, body.model, body.periods, body.granularity,
        run_id, today, db, prior_adjustments,
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


@router.get("/accuracy")
def forecast_accuracy(lag_weeks: int = 4, run_id: Optional[str] = None, db: Session = Depends(get_db)):
    """
    Compare forecasts against actual demand.
    If run_id is provided, compare that specific run. Otherwise use lag_weeks to find old runs.
    Returns per-product and overall MAPE / MAE / bias.
    """
    today = date.today()

    if run_id:
        specific_run = db.query(ForecastRun).filter(ForecastRun.run_id == run_id).first()
        if not specific_run:
            return {"lag_weeks": lag_weeks, "runs_found": 0, "products": [], "overall": None}
        old_runs = [specific_run]
    else:
        lag_start = today - timedelta(weeks=lag_weeks + 1)
        lag_end   = today - timedelta(weeks=lag_weeks - 1)
        old_runs = db.query(ForecastRun).filter(
            ForecastRun.created_at >= lag_start,
            ForecastRun.created_at <= lag_end,
        ).all()

    if not old_runs:
        return {"lag_weeks": lag_weeks, "runs_found": 0, "products": [], "overall": None}

    run_ids = [r.run_id for r in old_runs]

    # Fetch forecasts from those runs whose period has now passed (we have actuals)
    old_forecasts = db.query(Forecast).filter(
        Forecast.run_id.in_(run_ids),
        Forecast.period_date <= today,
        Forecast.period_date >= today - timedelta(weeks=lag_weeks + 8),
    ).all()

    # Build actuals map: (product_id, period_date) -> quantity
    actuals_raw = db.query(SalesHistory).filter(
        SalesHistory.period_date <= today,
        SalesHistory.period_date >= today - timedelta(weeks=lag_weeks + 8),
    ).all()
    actuals_map = {(a.product_id, a.period_date): a.quantity for a in actuals_raw}

    # Compute per-product errors
    product_errors: dict = {}
    for f in old_forecasts:
        actual = actuals_map.get((f.product_id, f.period_date))
        if actual is None:
            continue
        used_qty = f.adjusted_qty if f.is_adjusted else f.forecast_qty
        error = actual - used_qty
        pid = f.product_id
        if pid not in product_errors:
            product_errors[pid] = {"actuals": [], "forecasts": [], "product": f.product}
        product_errors[pid]["actuals"].append(actual)
        product_errors[pid]["forecasts"].append(used_qty)

    products_out = []
    all_actuals, all_forecasts = [], []
    for pid, d in product_errors.items():
        metrics = evaluate_forecast(d["actuals"], d["forecasts"])
        p = d["product"]
        products_out.append({
            "product_id": pid,
            "sku": p.sku if p else None,
            "description": p.description if p else None,
            "abc_class": p.abc_class if p else None,
            "periods_compared": len(d["actuals"]),
            "mape": metrics["mape"],
            "mae": metrics["mae"],
            "bias": metrics["bias"],
        })
        all_actuals.extend(d["actuals"])
        all_forecasts.extend(d["forecasts"])

    overall = evaluate_forecast(all_actuals, all_forecasts) if all_actuals else None
    products_out.sort(key=lambda x: (x["mape"] or 9999))

    return {
        "lag_weeks": lag_weeks,
        "runs_found": len(old_runs),
        "run_dates": [r.created_at.isoformat() for r in old_runs if r.created_at],
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


@router.put("/adjust-month")
def adjust_month(body: AdjustMonthRequest, db: Session = Depends(get_db)):
    """
    Distribute a monthly forecast total equally across all weekly Forecast rows
    in that calendar month. E.g. entering 700 for March with 4 weeks → 175/week.
    """
    from calendar import monthrange as _mr
    try:
        year, month = int(body.year_month[:4]), int(body.year_month[5:7])
    except (ValueError, IndexError):
        raise HTTPException(400, "year_month must be YYYY-MM")

    _, days_in_month = _mr(year, month)
    month_start = date(year, month, 1)
    month_end = date(year, month, days_in_month)

    fq = db.query(Forecast).filter(
        Forecast.product_id == body.product_id,
        Forecast.period_date >= month_start,
        Forecast.period_date <= month_end,
    )
    if body.run_id:
        fq = fq.filter(Forecast.run_id == body.run_id)
    else:
        latest_run = db.query(ForecastRun).order_by(ForecastRun.created_at.desc()).first()
        if latest_run:
            fq = fq.filter(Forecast.run_id == latest_run.run_id)

    forecasts = fq.order_by(Forecast.period_date).all()
    if not forecasts:
        raise HTTPException(404, "No forecast records found for this month — run a forecast first")

    per_week = round(body.total_qty / len(forecasts), 4)
    now = datetime.utcnow()
    for f in forecasts:
        old_qty = f.adjusted_qty if f.is_adjusted else f.forecast_qty
        f.is_adjusted = True
        f.adjusted_qty = per_week
        f.adjusted_by = body.adjusted_by
        f.adjusted_at = now
        db.add(ForecastAdjustLog(
            forecast_id=f.id, product_id=f.product_id, period_date=f.period_date,
            old_qty=old_qty, new_qty=per_week, changed_by=body.adjusted_by,
        ))

    db.commit()
    return {"ok": True, "weeks_updated": len(forecasts), "per_week_qty": per_week}


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

    log = ForecastAdjustLog(
        forecast_id=fid,
        product_id=f.product_id,
        period_date=f.period_date,
        old_qty=old_qty,
        new_qty=body.adjusted_qty,
        changed_by=body.adjusted_by,
    )
    db.add(log)
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
            "changed_at": r.changed_at.isoformat() if r.changed_at else None,
        }
        for r in rows
    ]
