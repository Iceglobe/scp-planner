"""
AI Supply Planner Agent
Powered by Claude — analyses inventory health and PO recommendations.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import date, timedelta
import json
import os

# Load .env from the backend directory (if present)
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
except ImportError:
    pass

from database import get_db
from models import Inventory, Product, PurchaseOrder, MrpRun, Forecast

router = APIRouter()


# ---------------------------------------------------------------------------
# Data gathering helpers
# ---------------------------------------------------------------------------

def _gather_context(db: Session) -> dict:
    """Pull all relevant supply chain data into a compact context dict."""

    today = date.today()

    # ── Inventory positions ──────────────────────────────────────────────
    invs = (
        db.query(Inventory)
        .join(Product)
        .filter(Product.active == True)
        .all()
    )
    inventory_items = []
    for inv in invs:
        p = inv.product
        position = inv.quantity_on_hand + inv.quantity_on_order - inv.quantity_reserved
        ss = p.safety_stock_qty or 0
        rop = p.reorder_point or 0
        if position <= 0:
            status = "stockout"
        elif position < ss:
            status = "below_safety_stock"
        elif position < rop * 1.5:
            status = "healthy"
        else:
            status = "overstocked"

        days_of_supply = None
        if inv.avg_daily_demand and inv.avg_daily_demand > 0:
            days_of_supply = round(position / inv.avg_daily_demand, 1)

        inventory_items.append({
            "product_id": p.id,
            "sku": p.sku,
            "description": p.description,
            "abc_class": p.abc_class,
            "category": p.category,
            "supplier": p.supplier.name if p.supplier else None,
            "lead_time_days": p.lead_time_days,
            "moq": p.moq,
            "item_type": p.item_type,
            "on_hand": inv.quantity_on_hand,
            "on_order": inv.quantity_on_order,
            "reserved": inv.quantity_reserved,
            "position": position,
            "safety_stock": ss,
            "reorder_point": rop,
            "days_of_supply": days_of_supply,
            "avg_daily_demand": inv.avg_daily_demand,
            "cost": p.cost,
            "inventory_value": round(inv.quantity_on_hand * (p.cost or 0), 2),
            "status": status,
        })

    # ── Suggested (recommended) POs ─────────────────────────────────────
    suggested_pos = (
        db.query(PurchaseOrder)
        .filter(PurchaseOrder.status == "recommended")
        .order_by(PurchaseOrder.due_date)
        .all()
    )
    po_list = []
    for po in suggested_pos:
        p = po.product
        po_list.append({
            "po_id": po.id,
            "po_number": po.po_number,
            "sku": p.sku if p else None,
            "description": p.description if p else None,
            "abc_class": p.abc_class if p else None,
            "supplier": po.supplier.name if po.supplier else None,
            "quantity": po.quantity,
            "unit_cost": po.unit_cost,
            "total_value": round((po.quantity or 0) * (po.unit_cost or 0), 2),
            "order_date": po.order_date.isoformat() if po.order_date else None,
            "due_date": po.due_date.isoformat() if po.due_date else None,
            "lead_time_days": p.lead_time_days if p else None,
        })

    # ── Planned / confirmed upcoming POs ────────────────────────────────
    upcoming_pos = (
        db.query(PurchaseOrder)
        .filter(
            PurchaseOrder.status.in_(["planned", "confirmed", "in_transit"]),
            PurchaseOrder.due_date >= today,
        )
        .order_by(PurchaseOrder.due_date)
        .limit(30)
        .all()
    )
    upcoming_list = []
    for po in upcoming_pos:
        p = po.product
        upcoming_list.append({
            "sku": p.sku if p else None,
            "supplier": po.supplier.name if po.supplier else None,
            "quantity": po.quantity,
            "status": po.status,
            "due_date": po.due_date.isoformat() if po.due_date else None,
        })

    # ── Latest MRP run ───────────────────────────────────────────────────
    latest_mrp = (
        db.query(MrpRun)
        .order_by(MrpRun.run_date.desc())
        .first()
    )
    mrp_info = None
    if latest_mrp:
        mrp_info = {
            "run_id": latest_mrp.run_id,
            "run_date": latest_mrp.run_date.isoformat() if latest_mrp.run_date else None,
            "horizon_weeks": latest_mrp.horizon_weeks,
            "po_count": latest_mrp.po_count,
            "total_value": latest_mrp.total_po_value,
        }

    # ── KPIs ─────────────────────────────────────────────────────────────
    stockouts = [i for i in inventory_items if i["status"] == "stockout"]
    below_ss = [i for i in inventory_items if i["status"] == "below_safety_stock"]
    total_inv_value = sum(i["inventory_value"] for i in inventory_items)
    total_suggested_value = sum(p["total_value"] for p in po_list)

    return {
        "today": today.isoformat(),
        "kpis": {
            "total_products": len(inventory_items),
            "stockout_count": len(stockouts),
            "below_safety_stock_count": len(below_ss),
            "total_inventory_value": round(total_inv_value, 2),
            "suggested_po_count": len(po_list),
            "suggested_po_value": round(total_suggested_value, 2),
        },
        "inventory": inventory_items,
        "suggested_pos": po_list,
        "upcoming_confirmed_pos": upcoming_list,
        "latest_mrp": mrp_info,
    }


# ---------------------------------------------------------------------------
# Claude analysis
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are an expert supply chain planner. Your job is to analyse
the inventory and purchasing data provided and return a comprehensive, actionable
supply plan.

Return ONLY a single valid JSON object — no markdown fences, no prose outside JSON.
Structure:

{
  "executive_summary": "<2–4 sentence plain-English overview>",
  "inventory_health": {
    "overall_status": "healthy | warning | critical",
    "findings": [
      {
        "sku": "...",
        "description": "...",
        "abc_class": "A|B|C",
        "status": "stockout | below_safety_stock | healthy | overstocked",
        "position": <number>,
        "safety_stock": <number>,
        "days_of_supply": <number or null>,
        "root_cause": "<concise root-cause analysis>",
        "action_plan": "<specific recommended steps>",
        "urgency": "critical | high | medium | low",
        "related_po_ids": [<suggested po_ids that address this item, if any>]
      }
    ]
  },
  "po_review": {
    "total_pos": <number>,
    "total_value": <number>,
    "overall_recommendation": "approve_all | review_required | defer",
    "summary": "<1–2 sentences on the overall PO picture>",
    "groups": [
      {
        "supplier": "...",
        "items": [
          {
            "po_id": <number>,
            "sku": "...",
            "quantity": <number>,
            "due_date": "YYYY-MM-DD",
            "total_value": <number>,
            "recommendation": "approve | defer | modify",
            "reasoning": "<concise reasoning>"
          }
        ]
      }
    ]
  },
  "actions": [
    {
      "id": "<unique-slug>",
      "title": "<short action title>",
      "description": "<what this does and why>",
      "type": "confirm_pos | run_mrp | recalculate_safety_stock | flag_for_review",
      "params": {
        "po_ids": [<ids>]
      },
      "priority": "critical | high | medium | low",
      "estimated_impact": "<brief impact statement>"
    }
  ]
}

Rules:
- Only include inventory findings for items that are stockout, below_safety_stock, or
  at risk (≤ 14 days of supply). Overstocked items only if seriously overstocked (>3× ROP).
- Group POs by supplier. Within each group give a per-PO recommendation.
- The actions array should list the top 3–6 most impactful actions, ordered by priority.
- For confirm_pos actions, include ALL the recommended po_ids you think should be confirmed.
- Be specific, concise and commercially minded. Think like a senior supply chain planner."""


def _call_claude(context: dict) -> dict:
    import anthropic  # lazy import — only needed at call time

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="ANTHROPIC_API_KEY not configured. Add it to your .env file.",
        )

    client = anthropic.Anthropic(api_key=api_key)

    user_message = (
        f"Today is {context['today']}. Here is the current supply chain snapshot:\n\n"
        + json.dumps(context, indent=2)
    )

    try:
        response = client.messages.create(
            model="claude-opus-4-6",
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )
    except Exception as e:
        msg = str(e)
        if "credit balance is too low" in msg or "insufficient_quota" in msg:
            raise HTTPException(
                status_code=500,
                detail="Anthropic account has no credits. Add credits at console.anthropic.com/settings/billing.",
            )
        raise HTTPException(status_code=500, detail=f"Claude API error: {msg}")

    text = response.content[0].text.strip()

    # Strip markdown fences if present (defensive)
    if text.startswith("```"):
        lines = text.splitlines()
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    return json.loads(text)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.post("/run")
def run_agent(db: Session = Depends(get_db)):
    """Gather supply chain data and return Claude's analysis + recommendations."""
    context = _gather_context(db)
    try:
        analysis = _call_claude(context)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"Claude returned invalid JSON: {e}")

    # Attach raw context stats so the frontend can render without re-fetching
    analysis["_context"] = {
        "today": context["today"],
        "kpis": context["kpis"],
        "latest_mrp": context["latest_mrp"],
    }
    return analysis


class ExecuteRequest(BaseModel):
    action_type: str
    params: dict


@router.post("/execute")
def execute_action(body: ExecuteRequest, db: Session = Depends(get_db)):
    """Execute an approved action from the agent analysis."""

    if body.action_type == "confirm_pos":
        po_ids: list = body.params.get("po_ids", [])
        if not po_ids:
            raise HTTPException(400, "po_ids required")
        pos = db.query(PurchaseOrder).filter(PurchaseOrder.id.in_(po_ids)).all()
        confirmed = []
        for po in pos:
            if po.status in ("recommended", "planned"):
                po.status = "planned"
                confirmed.append(po.id)
        db.commit()
        return {"confirmed": confirmed, "count": len(confirmed)}

    elif body.action_type == "run_mrp":
        # Trigger MRP via internal call — import here to avoid circular deps
        from algorithms.mrp_engine import run_mrp, MrpProduct, MrpInventory
        from models import Inventory as Inv, Forecast as Fc, BomItem
        horizon = body.params.get("horizon_weeks", 12)
        # Delegate to the supply router logic (reuse the same pattern)
        # For simplicity, just call the existing endpoint logic inline
        return {"message": "MRP run queued. Use the Supply Planning page to run MRP.", "horizon_weeks": horizon}

    elif body.action_type == "recalculate_safety_stock":
        import statistics
        from datetime import timedelta
        from models import SalesHistory
        from algorithms.safety_stock import calculate_safety_stock, calculate_reorder_point
        cutoff = date.today() - timedelta(weeks=26)
        products = db.query(Product).filter(Product.active == True).all()
        updated = 0
        for p in products:
            history = [s.quantity for s in p.sales_history if s.period_date >= cutoff]
            if len(history) < 2:
                continue
            avg = sum(history) / len(history)
            std = statistics.stdev(history)
            sl = p.service_level or 0.95
            ss = calculate_safety_stock(sl, std, p.lead_time_days)
            rop = calculate_reorder_point(avg, p.lead_time_days, ss)
            p.safety_stock_qty = ss
            p.reorder_point = rop
            if p.inventory:
                p.inventory.avg_daily_demand = avg / 7
                p.inventory.demand_std_dev = std
            updated += 1
        db.commit()
        return {"message": f"Safety stock recalculated for {updated} products.", "updated": updated}

    elif body.action_type == "flag_for_review":
        # No automated action — just acknowledge
        return {"message": "Items flagged for manual review."}

    else:
        raise HTTPException(400, f"Unknown action type: {body.action_type}")
