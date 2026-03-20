from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from database import get_db
from models import Inventory, Product

router = APIRouter()


class InventoryUpdate(BaseModel):
    quantity_on_hand: Optional[float] = None
    quantity_on_order: Optional[float] = None
    quantity_reserved: Optional[float] = None


def inv_to_dict(inv: Inventory) -> dict:
    p = inv.product
    position = inv.quantity_on_hand + inv.quantity_on_order - inv.quantity_reserved
    days_of_supply = None
    if inv.avg_daily_demand and inv.avg_daily_demand > 0:
        days_of_supply = round(position / inv.avg_daily_demand, 1)

    return {
        "id": inv.id,
        "product_id": inv.product_id,
        "sku": p.sku if p else None,
        "description": p.description if p else None,
        "category": p.category if p else None,
        "abc_class": p.abc_class if p else None,
        "supplier": p.supplier.name if (p and p.supplier) else None,
        "quantity_on_hand": inv.quantity_on_hand,
        "quantity_on_order": inv.quantity_on_order,
        "quantity_reserved": inv.quantity_reserved,
        "position": position,
        "safety_stock_qty": p.safety_stock_qty if p else 0,
        "reorder_point": p.reorder_point if p else 0,
        "service_level": p.service_level if p else None,
        "days_of_supply": days_of_supply,
        "avg_daily_demand": inv.avg_daily_demand,
        "demand_std_dev": inv.demand_std_dev,
        "cost": p.cost if p else 0,
        "inventory_value": round(inv.quantity_on_hand * (p.cost if p else 0), 2),
        "status": _status(position, p.reorder_point if p else 0, p.safety_stock_qty if p else 0),
        "updated_at": inv.updated_at.isoformat() if inv.updated_at else None,
    }


def _status(position: float, rop: float, ss: float) -> str:
    if position <= 0:
        return "stockout"
    if position < (ss or 0):
        return "below_ss"
    if position < (rop or 0) * 1.5:
        return "healthy"
    return "overstocked"


@router.get("")
def list_inventory(db: Session = Depends(get_db)):
    rows = db.query(Inventory).join(Product).filter(Product.active == True).all()
    return [inv_to_dict(r) for r in rows]


@router.get("/alerts")
def inventory_alerts(db: Session = Depends(get_db)):
    rows = db.query(Inventory).join(Product).filter(Product.active == True).all()
    alerts = []
    for inv in rows:
        p = inv.product
        position = inv.quantity_on_hand + inv.quantity_on_order - inv.quantity_reserved
        ss = p.safety_stock_qty or 0
        if position <= 0:
            alerts.append({
                "sku": p.sku, "description": p.description, "abc_class": p.abc_class,
                "position": position, "reorder_point": p.reorder_point,
                "safety_stock_qty": p.safety_stock_qty, "severity": "red",
            })
        elif position < ss:
            alerts.append({
                "sku": p.sku, "description": p.description, "abc_class": p.abc_class,
                "position": position, "reorder_point": p.reorder_point,
                "safety_stock_qty": p.safety_stock_qty, "severity": "orange",
            })
    return sorted(alerts, key=lambda x: (x["severity"] == "red", -x["position"]), reverse=True)


@router.get("/{product_id}")
def get_inventory(product_id: int, db: Session = Depends(get_db)):
    inv = db.query(Inventory).filter(Inventory.product_id == product_id).first()
    if not inv:
        raise HTTPException(404)
    return inv_to_dict(inv)


@router.put("/{product_id}")
def update_inventory(product_id: int, body: InventoryUpdate, db: Session = Depends(get_db)):
    inv = db.query(Inventory).filter(Inventory.product_id == product_id).first()
    if not inv:
        raise HTTPException(404)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(inv, k, v)
    db.commit()
    return inv_to_dict(inv)
