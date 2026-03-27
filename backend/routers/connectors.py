from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
import json, io
from datetime import date
from pathlib import Path
from database import get_db
from models import DataConnector, Product, SalesHistory, Inventory, CustomerDemand, PurchaseOrder, ProductionOrder, Supplier

router = APIRouter()

UPLOADS_DIR = Path(__file__).parent.parent / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)


class ConnectorCreate(BaseModel):
    name: str
    connector_type: str
    target_entity: str
    config: Optional[dict] = None


class SqlTestRequest(BaseModel):
    connection_string: str
    query: str


@router.get("")
def list_connectors(db: Session = Depends(get_db)):
    rows = db.query(DataConnector).all()
    return [_conn_dict(r) for r in rows]


@router.post("")
def create_connector(body: ConnectorCreate, db: Session = Depends(get_db)):
    c = DataConnector(
        name=body.name,
        connector_type=body.connector_type,
        target_entity=body.target_entity,
        config=json.dumps(body.config) if body.config else None,
    )
    db.add(c)
    db.commit()
    db.refresh(c)
    return _conn_dict(c)


@router.delete("/{cid}")
def delete_connector(cid: int, db: Session = Depends(get_db)):
    c = db.query(DataConnector).filter(DataConnector.id == cid).first()
    if not c:
        raise HTTPException(404)
    db.delete(c)
    db.commit()
    return {"ok": True}


@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    target_entity: str = Form(...),
    column_mapping: str = Form("{}"),
    import_mode: str = Form("append"),  # "append" | "replace"
    db: Session = Depends(get_db),
):
    import pandas as pd
    mapping = json.loads(column_mapping)
    content = await file.read()

    try:
        if file.filename.endswith(".csv"):
            df = pd.read_csv(io.BytesIO(content))
        else:
            df = pd.read_excel(io.BytesIO(content))
    except Exception as e:
        raise HTTPException(400, f"Could not parse file: {e}")

    # Normalise column names: lowercase + strip whitespace
    df.columns = [str(c).strip().lower().replace(" ", "_") for c in df.columns]

    # Apply explicit column mapping after normalisation
    if mapping:
        df = df.rename(columns=mapping)

    # Save file + meta to disk so Refresh can re-import without re-uploading
    suffix = ".csv" if (file.filename or "").endswith(".csv") else ".xlsx"
    (UPLOADS_DIR / f"{target_entity}_latest{suffix}").write_bytes(content)
    (UPLOADS_DIR / f"{target_entity}_latest.meta.json").write_text(json.dumps({
        "filename": file.filename,
        "suffix": suffix,
        "column_mapping": mapping,
        "import_mode": import_mode,
    }))

    result = _import_dataframe(df, target_entity, import_mode, db)
    return {**result, "columns_found": list(df.columns)}


@router.post("/{entity}/refresh")
def refresh_entity(entity: str, db: Session = Depends(get_db)):
    import pandas as pd
    meta_path = UPLOADS_DIR / f"{entity}_latest.meta.json"
    if not meta_path.exists():
        raise HTTPException(404, "No saved file for this entity. Upload a file first.")
    meta = json.loads(meta_path.read_text())

    source_url = meta.get("source_url", "")
    mapping = meta.get("column_mapping") or {}

    # If the source was a URL (excel_link), re-fetch live data instead of using cached file
    if source_url and ("drive.google.com" in source_url or "dropbox.com" in source_url or
                       source_url.startswith("http") and not source_url.startswith("http://localhost")):
        import httpx, re as _re
        fetch_url = source_url
        gs = _re.search(r"docs\.google\.com/spreadsheets/d/([A-Za-z0-9_\-]+)", source_url)
        gid_m = _re.search(r"[#&?]gid=(\d+)", source_url)
        if gs:
            fetch_url = f"https://docs.google.com/spreadsheets/d/{gs.group(1)}/export?format=xlsx"
            if gid_m:
                fetch_url += f"&gid={gid_m.group(1)}"
        else:
            gd = _re.search(r"drive\.google\.com/(?:file/d/|open\?id=)([A-Za-z0-9_\-]+)", source_url)
            if gd:
                fetch_url = f"https://drive.usercontent.google.com/download?id={gd.group(1)}&export=download&confirm=t"
        try:
            with httpx.Client(verify=False, follow_redirects=True, timeout=60) as client:
                headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
                resp = client.get(fetch_url, headers=headers)
                resp.raise_for_status()
                content = resp.content
                content_type = resp.headers.get("content-type", "")
                if "text/html" in content_type or content[:5] in (b"<!DOC", b"<html"):
                    raise HTTPException(400, "URL returned HTML instead of a file. Check sharing settings.")
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(400, f"Could not re-fetch from source URL: {e}") from None
        # Update cached file
        (UPLOADS_DIR / f"{entity}_latest{meta['suffix']}").write_bytes(content)
    else:
        file_path = UPLOADS_DIR / f"{entity}_latest{meta['suffix']}"
        if not file_path.exists():
            raise HTTPException(404, "Saved file not found on server.")
        content = file_path.read_bytes()

    try:
        if meta["suffix"] == ".csv":
            df = pd.read_csv(io.BytesIO(content))
        else:
            df = pd.read_excel(io.BytesIO(content))
    except Exception as e:
        raise HTTPException(400, f"Could not parse file: {e}")

    df.columns = [str(c).strip().lower().replace(" ", "_") for c in df.columns]
    if mapping:
        df = df.rename(columns=mapping)

    try:
        result = _import_dataframe(df, entity, meta.get("import_mode", "append"), db)
    except Exception as e:
        raise HTTPException(500, f"Import failed: {e}") from None
    return {**result, "columns_found": list(df.columns)}


class FetchExcelRequest(BaseModel):
    url: str
    target_entity: str
    column_mapping: Optional[dict] = None
    import_mode: str = "append"


@router.post("/fetch-excel")
def fetch_excel(body: FetchExcelRequest, db: Session = Depends(get_db)):
    import pandas as pd
    import httpx

    url = body.url.strip()

    # OneDrive personal share links block server-side downloads — convert to error with guidance
    if "1drv.ms" in url or ("onedrive.live.com" in url and "download" not in url):
        raise HTTPException(400,
            "OneDrive personal links can't be downloaded server-side (Microsoft blocks non-browser access). "
            "Upload the file to Google Drive instead: Share → 'Anyone with the link can view' → copy the link and paste it here."
        )

    # Convert Google URLs to direct download URLs
    import re as _re

    # Google Sheets: docs.google.com/spreadsheets/d/ID/edit?gid=GID
    gs = _re.search(r"docs\.google\.com/spreadsheets/d/([A-Za-z0-9_\-]+)", url)
    gid_match = _re.search(r"[#&?]gid=(\d+)", url)
    if gs:
        sheet_id = gs.group(1)
        export = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=xlsx"
        if gid_match:
            export += f"&gid={gid_match.group(1)}"
        url = export

    # Google Drive file: drive.google.com/file/d/ID
    gd = _re.search(r"drive\.google\.com/(?:file/d/|open\?id=)([A-Za-z0-9_\-]+)", url)
    if gd:
        url = f"https://drive.usercontent.google.com/download?id={gd.group(1)}&export=download&confirm=t"

    try:
        with httpx.Client(verify=False, follow_redirects=True, timeout=60) as client:
            headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
            resp = client.get(url, headers=headers)

            if resp.status_code == 401:
                raise HTTPException(400,
                    "Access denied (401) — the file isn't shared publicly. "
                    "In Google Sheets: click Share → change to 'Anyone with the link can view' → Done."
                )
            resp.raise_for_status()
            content = resp.content
            content_type = resp.headers.get("content-type", "")

            # Large Drive files: extract confirm token and retry
            if "text/html" in content_type and b"confirm" in content and gd:
                m = _re.search(rb'confirm=([A-Za-z0-9_\-]+)', content)
                if m:
                    retry_url = f"https://drive.usercontent.google.com/download?id={gd.group(1)}&export=download&confirm={m.group(1).decode()}"
                    resp = client.get(retry_url, headers=headers)
                    resp.raise_for_status()
                    content = resp.content
                    content_type = resp.headers.get("content-type", "")

            if "text/html" in content_type or content[:5] in (b"<!DOC", b"<html"):
                raise HTTPException(400,
                    "The URL returned a page instead of a file. "
                    "Make sure the file is shared as 'Anyone with the link can view'."
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"Could not fetch file: {e}")

    try:
        if "spreadsheet" in content_type or "excel" in content_type or url.endswith(".xlsx") or b"xl/" in content[:4]:
            df = pd.read_excel(io.BytesIO(content))
        else:
            df = pd.read_csv(io.BytesIO(content))
    except Exception as e:
        raise HTTPException(400, f"Could not parse file: {e}")

    df.columns = [str(c).strip().lower().replace(" ", "_") for c in df.columns]
    mapping = body.column_mapping or {}
    if mapping:
        df = df.rename(columns=mapping)

    # Save for future refreshes — store original URL so Refresh re-fetches live data
    (UPLOADS_DIR / f"{body.target_entity}_latest.xlsx").write_bytes(content)
    (UPLOADS_DIR / f"{body.target_entity}_latest.meta.json").write_text(json.dumps({
        "filename": body.url.strip().split("/")[-1] or "excel_link",
        "suffix": ".xlsx",
        "column_mapping": mapping,
        "import_mode": body.import_mode,
        "source_url": body.url.strip(),
    }))

    result = _import_dataframe(df, body.target_entity, body.import_mode, db)
    return {**result, "columns_found": list(df.columns)}


@router.post("/test-sql")
def test_sql(body: SqlTestRequest):
    try:
        from sqlalchemy import create_engine, text
        engine = create_engine(body.connection_string)
        with engine.connect() as conn:
            result = conn.execute(text(body.query))
            rows = [dict(r) for r in result.fetchmany(5)]
        return {"success": True, "preview": rows}
    except Exception as e:
        return {"success": False, "error": str(e)}



def _import_dataframe(df, target_entity: str, import_mode: str, db: Session) -> dict:
    """Run entity-specific import logic on an already-parsed, already-mapped DataFrame."""
    import pandas as pd

    # Replace mode: wipe existing records for this entity before inserting
    if import_mode == "replace":
        entity_model_map = {
            "sales_history": SalesHistory,
            "inventory": Inventory,
            "products": Product,
            "purchase_orders": PurchaseOrder,
            "production_orders": ProductionOrder,
            "customer_orders": CustomerDemand,
        }
        model = entity_model_map.get(target_entity)
        if model:
            if target_entity == "inventory":
                db.query(Inventory).update({"quantity_on_hand": 0})
            elif target_entity == "products":
                db.query(SalesHistory).delete()
                db.query(Inventory).delete()
                db.query(PurchaseOrder).delete()
                db.query(ProductionOrder).delete()
                db.query(CustomerDemand).delete()
                db.query(Product).delete()
            else:
                db.query(model).delete()
            db.flush()

    rows_imported = 0
    first_error: str | None = None

    all_skus = [str(s).strip() for s in df.get("sku", df.get("item_id", pd.Series([]))) if str(s).strip()]

    # Build product map by exact SKU first, then add numeric-normalized fallback keys
    # so that e.g. "P001" matches a product stored as "SKU-001" (both normalize to "1")
    import re as _re
    def _sku_num(s: str) -> str:
        digits = _re.sub(r"[^0-9]", "", s)
        return str(int(digits)) if digits else s

    all_products = db.query(Product).all()
    product_map: dict[str, Product] = {p.sku: p for p in all_products}
    # Add normalized-numeric aliases for any SKU not already in the map
    num_map: dict[str, Product] = {}
    for p in all_products:
        num_map[_sku_num(p.sku)] = p
    for file_sku in all_skus:
        if file_sku not in product_map:
            match = num_map.get(_sku_num(file_sku))
            if match:
                product_map[file_sku] = match

    if target_entity == "sales_history":
        existing_map: dict[tuple, SalesHistory] = {}
        if product_map:
            for r in db.query(SalesHistory).filter(
                SalesHistory.product_id.in_([p.id for p in product_map.values()])
            ).all():
                existing_map[(r.product_id, r.period_date, r.customer)] = r

        for _, row in df.iterrows():
            try:
                sku = str(row.get("sku", "")).strip()
                p = product_map.get(sku)
                if not p:
                    continue
                period_date = pd.to_datetime(row.get("period_date")).date()
                quantity = float(row.get("quantity", 0))
                revenue = float(row.get("revenue", 0))
                customer_val = row.get("customers") or row.get("customer")
                customer = str(customer_val).strip() if customer_val is not None and str(customer_val).strip() not in ("", "nan") else None
                key = (p.id, period_date, customer)
                if key in existing_map:
                    existing_map[key].quantity = quantity
                    existing_map[key].revenue = revenue
                else:
                    obj = SalesHistory(
                        product_id=p.id, period_date=period_date,
                        quantity=quantity, revenue=revenue, source="upload",
                        customer=customer,
                    )
                    db.add(obj)
                    existing_map[key] = obj
                rows_imported += 1
            except Exception as e:
                if first_error is None:
                    first_error = str(e)

    elif target_entity == "inventory":
        for _, row in df.iterrows():
            try:
                sku = str(row.get("sku", "")).strip()
                p = product_map.get(sku)
                if not p or not p.inventory:
                    continue
                p.inventory.quantity_on_hand = float(row.get("quantity_on_hand", 0))
                rows_imported += 1
            except Exception as e:
                if first_error is None:
                    first_error = str(e)

    elif target_entity == "products":
        for _, row in df.iterrows():
            try:
                sku = str(row.get("sku", "")).strip()
                if not sku:
                    continue
                p = db.query(Product).filter(Product.sku == sku).first()
                fields = {
                    k: row.get(k)
                    for k in ["description", "category", "cost", "selling_price",
                               "lead_time_days", "moq", "unit_of_measure",
                               "smoothing_alpha", "service_level", "safety_stock_days",
                               "reorder_point", "item_type", "max_weekly_capacity"]
                    if row.get(k) is not None and str(row.get(k)).strip() != ""
                }
                supplier_id = None
                supplier_name = str(row.get("supplier", "") or "").strip()
                if supplier_name:
                    sup = db.query(Supplier).filter(Supplier.name.ilike(f"%{supplier_name}%")).first()
                    if sup:
                        supplier_id = sup.id
                if not p:
                    p = Product(sku=sku, description=fields.get("description", sku))
                    db.add(p)
                    db.flush()
                    db.add(Inventory(product_id=p.id, quantity_on_hand=0))
                for k, v in fields.items():
                    setattr(p, k, v)
                if supplier_id:
                    p.supplier_id = supplier_id
                rows_imported += 1
            except Exception as e:
                if first_error is None:
                    first_error = str(e)

    elif target_entity == "purchase_orders":
        import uuid
        for _, row in df.iterrows():
            try:
                sku = str(row.get("sku", "")).strip()
                p = product_map.get(sku)
                if not p:
                    continue
                po_number = str(row.get("po_number", f"PO-IMP-{uuid.uuid4().hex[:8].upper()}")).strip()
                quantity = float(row.get("quantity", 0))
                unit_cost = float(row.get("unit_cost", p.cost or 0))
                order_date = pd.to_datetime(row.get("order_date")).date() if row.get("order_date") else None
                due_date = pd.to_datetime(row.get("due_date")).date() if row.get("due_date") else None
                existing = db.query(PurchaseOrder).filter(PurchaseOrder.po_number == po_number).first()
                if existing:
                    existing.quantity = quantity
                    existing.unit_cost = unit_cost
                    if due_date:
                        existing.due_date = due_date
                else:
                    db.add(PurchaseOrder(
                        po_number=po_number, product_id=p.id,
                        supplier_id=p.supplier_id, status="confirmed",
                        quantity=quantity, unit_cost=unit_cost,
                        order_date=order_date, due_date=due_date,
                    ))
                rows_imported += 1
            except Exception as e:
                if first_error is None:
                    first_error = str(e)

    elif target_entity == "production_orders":
        import uuid
        for _, row in df.iterrows():
            try:
                sku = str(row.get("sku", "")).strip()
                p = product_map.get(sku)
                if not p:
                    continue
                wo_number = str(row.get("po_number", f"WO-IMP-{uuid.uuid4().hex[:8].upper()}")).strip()
                quantity = float(row.get("quantity", 0))
                unit_cost = float(row.get("unit_cost", p.cost or 0)) if row.get("unit_cost") else None
                order_date = pd.to_datetime(row.get("order_date")).date() if row.get("order_date") else None
                due_date = pd.to_datetime(row.get("due_date")).date() if row.get("due_date") else None
                work_center = str(row.get("supplier", "") or "").strip() or None
                existing = db.query(ProductionOrder).filter(ProductionOrder.wo_number == wo_number).first()
                if existing:
                    existing.quantity = quantity
                    if unit_cost is not None:
                        existing.unit_cost = unit_cost
                    if due_date:
                        existing.due_date = due_date
                    if work_center:
                        existing.work_center = work_center
                else:
                    db.add(ProductionOrder(
                        wo_number=wo_number, product_id=p.id,
                        work_center=work_center, status="planned",
                        quantity=quantity, unit_cost=unit_cost,
                        order_date=order_date, due_date=due_date,
                    ))
                rows_imported += 1
            except Exception as e:
                if first_error is None:
                    first_error = str(e)

    elif target_entity == "customer_orders":
        existing_cd: dict[tuple, CustomerDemand] = {}
        if product_map:
            for r in db.query(CustomerDemand).filter(
                CustomerDemand.product_id.in_([p.id for p in product_map.values()]),
                CustomerDemand.source == "actual",
            ).all():
                existing_cd[(r.product_id, r.customer, r.period_date)] = r

        for _, row in df.iterrows():
            try:
                sku = str(row.get("sku", "")).strip()
                p = product_map.get(sku)
                if not p:
                    continue
                period_date = pd.to_datetime(row.get("due_date") or row.get("period_date")).date()
                quantity = float(row.get("quantity", 0))
                revenue = float(row.get("revenue", 0))
                customer = str(row.get("customer", "")).strip() or "unknown"
                key = (p.id, customer, period_date)
                if key in existing_cd:
                    existing_cd[key].quantity = quantity
                    existing_cd[key].revenue = revenue
                else:
                    obj = CustomerDemand(
                        product_id=p.id, customer=customer,
                        period_date=period_date, quantity=quantity,
                        revenue=revenue, source="actual",
                    )
                    db.add(obj)
                    existing_cd[key] = obj
                rows_imported += 1
            except Exception as e:
                if first_error is None:
                    first_error = str(e)

    db.commit()

    # After importing sales history, auto-refresh demand stats so SS/ROP stay current.
    if target_entity == "sales_history":
        import statistics as _stats
        from datetime import date as _date, timedelta as _td
        from algorithms.safety_stock import (
            calculate_safety_stock as _calc_ss,
            calculate_reorder_point as _calc_rop,
            suggest_service_level as _suggest_sl,
        )
        from routers.products import _weekly_demand_stats
        cutoff = _date.today() - _td(weeks=26)
        exempt = {'NPI', 'Phase Out'}
        seen_ids: set[int] = set()
        for p in product_map.values():
            if p is None or p.id in seen_ids or p.abc_class in exempt:
                continue
            seen_ids.add(p.id)
            rows = db.query(SalesHistory).filter(
                SalesHistory.product_id == p.id,
                SalesHistory.period_date >= cutoff,
            ).all()
            stats = _weekly_demand_stats(rows)
            if stats is None:
                continue
            avg_weekly, std_weekly, avg_daily = stats
            sl = p.service_level or _suggest_sl(p.abc_class or "B")
            ss = _calc_ss(sl, std_weekly, p.lead_time_days)
            rop = _calc_rop(avg_weekly, p.lead_time_days, ss)
            p.safety_stock_qty = ss
            p.reorder_point = rop
            if p.inventory:
                p.inventory.avg_daily_demand = round(avg_daily, 4)
                p.inventory.demand_std_dev = round(std_weekly, 4)
        db.commit()

    return {"rows_imported": rows_imported, "total_rows": len(df), "error": first_error}


def _conn_dict(c: DataConnector) -> dict:
    return {
        "id": c.id, "name": c.name, "connector_type": c.connector_type,
        "target_entity": c.target_entity, "status": c.status,
        "last_sync": c.last_sync.isoformat() if c.last_sync else None,
        "last_sync_rows": c.last_sync_rows, "error_msg": c.error_msg,
    }
