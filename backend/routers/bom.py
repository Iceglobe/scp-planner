from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import text
from pydantic import BaseModel
from typing import Optional
from database import get_db
from models import BomItem, Product

router = APIRouter()


class BomItemCreate(BaseModel):
    parent_product_id: int
    child_product_id: int
    quantity_per: float = 1.0


class BomItemUpdate(BaseModel):
    quantity_per: float


# ---------- helpers ----------

def _build_children_map(db: Session) -> dict[int, list[BomItem]]:
    """Return dict: parent_id → list of BomItem rows."""
    rows = db.query(BomItem).all()
    result: dict[int, list] = {}
    for row in rows:
        result.setdefault(row.parent_product_id, []).append(row)
    return result


def _has_cycle(db: Session, start_id: int, target_id: int) -> bool:
    """DFS from start_id following child→parent links; returns True if target_id is reachable."""
    children_map = _build_children_map(db)

    def dfs(current: int, visited: set) -> bool:
        if current == target_id:
            return True
        if current in visited:
            return False
        visited.add(current)
        for bom in children_map.get(current, []):
            if dfs(bom.child_product_id, visited):
                return True
        return False

    return dfs(start_id, set())


def _build_tree_node(
    product: Product,
    children_map: dict[int, list],
    product_map: dict[int, Product],
    level: int,
    bom_id: Optional[int],
    quantity_per: Optional[float],
    visited: set,
) -> dict:
    node = {
        "product_id": product.id,
        "sku": product.sku,
        "description": product.description,
        "unit_of_measure": product.unit_of_measure or "EA",
        "level": level,
        "bom_id": bom_id,
        "quantity_per": quantity_per,
        "children": [],
    }
    if product.id in visited:
        return node  # shared component — don't recurse infinitely
    visited = visited | {product.id}
    for bom in children_map.get(product.id, []):
        child = product_map.get(bom.child_product_id)
        if child:
            node["children"].append(
                _build_tree_node(child, children_map, product_map, level + 1, bom.id, bom.quantity_per, visited)
            )
    return node


# ---------- endpoints ----------

@router.get("")
def get_bom_items(db: Session = Depends(get_db)):
    rows = db.query(BomItem).all()
    return [
        {
            "id": r.id,
            "parent_product_id": r.parent_product_id,
            "parent_sku": r.parent.sku if r.parent else None,
            "child_product_id": r.child_product_id,
            "child_sku": r.child.sku if r.child else None,
            "quantity_per": r.quantity_per,
        }
        for r in rows
    ]


@router.get("/tree")
def get_bom_tree(db: Session = Depends(get_db)):
    """Return full BOM tree: only top-level products (not a child of anything) as roots."""
    all_bom = db.query(BomItem).all()
    child_ids = {b.child_product_id for b in all_bom}
    children_map = {}
    for b in all_bom:
        children_map.setdefault(b.parent_product_id, []).append(b)

    all_products = db.query(Product).filter(Product.active == True).all()
    product_map = {p.id: p for p in all_products}

    # Top-level = products that ARE parents (have children) but are NOT children themselves
    parent_ids = set(children_map.keys())
    top_level_ids = parent_ids - child_ids

    tree = []
    for pid in sorted(top_level_ids):
        product = product_map.get(pid)
        if product:
            tree.append(_build_tree_node(product, children_map, product_map, 0, None, None, set()))

    return tree


@router.get("/top-level-ids")
def get_top_level_ids(db: Session = Depends(get_db)):
    """Return product IDs that are NOT children in any BOM (eligible for demand planning)."""
    child_ids = {r.child_product_id for r in db.query(BomItem.child_product_id).all()}
    return {"child_product_ids": list(child_ids)}


@router.post("")
def add_bom_item(payload: BomItemCreate, db: Session = Depends(get_db)):
    if payload.parent_product_id == payload.child_product_id:
        raise HTTPException(status_code=400, detail="A product cannot be its own component.")

    # Verify products exist
    for pid in [payload.parent_product_id, payload.child_product_id]:
        if not db.query(Product).filter(Product.id == pid).first():
            raise HTTPException(status_code=404, detail=f"Product {pid} not found.")

    # Cycle detection: would adding child→parent create a cycle?
    if _has_cycle(db, payload.child_product_id, payload.parent_product_id):
        raise HTTPException(status_code=400, detail="This would create a circular BOM reference.")

    # Duplicate check
    existing = db.query(BomItem).filter(
        BomItem.parent_product_id == payload.parent_product_id,
        BomItem.child_product_id == payload.child_product_id,
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail="This component already exists in the BOM.")

    item = BomItem(
        parent_product_id=payload.parent_product_id,
        child_product_id=payload.child_product_id,
        quantity_per=payload.quantity_per,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return {"id": item.id, "parent_product_id": item.parent_product_id, "child_product_id": item.child_product_id, "quantity_per": item.quantity_per}


@router.put("/{item_id}")
def update_bom_item(item_id: int, payload: BomItemUpdate, db: Session = Depends(get_db)):
    item = db.query(BomItem).filter(BomItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="BOM item not found.")
    item.quantity_per = payload.quantity_per
    db.commit()
    return {"id": item.id, "quantity_per": item.quantity_per}


@router.delete("/{item_id}")
def delete_bom_item(item_id: int, db: Session = Depends(get_db)):
    item = db.query(BomItem).filter(BomItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="BOM item not found.")
    db.delete(item)
    db.commit()
    return {"ok": True}
