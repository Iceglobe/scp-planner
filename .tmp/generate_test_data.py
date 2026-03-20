"""
Generate realistic test CSV files for the supply chain planner.
Outputs to the same directory as this script.
"""
import csv, random, math, os
from datetime import date, timedelta

random.seed(42)
OUT = os.path.dirname(os.path.abspath(__file__))

# ── Reference data ─────────────────────────────────────────────────────────────
CATEGORIES = [
    'Electronics', 'Hydraulics', 'Pneumatics', 'Bearings', 'Drive Systems',
    'Sensors', 'Fittings', 'Filtration', 'Electrical', 'Structural',
    'Lubrication', 'Seals', 'Fasteners',
]

ADJECTIVES = [
    'Industrial', 'Precision', 'Heavy-Duty', 'Compact', 'High-Performance',
    'Standard', 'Advanced', 'Modular', 'Sealed', 'Stainless',
]

NOUNS = {
    'Electronics':   ['Control Board', 'Power Supply', 'Driver Module', 'Relay Unit', 'Signal Converter'],
    'Hydraulics':    ['Pump Assembly', 'Valve Block', 'Cylinder', 'Accumulator', 'Filter Housing'],
    'Pneumatics':    ['Valve Manifold', 'Cylinder Unit', 'Air Regulator', 'Solenoid Valve', 'Actuator'],
    'Bearings':      ['Bearing Set', 'Linear Guide', 'Thrust Bearing', 'Roller Bearing', 'Ball Bearing'],
    'Drive Systems': ['Coupling', 'Servo Motor', 'Gearbox', 'Belt Drive', 'Shaft Collar'],
    'Sensors':       ['Temp Sensor', 'Pressure Transducer', 'Flow Meter', 'Position Sensor', 'Proximity Switch'],
    'Fittings':      ['Compression Fitting', 'Push-In Connector', 'Elbow Joint', 'Reducer Bushing', 'Tube Fitting'],
    'Filtration':    ['Filter Cartridge', 'Strainer Element', 'Coalescer Filter', 'Oil Filter', 'Air Filter'],
    'Electrical':    ['Cable Gland', 'Terminal Block', 'Din Rail', 'Conduit Fitting', 'Cable Tray'],
    'Structural':    ['Mounting Bracket', 'Support Frame', 'Anchor Plate', 'Strut Channel', 'Weld Nut'],
    'Lubrication':   ['Lube Pump', 'Grease Fitting', 'Oil Reservoir', 'Dispensing Valve', 'Level Gauge'],
    'Seals':         ['O-Ring Kit', 'Shaft Seal', 'Gasket Set', 'V-Ring Seal', 'Lip Seal'],
    'Fasteners':     ['Hex Bolt Set', 'Socket Screw Kit', 'Washer Pack', 'Nut Assortment', 'Stud Bolt'],
}

SIZE_SUFFIXES = ['M8', 'M12', 'M20', '25mm', '40mm', '50mm', '3/4"', '1/2"', '24V', '48V', '10A', '5A', '150W', '500W']

CUSTOMERS = ['Alfa Industries', 'Beta Manufacturing', 'Gamma Tools', 'Delta Corp']
CUST_SHARES = [0.40, 0.30, 0.20, 0.10]

SUPPLIERS = ['Apex Industrial', 'Nordic Precision', 'FastTrack Logistics', 'Pacific Manufacturing', 'Euro Components']

TODAY = date.today()


# ── 1. Product master ──────────────────────────────────────────────────────────
def gen_products(n=100):
    products = []
    cat_cycle = (CATEGORIES * 8)[:n]
    for i in range(1, n + 1):
        sku = f'SKU-{i:03d}'
        cat = cat_cycle[i - 1]
        adj = random.choice(ADJECTIVES)
        noun = random.choice(NOUNS[cat])
        suffix = random.choice(SIZE_SUFFIXES)
        desc = f'{adj} {noun} {suffix}'
        cost = round(random.uniform(4, 650), 2)
        sell = round(cost * random.uniform(1.35, 2.20), 2)
        lt = random.choice([7, 7, 14, 14, 21, 28])
        moq = random.choice([1, 5, 10, 20, 25, 50, 100, 200])
        base_demand = random.randint(8, 600)
        noise = round(random.uniform(0.08, 0.35), 2)
        trend = round(random.uniform(-0.5, 1.8), 2)
        products.append({
            'sku': sku, 'description': desc, 'category': cat,
            'cost': cost, 'selling_price': sell,
            'lead_time_days': lt, 'moq': moq,
            '_base': base_demand, '_noise': noise, '_trend': trend,
        })
    return products


def write_products(products):
    path = os.path.join(OUT, '01_product_master.csv')
    with open(path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['sku', 'description', 'category', 'cost', 'selling_price', 'lead_time_days', 'moq'])
        for p in products:
            w.writerow([p['sku'], p['description'], p['category'],
                        p['cost'], p['selling_price'], p['lead_time_days'], p['moq']])
    print(f'  ✓ {path}  ({len(products)} rows)')


# ── 2. Sales history by customer × SKU (past 52 weeks) ────────────────────────
def weekly_mondays(n_weeks):
    """Return n_weeks Monday dates going back from today."""
    mondays = []
    d = TODAY - timedelta(days=TODAY.weekday())   # this Monday
    for w in range(n_weeks, 0, -1):
        mondays.append(d - timedelta(weeks=w))
    return mondays


def gen_weekly_demand(base, trend, noise, weeks):
    demands = []
    for w in range(weeks):
        t = base + trend * w
        n = random.gauss(0, noise * base)
        demands.append(max(0, round(t + n)))
    return demands


def write_sales_history(products, weeks=52):
    path = os.path.join(OUT, '02_sales_history_by_customer.csv')
    mondays = weekly_mondays(weeks)
    rows_written = 0
    with open(path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['sku', 'customer', 'period_date', 'quantity', 'revenue'])
        for p in products:
            demands = gen_weekly_demand(p['_base'], p['_trend'], p['_noise'], weeks)
            for week_idx, period_date in enumerate(mondays):
                total_qty = demands[week_idx]
                remaining = total_qty
                for ci, cust in enumerate(CUSTOMERS):
                    if ci == len(CUSTOMERS) - 1:
                        qty = remaining
                    else:
                        noise = random.gauss(0, 0.03 * total_qty)
                        qty = max(0, round(total_qty * CUST_SHARES[ci] + noise))
                        remaining -= qty
                    if qty > 0:
                        rev = round(qty * p['selling_price'], 2)
                        w.writerow([p['sku'], cust, period_date.isoformat(), qty, rev])
                        rows_written += 1
    print(f'  ✓ {path}  ({rows_written} rows, {weeks} weeks × {len(products)} SKUs × {len(CUSTOMERS)} customers)')


# ── 3. Inventory snapshot ──────────────────────────────────────────────────────
def write_inventory(products, weeks=52):
    path = os.path.join(OUT, '03_inventory.csv')
    with open(path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['sku', 'quantity_on_hand'])
        for p in products:
            avg_weekly = p['_base'] + p['_trend'] * (weeks - 1)
            multiplier = random.uniform(0.8, 3.5)
            on_hand = max(0, round(avg_weekly * multiplier))
            w.writerow([p['sku'], on_hand])
    print(f'  ✓ {path}  ({len(products)} rows)')


# ── 4. Purchase orders (10 random SKUs, PO placed within last 30 days) ─────────
def write_purchase_orders(products):
    path = os.path.join(OUT, '04_purchase_orders.csv')
    selected = random.sample(products, 10)
    po_rows = []
    for i, p in enumerate(selected, 1):
        order_date = TODAY - timedelta(days=random.randint(0, 30))
        lt_days = int(p['lead_time_days'])
        due_date = order_date + timedelta(days=lt_days)
        qty = p['moq'] * random.randint(2, 6)
        po_rows.append({
            'po_number': f'PO-TEST-{i:04d}',
            'sku': p['sku'],
            'quantity': qty,
            'unit_cost': p['cost'],
            'order_date': order_date.isoformat(),
            'due_date': due_date.isoformat(),
        })
    with open(path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['po_number', 'sku', 'quantity', 'unit_cost', 'order_date', 'due_date'])
        for r in po_rows:
            w.writerow([r['po_number'], r['sku'], r['quantity'],
                        r['unit_cost'], r['order_date'], r['due_date']])
    print(f'  ✓ {path}  ({len(po_rows)} rows)')


# ── 5. Customer orders (open orders for all 100 SKUs) ─────────────────────────
def write_customer_orders(products, weeks=52):
    """Open customer orders: 2-5 open order lines per SKU across customers,
    due dates 1-6 weeks out, quantities roughly in line with weekly sales rate."""
    path = os.path.join(OUT, '05_customer_orders.csv')
    rows_written = 0
    with open(path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['sku', 'customer', 'due_date', 'quantity', 'revenue'])
        for p in products:
            avg_weekly = max(1, round(p['_base'] + p['_trend'] * (weeks - 1)))
            # 2-4 open order lines per SKU, distributed across customers
            n_orders = random.randint(2, 4)
            for _ in range(n_orders):
                cust = random.choices(CUSTOMERS, weights=CUST_SHARES)[0]
                cust_share = CUST_SHARES[CUSTOMERS.index(cust)]
                weeks_out = random.randint(1, 6)
                due_date = TODAY + timedelta(weeks=weeks_out)
                due_date -= timedelta(days=due_date.weekday())   # snap to Monday
                # Quantity: roughly 1-3 weeks of that customer's share
                wks = random.uniform(0.5, 3.0)
                qty = max(1, round(avg_weekly * cust_share * wks * random.uniform(0.7, 1.3)))
                rev = round(qty * p['selling_price'], 2)
                w.writerow([p['sku'], cust, due_date.isoformat(), qty, rev])
                rows_written += 1
    print(f'  ✓ {path}  ({rows_written} rows)')


# ── Main ──────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    print('Generating test data…')
    products = gen_products(100)
    write_products(products)
    write_sales_history(products, weeks=52)
    write_inventory(products, weeks=52)
    write_purchase_orders(products)
    write_customer_orders(products, weeks=52)
    print('Done.')
