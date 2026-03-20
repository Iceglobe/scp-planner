def classify_abc(products_with_revenue: list[dict]) -> list[dict]:
    """
    Classify products into ABC categories by revenue contribution.
    A = top 80%, B = next 15%, C = bottom 5%
    Returns list sorted by revenue desc with abc_class field added.
    """
    sorted_p = sorted(products_with_revenue, key=lambda x: x.get("revenue", 0), reverse=True)
    total = sum(p.get("revenue", 0) for p in sorted_p)
    if total == 0:
        for p in sorted_p:
            p["abc_class"] = "C"
        return sorted_p

    cumulative = 0.0
    for p in sorted_p:
        cumulative += p.get("revenue", 0)
        pct = cumulative / total
        p["abc_class"] = "A" if pct <= 0.80 else ("B" if pct <= 0.95 else "C")
        p["revenue_pct"] = round(p.get("revenue", 0) / total * 100, 2)
        p["cumulative_pct"] = round(cumulative / total * 100, 2)

    return sorted_p
