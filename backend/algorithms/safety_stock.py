import math
from scipy.stats import norm


def z_score(service_level: float) -> float:
    return norm.ppf(min(max(service_level, 0.5), 0.9999))


def calculate_safety_stock(service_level: float, demand_std: float, lead_time_days: float, period_days: float = 7.0) -> float:
    """SS = Z(SL) × demand_std × sqrt(lead_time / period)"""
    if demand_std <= 0:
        return 0.0
    z = z_score(service_level)
    ss = z * demand_std * math.sqrt(lead_time_days / period_days)
    return math.ceil(ss)


def calculate_reorder_point(avg_demand_per_period: float, lead_time_days: float, safety_stock: float, period_days: float = 7.0) -> float:
    avg_daily = avg_demand_per_period / period_days
    return math.ceil(avg_daily * lead_time_days + safety_stock)


def suggest_service_level(abc_class: str) -> float:
    return {"A": 0.97, "B": 0.95, "C": 0.90}.get((abc_class or "B").upper(), 0.95)
