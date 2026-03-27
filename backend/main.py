from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from database import DATABASE_URL
import models  # noqa: ensure all models are registered
import os
from alembic.config import Config as AlembicConfig
from alembic import command as alembic_command

from routers import products, suppliers, demand, forecasts, inventory, supply, connectors, analytics, bom, agent, workstations, value_stream


def run_migrations() -> None:
    from sqlalchemy import inspect
    from database import engine

    cfg = AlembicConfig(os.path.join(os.path.dirname(__file__), "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", DATABASE_URL)

    # If tables already exist but Alembic has never run, stamp as initial
    # revision so it doesn't try to recreate tables that are already there.
    existing_tables = inspect(engine).get_table_names()
    if existing_tables and "alembic_version" not in existing_tables:
        alembic_command.stamp(cfg, "001")

    alembic_command.upgrade(cfg, "head")


run_migrations()

app = FastAPI(title="Supply Chain Planner API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", "http://localhost:8000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(products.router, prefix="/api/products", tags=["products"])
app.include_router(suppliers.router, prefix="/api/suppliers", tags=["suppliers"])
app.include_router(demand.router, prefix="/api/demand", tags=["demand"])
app.include_router(forecasts.router, prefix="/api/forecasts", tags=["forecasts"])
app.include_router(inventory.router, prefix="/api/inventory", tags=["inventory"])
app.include_router(supply.router, prefix="/api/supply", tags=["supply"])
app.include_router(connectors.router, prefix="/api/connectors", tags=["connectors"])
app.include_router(analytics.router, prefix="/api/analytics", tags=["analytics"])
app.include_router(bom.router, prefix="/api/bom", tags=["bom"])
app.include_router(agent.router, prefix="/api/agent", tags=["agent"])
app.include_router(workstations.router, prefix="/api/workstations", tags=["workstations"])
app.include_router(value_stream.router, prefix="/api/value-stream", tags=["value-stream"])


@app.get("/api/health")
def health():
    return {"status": "ok"}

# Serve frontend static files
_dist = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
if os.path.isdir(_dist):
    app.mount("/assets", StaticFiles(directory=os.path.join(_dist, "assets")), name="assets")

    @app.get("/{full_path:path}")
    def serve_frontend(full_path: str):
        return FileResponse(os.path.join(_dist, "index.html"))
