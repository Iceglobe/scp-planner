"""
Forecast Models: SMA, Holt-Winters (auto baseline/trend/seasonality), ARIMA
- Model selection: lowest MAPE on 4-period hold-out; falls back to MAE for zero-demand periods
- Holt-Winters tries multiple ETS configurations and selects the best by hold-out MAE
"""
import warnings
from typing import Optional


# ── Parameter optimisation ────────────────────────────────────────────────────

def _best_alpha(history: list[float]) -> float:
    """Grid-search alpha for single exponential smoothing (minimise MAE on 3-period hold-out)."""
    if len(history) < 6:
        return 0.3
    train, test = history[:-3], history[-3:]
    best_a, best_mae = 0.3, float("inf")
    for a_tenth in range(1, 10):          # 0.1 … 0.9
        a = a_tenth / 10
        level = train[0]
        for obs in train[1:]:
            level = a * obs + (1 - a) * level
        mae = sum(abs(test[i] - level) for i in range(len(test))) / len(test)
        if mae < best_mae:
            best_mae, best_a = mae, a
    return best_a


def _best_alpha_beta(history: list[float]) -> tuple[float, float]:
    """Grid-search alpha + beta for Holt's linear trend (minimise MAE on 3-period hold-out)."""
    if len(history) < 6:
        return 0.3, 0.1
    train, test = history[:-3], history[-3:]
    best_a, best_b, best_mae = 0.3, 0.1, float("inf")
    for a_tenth in range(1, 10):          # alpha: 0.1 … 0.9
        for b_tenth in range(1, 6):       # beta:  0.1 … 0.5 (rarely needs higher)
            a, b = a_tenth / 10, b_tenth / 10
            level = train[0]
            trend = train[1] - train[0] if len(train) >= 2 else 0.0
            for obs in train[1:]:
                prev = level
                level = a * obs + (1 - a) * (level + trend)
                trend = b * (level - prev) + (1 - b) * trend
            preds = [max(0.0, level + h * trend) for h in range(1, len(test) + 1)]
            mae = sum(abs(test[i] - preds[i]) for i in range(len(test))) / len(test)
            if mae < best_mae:
                best_mae, best_a, best_b = mae, a, b
    return best_a, best_b


# ── Model implementations ─────────────────────────────────────────────────────

def forecast_sma(history: list[float], periods: int, window: int = 8) -> list[float]:
    if not history:
        return [0.0] * periods
    cleaned = _remove_outliers(history)
    w = min(window, len(cleaned))
    avg = sum(cleaned[-w:]) / w
    return [round(avg, 2)] * periods



def forecast_ets(history: list[float], periods: int, alpha: Optional[float] = None) -> list[float]:
    if not history:
        return [0.0] * periods
    if alpha is None:
        alpha = _best_alpha(history)
    level = history[0]
    for obs in history[1:]:
        level = alpha * obs + (1 - alpha) * level
    return [round(level, 2)] * periods


def _remove_outliers(history: list[float]) -> list[float]:
    """Remove values outside mean ± 2 std dev so they don't destabilise level estimation."""
    import numpy as np
    arr = np.array(history, dtype=float)
    if len(arr) < 4:
        return history
    mean, std = float(np.mean(arr)), float(np.std(arr))
    if std == 0:
        return history
    lo = max(0.0, mean - 2.0 * std)
    hi = mean + 2.0 * std
    filtered = [v for v in history if lo <= v <= hi]
    return filtered if filtered else history


def forecast_holt_winters(
    history: list[float],
    periods: int,
    alpha: Optional[float] = None,
    beta: Optional[float] = None,
    phi: float = 0.9,
) -> list[float]:
    """Triple exponential smoothing with automatic baseline/trend/seasonality selection.

    Evaluates multiple ETS configurations on a hold-out set (last min(8, n//6) periods)
    and selects the configuration with lowest MAE:
      - ETS(A,N,N)  — level only
      - ETS(A,Ad,N) — level + damped trend
      - ETS(A,N,A)  — level + quarterly seasonal (m=13, requires ≥26 weeks)
      - ETS(A,Ad,A) — level + damped trend + quarterly seasonal (m=13)
      - ETS(A,N,A)  — level + annual seasonal (m=52, requires ≥104 weeks)
      - ETS(A,Ad,A) — level + damped trend + annual seasonal (m=52)

    Winner is refit on full history. All smoothing parameters optimised by MLE.
    Falls back to manual damped-trend Holt if statsmodels unavailable.
    """
    if len(history) < 4:
        return forecast_ets(history, periods, alpha)

    clipped = _remove_outliers(history)
    n = len(clipped)

    # Hold-out split for config selection
    hold = min(8, max(4, n // 6))
    if n > hold + 4:
        train_sel, test_sel = clipped[:-hold], clipped[-hold:]
    else:
        train_sel, test_sel = clipped, []

    # Candidate configurations: (trend, damped_trend, seasonal, seasonal_periods)
    configs: list[dict] = [
        {"trend": None,  "damped_trend": False, "seasonal": None, "seasonal_periods": None},
        {"trend": "add", "damped_trend": True,  "seasonal": None, "seasonal_periods": None},
    ]
    for m in [13, 52]:
        if n >= 2 * m + 2:
            configs.append({"trend": None,  "damped_trend": False, "seasonal": "add", "seasonal_periods": m})
            configs.append({"trend": "add", "damped_trend": True,  "seasonal": "add", "seasonal_periods": m})

    try:
        from statsmodels.tsa.holtwinters import ExponentialSmoothing as HWES

        best_mae = float("inf")
        best_cfg = configs[0]

        for cfg in configs:
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    fit = HWES(
                        train_sel,
                        trend=cfg["trend"],
                        damped_trend=cfg["damped_trend"],
                        seasonal=cfg["seasonal"],
                        seasonal_periods=cfg["seasonal_periods"],
                        initialization_method="estimated",
                    ).fit(optimized=True, remove_bias=True)

                if test_sel:
                    preds = [float(v) for v in fit.forecast(len(test_sel))]
                    mae = sum(abs(p - a) for p, a in zip(preds, test_sel)) / len(test_sel)
                else:
                    mae = fit.aic

                if mae < best_mae:
                    best_mae = mae
                    best_cfg = cfg
            except Exception:
                continue

        # Refit winner on full history
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            full_fit = HWES(
                clipped,
                trend=best_cfg["trend"],
                damped_trend=best_cfg["damped_trend"],
                seasonal=best_cfg["seasonal"],
                seasonal_periods=best_cfg["seasonal_periods"],
                initialization_method="estimated",
            ).fit(optimized=True, remove_bias=True)
        fc = full_fit.forecast(periods)
        return [round(max(0.0, float(v)), 2) for v in fc]
    except Exception:
        pass

    # Fallback: manual damped Holt linear trend
    if alpha is None or beta is None:
        alpha, beta = _best_alpha_beta(clipped)
    level = clipped[0]
    trend_val = clipped[1] - clipped[0] if len(clipped) >= 2 else 0.0
    for obs in clipped[1:]:
        prev = level
        level = alpha * obs + (1 - alpha) * (level + phi * trend_val)
        trend_val = beta * (level - prev) + (1 - beta) * phi * trend_val
    result = []
    phi_sum = 0.0
    for h in range(1, periods + 1):
        phi_sum += phi ** h
        result.append(round(max(0.0, level + phi_sum * trend_val), 2))
    return result


def _select_arima_order(history: list[float]) -> tuple:
    """
    Select optimal (p, d, q) per product using AIC.
    1. Determine d (0 or 1) via ADF stationarity test.
    2. Grid-search p in [0,1,2] × q in [0,1,2] for that d.
    Returns best (p, d, q) or (1, 1, 1) as safe fallback.
    """
    from statsmodels.tsa.arima.model import ARIMA
    from statsmodels.tsa.stattools import adfuller

    # Step 1: determine differencing order
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            pval = adfuller(history, autolag="AIC")[1]
        d = 0 if pval < 0.05 else 1   # stationary → d=0, else d=1
    except Exception:
        d = 1

    # Step 2: grid search p, q
    best_order, best_aic = (1, d, 1), float("inf")
    for p in range(3):       # 0, 1, 2
        for q in range(3):   # 0, 1, 2
            if p == 0 and q == 0:
                continue     # ARIMA(0,d,0) is a random walk — skip
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    aic = ARIMA(history, order=(p, d, q)).fit().aic
                if aic < best_aic:
                    best_aic = aic
                    best_order = (p, d, q)
            except Exception:
                continue

    return best_order


def forecast_arima(history: list[float], periods: int) -> list[float]:
    """
    ARIMA with per-product optimal order selected via AIC.
    Order (p, d, q) is determined by ADF stationarity test + grid search.
    Falls back to Holt-Winters on failure.
    """
    if len(history) < 6:
        return forecast_holt_winters(history, periods)
    try:
        from statsmodels.tsa.arima.model import ARIMA
        order = _select_arima_order(history)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            fit = ARIMA(history, order=order).fit()
            fc = fit.forecast(steps=periods)
        return [round(max(0.0, float(v)), 2) for v in fc]
    except Exception:
        return forecast_holt_winters(history, periods)


# ── Evaluation & selection ────────────────────────────────────────────────────

def evaluate_forecast(actuals: list[float], forecasts: list[float]) -> dict:
    n = min(len(actuals), len(forecasts))
    if n == 0:
        return {"mape": None, "mae": None, "bias": None}
    errors = [actuals[i] - forecasts[i] for i in range(n)]
    mae = sum(abs(e) for e in errors) / n
    bias = sum(errors) / n
    # WMAPE: Σ|error| / Σactual — volume-weighted so near-zero demand periods
    # don't inflate the metric the way per-period MAPE does.
    total_actual = sum(actuals[i] for i in range(n) if actuals[i] > 0)
    wmape = (sum(abs(errors[i]) for i in range(n) if actuals[i] > 0) / total_actual * 100) if total_actual > 0 else None
    return {
        "mape": round(wmape, 2) if wmape is not None else None,
        "mae": round(mae, 2),
        "bias": round(bias, 2),
    }


def confidence_bounds(forecast: float, std_dev: float, z: float = 1.28) -> "tuple[float, float]":
    """80% confidence interval (z=1.28)."""
    margin = z * std_dev
    return round(max(0.0, forecast - margin), 2), round(max(0.0, forecast + margin), 2)


MODEL_FUNCTIONS: dict = {
    "SMA": forecast_sma,
    "HOLT_WINTERS": forecast_holt_winters,
    "ARIMA": forecast_arima,
}


def select_best_model(history: list[float]) -> str:
    if len(history) < 8:
        return "SMA"
    train, test = history[:-4], history[-4:]
    best_model, best_score = "SMA", float("inf")
    for name, fn in MODEL_FUNCTIONS.items():
        preds = fn(train, periods=4)
        metrics = evaluate_forecast(test, preds)
        # Prefer MAPE; fall back to MAE when test period contains zero-demand weeks
        score = metrics["mape"] if metrics["mape"] is not None else metrics["mae"]
        if score is not None and score < best_score:
            best_score = score
            best_model = name
    return best_model
