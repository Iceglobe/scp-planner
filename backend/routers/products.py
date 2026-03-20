from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from database import get_db
from models import Product, Inventory, SalesHistory, ChangeLog
from algorithms.abc_analysis import classify_abc
from algorithms.safety_stock import calculate_safety_stock, calculate_reorder_point, suggest_service_level
import statistics

router = APIRouter()


class ProductCreate(BaseModel):
    sku: str
    description: str
    category: Optional[str] = None
    unit_of_measure: str = "EA"
    cost: float = 0.0
    selling_price: float = 0.0
    supplier_id: Optional[int] = None
    lead_time_days: float = 7.0
    moq: float = 1.0
    safety_stock_days: float = 7.0
    service_level: float = 0.95
    item_type: str = "purchased"
    max_weekly_capacity: Optional[float] = None


class ProductUpdate(BaseModel):
    description: Optional[str] = None
    category: Optional[str] = None
    cost: Optional[float] = None
    selling_price: Optional[float] = None
    supplier_id: Optional[int] = None
    lead_time_days: Optional[float] = None
    moq: Optional[float] = None
    safety_stock_days: Optional[float] = None
    safety_stock_qty: Optional[float] = None
    reorder_point: Optional[float] = None
    service_level: Optional[float] = None
    active: Optional[bool] = None
    item_type: Optional[str] = None
    max_weekly_capacity: Optional[float] = None


def product_to_dict(p: Product, with_inventory: bool = True) -> dict:
    d = {
        "id": p.id, "sku": p.sku, "description": p.description,
        "category": p.category, "unit_of_measure": p.unit_of_measure,
        "cost": p.cost, "selling_price": p.selling_price,
        "supplier_id": p.supplier_id,
        "supplier_name": p.supplier.name if p.supplier else None,
        "lead_time_days": p.lead_time_days, "moq": p.moq,
        "reorder_point": p.reorder_point, "safety_stock_days": p.safety_stock_days,
        "safety_stock_qty": p.safety_stock_qty, "service_level": p.service_level,
        "abc_class": p.abc_class, "item_type": p.item_type or "purchased",
        "max_weekly_capacity": p.max_weekly_capacity,
        "smoothing_alpha": p.smoothing_alpha, "active": p.active,
    }
    if with_inventory and p.inventory:
        inv = p.inventory
        d["on_hand"] = inv.quantity_on_hand
        d["on_order"] = inv.quantity_on_order
        d["reserved"] = inv.quantity_reserved
        d["position"] = inv.quantity_on_hand + inv.quantity_on_order - inv.quantity_reserved
    else:
        d["on_hand"] = 0
        d["on_order"] = 0
        d["reserved"] = 0
        d["position"] = 0
    return d


@router.get("")
def list_products(
    abc_class: Optional[str] = None,
    supplier_id: Optional[int] = None,
    search: Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = db.query(Product).filter(Product.active == True)
    if abc_class:
        q = q.filter(Product.abc_class == abc_class.upper())
    if supplier_id:
        q = q.filter(Product.supplier_id == supplier_id)
    if search:
        q = q.filter(
            Product.sku.ilike(f"%{search}%") | Product.description.ilike(f"%{search}%")
        )
    return [product_to_dict(p) for p in q.order_by(Product.sku).all()]


@router.post("")
def create_product(body: ProductCreate, db: Session = Depends(get_db)):
    p = Product(**body.model_dump())
    db.add(p)
    db.flush()
    inv = Inventory(product_id=p.id, quantity_on_hand=0)
    db.add(inv)
    db.commit()
    db.refresh(p)
    return product_to_dict(p)


@router.get("/changelog")
def get_changelog(limit: int = 100, db: Session = Depends(get_db)):
    rows = db.query(ChangeLog).order_by(ChangeLog.changed_at.desc()).limit(limit).all()
    return [
        {
            "id": r.id, "entity_type": r.entity_type, "entity_id": r.entity_id,
            "entity_name": r.entity_name, "field": r.field,
            "old_value": r.old_value, "new_value": r.new_value,
            "changed_by": r.changed_by,
            "changed_at": r.changed_at.isoformat() if r.changed_at else None,
        }
        for r in rows
    ]


@router.get("/{pid}")
def get_product(pid: int, db: Session = Depends(get_db)):
    p = db.query(Product).filter(Product.id == pid).first()
    if not p:
        raise HTTPException(404)
    return product_to_dict(p)


class AbcServiceLevels(BaseModel):
    A: float = 0.97
    B: float = 0.95
    C: float = 0.90


@router.put("/set-abc-service-levels")
def set_abc_service_levels(body: AbcServiceLevels, db: Session = Depends(get_db)):
    mapping = {"A": body.A, "B": body.B, "C": body.C}
    products = db.query(Product).filter(Product.active == True).all()
    updated = 0
    for p in products:
        if p.abc_class in mapping:
            p.service_level = mapping[p.abc_class]
            updated += 1
    db.commit()
    return {"updated": updated}


@router.put("/{pid}")
def update_product(pid: int, body: ProductUpdate, db: Session = Depends(get_db)):
    p = db.query(Product).filter(Product.id == pid).first()
    if not p:
        raise HTTPException(404)
    changes = body.model_dump(exclude_none=True)
    for k, v in changes.items():
        old = getattr(p, k, None)
        setattr(p, k, v)
        db.add(ChangeLog(
            entity_type="product", entity_id=p.id, entity_name=p.sku,
            field=k, old_value=str(old), new_value=str(v),
        ))
    db.commit()
    db.refresh(p)
    return product_to_dict(p)


@router.delete("/{pid}")
def delete_product(pid: int, db: Session = Depends(get_db)):
    p = db.query(Product).filter(Product.id == pid).first()
    if not p:
        raise HTTPException(404)
    db.add(ChangeLog(
        entity_type="product", entity_id=p.id, entity_name=p.sku,
        field="active", old_value="True", new_value="False",
    ))
    p.active = False
    db.commit()
    return {"ok": True}


@router.post("/recalculate-abc")
def recalculate_abc(db: Session = Depends(get_db)):
    from datetime import date, timedelta
    cutoff = date.today() - timedelta(weeks=52)
    products = db.query(Product).filter(Product.active == True).all()
    enriched = []
    for p in products:
        revenue = sum(
            s.revenue for s in p.sales_history
            if s.period_date >= cutoff and s.revenue
        )
        enriched.append({"product": p, "revenue": revenue, "id": p.id})

    classified = classify_abc(enriched)
    for item in classified:
        item["product"].abc_class = item["abc_class"]

    db.commit()
    return {"updated": len(classified)}


@router.post("/recalculate-safety-stock")
def recalculate_safety_stock(db: Session = Depends(get_db)):
    from datetime import date, timedelta
    cutoff = date.today() - timedelta(weeks=26)
    products = db.query(Product).filter(Product.active == True).all()
    updated = 0
    for p in products:
        history = sorted(
            [s.quantity for s in p.sales_history if s.period_date >= cutoff],
        )
        if len(history) < 2:
            continue
        avg = sum(history) / len(history)
        std = statistics.stdev(history) if len(history) > 1 else 0
        sl = p.service_level or suggest_service_level(p.abc_class or "B")
        ss = calculate_safety_stock(sl, std, p.lead_time_days)
        rop = calculate_reorder_point(avg, p.lead_time_days, ss)
        p.safety_stock_qty = ss
        p.reorder_point = rop
        if p.inventory:
            p.inventory.avg_daily_demand = avg / 7
            p.inventory.demand_std_dev = std
        updated += 1

    db.commit()
    return {"updated": updated}


@router.post("/recalculate-rop")
def recalculate_rop(db: Session = Depends(get_db)):
    products = db.query(Product).filter(Product.active == True).all()
    updated = 0
    for p in products:
        inv = p.inventory
        avg_daily = inv.avg_daily_demand if inv and inv.avg_daily_demand else 0
        ss = p.safety_stock_qty or 0
        lt = p.lead_time_days or 0
        p.reorder_point = round(avg_daily * lt + ss, 1)
        updated += 1
    db.commit()
    return {"updated": updated}
