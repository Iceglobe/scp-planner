import json
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List
from database import get_db
from models import Workstation, Product, ProductionFlow

router = APIRouter()


# ── Workstation schemas ────────────────────────────────────────────────────────

class WorkstationCreate(BaseModel):
    name: str
    hours_per_day: float = 8.0
    days_per_week: int = 5
    cycle_rate_units_per_min: float = 0.0
    department: Optional[str] = None
    notes: Optional[str] = None


class WorkstationUpdate(BaseModel):
    name: Optional[str] = None
    hours_per_day: Optional[float] = None
    days_per_week: Optional[int] = None
    cycle_rate_units_per_min: Optional[float] = None
    department: Optional[str] = None
    notes: Optional[str] = None


def _compute_capacity(hours_per_day: float, rate: float, days_per_week: int):
    """Returns (capacity_units_per_week, cycle_time_minutes)."""
    capacity = round(hours_per_day * 60.0 * rate * days_per_week, 0) if rate > 0 else 0.0
    cycle_time = round(1.0 / rate, 4) if rate > 0 else 0.0
    return capacity, cycle_time


def ws_to_dict(ws: Workstation) -> dict:
    return {
        "id": ws.id,
        "name": ws.name,
        "hours_per_day": ws.hours_per_day,
        "days_per_week": ws.days_per_week,
        "cycle_rate_units_per_min": ws.cycle_rate_units_per_min,
        "capacity_units_per_week": ws.capacity_units_per_week,
        "cycle_time_minutes": ws.cycle_time_minutes,
        "department": ws.department,
        "notes": ws.notes,
        "product_count": len(ws.products),
        "created_at": ws.created_at.isoformat() if ws.created_at else None,
    }


@router.get("")
def list_workstations(db: Session = Depends(get_db)):
    rows = db.query(Workstation).order_by(Workstation.name).all()
    return [ws_to_dict(ws) for ws in rows]


@router.post("")
def create_workstation(body: WorkstationCreate, db: Session = Depends(get_db)):
    existing = db.query(Workstation).filter(Workstation.name == body.name).first()
    if existing:
        raise HTTPException(409, detail=f"Workstation '{body.name}' already exists")
    capacity_units, cycle_time = _compute_capacity(body.hours_per_day, body.cycle_rate_units_per_min, body.days_per_week)
    ws = Workstation(
        name=body.name,
        hours_per_day=body.hours_per_day,
        days_per_week=body.days_per_week,
        cycle_rate_units_per_min=body.cycle_rate_units_per_min,
        capacity_units_per_week=capacity_units,
        cycle_time_minutes=cycle_time,
        department=body.department,
        notes=body.notes,
    )
    db.add(ws)
    db.commit()
    db.refresh(ws)
    return ws_to_dict(ws)


@router.put("/{wid}")
def update_workstation(wid: int, body: WorkstationUpdate, db: Session = Depends(get_db)):
    ws = db.query(Workstation).filter(Workstation.id == wid).first()
    if not ws:
        raise HTTPException(404)
    data = body.model_dump(exclude_none=True)
    for k, v in data.items():
        setattr(ws, k, v)
    # Recompute capacity whenever hours, days, or rate changes
    if "hours_per_day" in data or "days_per_week" in data or "cycle_rate_units_per_min" in data:
        ws.capacity_units_per_week, ws.cycle_time_minutes = _compute_capacity(
            ws.hours_per_day, ws.cycle_rate_units_per_min, ws.days_per_week
        )
    db.commit()
    db.refresh(ws)
    return ws_to_dict(ws)


@router.delete("/{wid}")
def delete_workstation(wid: int, db: Session = Depends(get_db)):
    ws = db.query(Workstation).filter(Workstation.id == wid).first()
    if not ws:
        raise HTTPException(404)
    # Null-out assigned products first
    db.query(Product).filter(Product.workstation_id == wid).update({"workstation_id": None})
    # Remove from any production flows
    flows = db.query(ProductionFlow).all()
    for flow in flows:
        ids = json.loads(flow.workstation_ids or "[]")
        new_ids = [i for i in ids if i != wid]
        if new_ids != ids:
            flow.workstation_ids = json.dumps(new_ids)
    db.delete(ws)
    db.commit()
    return {"ok": True}


# ── Production flow schemas ────────────────────────────────────────────────────

class FlowCreate(BaseModel):
    name: str
    workstation_ids: List[int] = []


class FlowUpdate(BaseModel):
    name: Optional[str] = None
    workstation_ids: Optional[List[int]] = None


def flow_to_dict(flow: ProductionFlow) -> dict:
    return {
        "id": flow.id,
        "name": flow.name,
        "workstation_ids": json.loads(flow.workstation_ids or "[]"),
        "created_at": flow.created_at.isoformat() if flow.created_at else None,
    }


@router.get("/flows")
def list_flows(db: Session = Depends(get_db)):
    rows = db.query(ProductionFlow).order_by(ProductionFlow.created_at).all()
    return [flow_to_dict(f) for f in rows]


@router.post("/flows")
def create_flow(body: FlowCreate, db: Session = Depends(get_db)):
    flow = ProductionFlow(
        name=body.name,
        workstation_ids=json.dumps(body.workstation_ids),
    )
    db.add(flow)
    db.commit()
    db.refresh(flow)
    return flow_to_dict(flow)


@router.put("/flows/{fid}")
def update_flow(fid: int, body: FlowUpdate, db: Session = Depends(get_db)):
    flow = db.query(ProductionFlow).filter(ProductionFlow.id == fid).first()
    if not flow:
        raise HTTPException(404)
    if body.name is not None:
        flow.name = body.name
    if body.workstation_ids is not None:
        flow.workstation_ids = json.dumps(body.workstation_ids)
    db.commit()
    db.refresh(flow)
    return flow_to_dict(flow)


@router.delete("/flows/{fid}")
def delete_flow(fid: int, db: Session = Depends(get_db)):
    flow = db.query(ProductionFlow).filter(ProductionFlow.id == fid).first()
    if not flow:
        raise HTTPException(404)
    db.delete(flow)
    db.commit()
    return {"ok": True}
