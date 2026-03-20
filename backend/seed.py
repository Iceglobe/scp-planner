"""
Seed the database with realistic supply chain demo data.
Run: python seed.py
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

from database import SessionLocal, engine, Base
import models
from datetime import date, timedelta
import random, math, statistics

Base.metadata.create_all(bind=engine)

random.seed(42)

SUPPLIERS = [
    {"code": "SUP-001", "name": "Apex Industrial Components", "contact_email": "orders@apex.com", "lead_time_days": 14, "currency": "USD"},
    {"code": "SUP-002", "name": "Nordic Precision Parts", "contact_email": "supply@nordic.com", "lead_time_days": 21, "currency": "EUR"},
    {"code": "SUP-003", "name": "FastTrack Logistics Co.", "contact_email": "po@fasttrack.com", "lead_time_days": 7, "currency": "USD"},
    {"code": "SUP-004", "name": "Pacific Manufacturing Ltd", "contact_email": "sales@pacmfg.com", "lead_time_days": 28, "currency": "USD"},
]

PRODUCTS = [
    # High-value A items
    {"sku": "SKU-001", "description": "Hydraulic Pump Assembly HPA-200", "category": "Hydraulics", "cost": 485.0, "selling_price": 720.0, "supplier_idx": 0, "lead_time_days": 14, "moq": 5, "service_level": 0.97, "base_demand": 45, "trend": 0.8, "noise": 0.15},
    {"sku": "SKU-002", "description": "Control Board PCB-440 Industrial", "category": "Electronics", "cost": 320.0, "selling_price": 480.0, "supplier_idx": 1, "lead_time_days": 21, "moq": 10, "service_level": 0.97, "base_demand": 60, "trend": 1.2, "noise": 0.18},
    {"sku": "SKU-003", "description": "Servo Motor SM-750W", "category": "Drive Systems", "cost": 290.0, "selling_price": 435.0, "supplier_idx": 0, "lead_time_days": 14, "moq": 5, "service_level": 0.97, "base_demand": 55, "trend": 0.5, "noise": 0.12},
    {"sku": "SKU-004", "description": "Precision Bearing Set PB-32mm", "category": "Bearings", "cost": 78.0, "selling_price": 120.0, "supplier_idx": 2, "lead_time_days": 7, "moq": 50, "service_level": 0.97, "base_demand": 180, "trend": 0.3, "noise": 0.20},
    # B items
    {"sku": "SKU-005", "description": "Pneumatic Valve Block PVB-3/4", "category": "Pneumatics", "cost": 145.0, "selling_price": 220.0, "supplier_idx": 3, "lead_time_days": 28, "moq": 10, "service_level": 0.95, "base_demand": 35, "trend": 0.0, "noise": 0.22},
    {"sku": "SKU-006", "description": "Stainless Steel Fitting SSF-1/2", "category": "Fittings", "cost": 12.5, "selling_price": 22.0, "supplier_idx": 2, "lead_time_days": 7, "moq": 100, "service_level": 0.95, "base_demand": 520, "trend": -0.5, "noise": 0.25},
    {"sku": "SKU-007", "description": "Industrial Coupling IC-40mm", "category": "Drive Systems", "cost": 95.0, "selling_price": 145.0, "supplier_idx": 0, "lead_time_days": 14, "moq": 20, "service_level": 0.95, "base_demand": 40, "trend": 0.2, "noise": 0.18},
    {"sku": "SKU-008", "description": "Sensor Module SEN-Temp-Ind", "category": "Sensors", "cost": 62.0, "selling_price": 98.0, "supplier_idx": 1, "lead_time_days": 21, "moq": 25, "service_level": 0.95, "base_demand": 75, "trend": 1.5, "noise": 0.20},
    {"sku": "SKU-009", "description": "Lubrication Pump LP-Mini", "category": "Lubrication", "cost": 185.0, "selling_price": 278.0, "supplier_idx": 3, "lead_time_days": 21, "moq": 5, "service_level": 0.95, "base_demand": 25, "trend": 0.1, "noise": 0.15},
    {"sku": "SKU-010", "description": "Power Supply Unit PSU-24V-10A", "category": "Electronics", "cost": 88.0, "selling_price": 135.0, "supplier_idx": 1, "lead_time_days": 14, "moq": 20, "service_level": 0.95, "base_demand": 65, "trend": 0.8, "noise": 0.22},
    # C items
    {"sku": "SKU-011", "description": "Hex Bolt M12 x 50mm (box)", "category": "Fasteners", "cost": 8.5, "selling_price": 16.0, "supplier_idx": 2, "lead_time_days": 7, "moq": 200, "service_level": 0.90, "base_demand": 800, "trend": 0.0, "noise": 0.30},
    {"sku": "SKU-012", "description": "O-Ring Seal Kit RSK-25mm", "category": "Seals", "cost": 15.0, "selling_price": 28.0, "supplier_idx": 2, "lead_time_days": 7, "moq": 50, "service_level": 0.90, "base_demand": 220, "trend": 0.0, "noise": 0.28},
    {"sku": "SKU-013", "description": "Cable Gland CG-M20 Nylon", "category": "Electrical", "cost": 3.2, "selling_price": 6.5, "supplier_idx": 3, "lead_time_days": 14, "moq": 100, "service_level": 0.90, "base_demand": 400, "trend": -0.3, "noise": 0.35},
    {"sku": "SKU-014", "description": "Filter Cartridge FC-10mic", "category": "Filtration", "cost": 28.0, "selling_price": 48.0, "supplier_idx": 0, "lead_time_days": 14, "moq": 20, "service_level": 0.90, "base_demand": 85, "trend": 0.2, "noise": 0.22},
    {"sku": "SKU-015", "description": "Mounting Bracket MB-L40 Steel", "category": "Structural", "cost": 18.0, "selling_price": 32.0, "supplier_idx": 3, "lead_time_days": 14, "moq": 50, "service_level": 0.90, "base_demand": 120, "trend": 0.0, "noise": 0.25},
]


def generate_weekly_demand(base: float, trend: float, noise: float, weeks: int) -> list[float]:
    demands = []
    for w in range(weeks):
        t = base + trend * w
        n = random.gauss(0, noise * base)
        d = max(0, round(t + n))
        demands.append(d)
    return demands


def main():
    db = SessionLocal()
    try:
        # Clear existing data
        for Model in [models.PurchaseOrder, models.MrpRun, models.Forecast, models.ForecastRun,
                      models.CustomerDemand, models.SalesHistory, models.Inventory,
                      models.Product, models.Supplier, models.DataConnector]:
            db.query(Model).delete()
        db.commit()

        # Create suppliers
        supplier_objects = []
        for s in SUPPLIERS:
            obj = models.Supplier(**s)
            db.add(obj)
            supplier_objects.append(obj)
        db.flush()

        # Create products + inventory + sales history
        today = date.today()
        weeks_history = 52
        product_objects = []

        for prod_def in PRODUCTS:
            supplier = supplier_objects[prod_def.pop("supplier_idx")]
            base_demand = prod_def.pop("base_demand")
            trend = prod_def.pop("trend")
            noise = prod_def.pop("noise")

            p = models.Product(**prod_def, supplier_id=supplier.id)
            db.add(p)
            db.flush()
            product_objects.append(p)

            # Generate demand history
            demands = generate_weekly_demand(base_demand, trend, noise, weeks_history)
            for w, qty in enumerate(demands):
                period_dt = today - timedelta(weeks=weeks_history - w)
                period_dt = period_dt - timedelta(days=period_dt.weekday())  # Monday
                revenue = round(qty * p.selling_price, 2)
                db.add(models.SalesHistory(
                    product_id=p.id,
                    period_date=period_dt,
                    quantity=qty,
                    revenue=revenue,
                    source="demo",
                ))

            # Calculate safety stock from demand stats
            from algorithms.safety_stock import calculate_safety_stock, calculate_reorder_point
            std_dev = statistics.stdev(demands[-26:]) if len(demands) >= 2 else 0
            avg_demand = sum(demands[-26:]) / 26
            ss = calculate_safety_stock(p.service_level, std_dev, p.lead_time_days)
            rop = calculate_reorder_point(avg_demand, p.lead_time_days, ss)
            p.safety_stock_qty = ss
            p.reorder_point = rop

            # Create inventory position (realistic on-hand)
            multiplier = random.uniform(1.0, 3.5)
            on_hand = round(avg_demand * multiplier)
            on_order = round(avg_demand * 1.5) if random.random() < 0.4 else 0
            db.add(models.Inventory(
                product_id=p.id,
                quantity_on_hand=on_hand,
                quantity_on_order=on_order,
                quantity_reserved=round(avg_demand * 0.3),
                avg_daily_demand=round(avg_demand / 7, 2),
                demand_std_dev=round(std_dev, 2),
            ))

        # ABC classification
        from algorithms.abc_analysis import classify_abc
        enriched = []
        for p in product_objects:
            revenue = sum(s.revenue for s in db.query(models.SalesHistory).filter(models.SalesHistory.product_id == p.id).all())
            enriched.append({"product": p, "revenue": revenue, "id": p.id})

        classified = classify_abc(enriched)
        for item in classified:
            item["product"].abc_class = item["abc_class"]

        db.flush()

        # Create some open purchase orders
        import uuid
        po_counter = 1
        for p in product_objects[:8]:
            if random.random() < 0.6:
                due_weeks = random.randint(1, p.lead_time_days // 7 + 2)
                po_num = f"PO-{today.year}-{po_counter:04d}"
                po_counter += 1
                db.add(models.PurchaseOrder(
                    po_number=po_num,
                    product_id=p.id,
                    supplier_id=p.supplier_id,
                    status=random.choice(["confirmed", "in_transit"]),
                    quantity=p.moq * random.randint(2, 5),
                    unit_cost=p.cost,
                    order_date=today - timedelta(days=random.randint(3, 10)),
                    due_date=today + timedelta(weeks=due_weeks),
                ))

        # Add default data connectors
        for dc in [
            {"name": "ERP Sales Feed", "connector_type": "erp_rest", "target_entity": "sales_history", "status": "not_configured"},
            {"name": "Excel Inventory Upload", "connector_type": "excel_upload", "target_entity": "inventory", "status": "not_configured"},
            {"name": "SQL Warehouse DB", "connector_type": "sql", "target_entity": "sales_history", "status": "not_configured"},
        ]:
            db.add(models.DataConnector(**dc))

        # Seed customer demand: split SalesHistory demand across 4 customers
        CUSTOMERS = [
            {"name": "Alfa Industries",     "share": 0.40},
            {"name": "Beta Manufacturing",  "share": 0.30},
            {"name": "Gamma Tools",         "share": 0.20},
            {"name": "Delta Corp",          "share": 0.10},
        ]
        sales_rows = db.query(models.SalesHistory).all()
        for sale in sales_rows:
            product = db.query(models.Product).filter(models.Product.id == sale.product_id).first()
            remaining = sale.quantity
            for i, cust in enumerate(CUSTOMERS):
                if i == len(CUSTOMERS) - 1:
                    qty = remaining  # give remainder to last customer
                else:
                    noise = random.gauss(0, 0.03 * sale.quantity)
                    qty = max(0, round(sale.quantity * cust["share"] + noise))
                    remaining -= qty
                rev = round(qty * (product.selling_price if product else 0), 2)
                db.add(models.CustomerDemand(
                    product_id=sale.product_id,
                    customer=cust["name"],
                    period_date=sale.period_date,
                    quantity=qty,
                    revenue=rev,
                    source="actual",
                ))

        # Add customer forecasts for next 12 weeks
        for p in product_objects:
            hist = db.query(models.SalesHistory).filter(
                models.SalesHistory.product_id == p.id
            ).order_by(models.SalesHistory.period_date.desc()).limit(8).all()
            avg_weekly = (sum(h.quantity for h in hist) / len(hist)) if hist else 0
            for w in range(1, 13):
                period_dt = today + timedelta(weeks=w)
                period_dt = period_dt - timedelta(days=period_dt.weekday())
                for cust in CUSTOMERS:
                    noise = random.gauss(0, 0.05 * avg_weekly * cust["share"])
                    qty = max(0, round(avg_weekly * cust["share"] + noise))
                    rev = round(qty * p.selling_price, 2)
                    db.add(models.CustomerDemand(
                        product_id=p.id,
                        customer=cust["name"],
                        period_date=period_dt,
                        quantity=qty,
                        revenue=rev,
                        source="forecast",
                    ))

        db.commit()
        print(f"✅ Seeded {len(SUPPLIERS)} suppliers, {len(PRODUCTS)} products, {weeks_history} weeks of history each.")
        print("✅ Calculated safety stock, reorder points, and ABC classes.")
        print("✅ Created open purchase orders and default data connectors.")
        print(f"✅ Seeded customer demand for {len(CUSTOMERS)} customers (actuals + 12-week forecasts).")

    finally:
        db.close()


if __name__ == "__main__":
    main()
