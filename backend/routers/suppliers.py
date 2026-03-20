from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from database import get_db
from models import Supplier, ChangeLog

router = APIRouter()


class SupplierCreate(BaseModel):
    code: str
    name: str
    contact_email: Optional[str] = None
    lead_time_days: float = 7.0
    min_order_qty: float = 0.0
    currency: str = "USD"
    active: bool = True


class SupplierUpdate(BaseModel):
    name: Optional[str] = None
    contact_email: Optional[str] = None
    lead_time_days: Optional[float] = None
    min_order_qty: Optional[float] = None
    active: Optional[bool] = None


def to_dict(s: Supplier) -> dict:
    return {
        "id": s.id, "code": s.code, "name": s.name,
        "contact_email": s.contact_email, "lead_time_days": s.lead_time_days,
        "min_order_qty": s.min_order_qty, "currency": s.currency, "active": s.active,
    }


@router.get("")
def list_suppliers(db: Session = Depends(get_db)):
    return [to_dict(s) for s in db.query(Supplier).filter(Supplier.active == True).all()]


@router.post("")
def create_supplier(body: SupplierCreate, db: Session = Depends(get_db)):
    s = Supplier(**body.model_dump())
    db.add(s)
    db.commit()
    db.refresh(s)
    return to_dict(s)


@router.put("/{sid}")
def update_supplier(sid: int, body: SupplierUpdate, db: Session = Depends(get_db)):
    s = db.query(Supplier).filter(Supplier.id == sid).first()
    if not s:
        raise HTTPException(404, "Supplier not found")
    for k, v in body.model_dump(exclude_none=True).items():
        old = getattr(s, k, None)
        setattr(s, k, v)
        db.add(ChangeLog(
            entity_type="supplier", entity_id=s.id, entity_name=s.code,
            field=k, old_value=str(old), new_value=str(v),
        ))
    db.commit()
    return to_dict(s)


@router.delete("/{sid}")
def delete_supplier(sid: int, db: Session = Depends(get_db)):
    s = db.query(Supplier).filter(Supplier.id == sid).first()
    if not s:
        raise HTTPException(404)
    s.active = False
    db.commit()
    return {"ok": True}
