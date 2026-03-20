from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from database import engine, Base
import models  # noqa: ensure all models are registered
import os

from routers import products, suppliers, demand, forecasts, inventory, supply, connectors, analytics, bom

Base.metadata.create_all(bind=engine)

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
