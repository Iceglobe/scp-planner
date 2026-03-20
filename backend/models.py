from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, Date, ForeignKey, Text, UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from database import Base


class Supplier(Base):
    __tablename__ = "suppliers"
    id = Column(Integer, primary_key=True, autoincrement=True)
    code = Column(String, unique=True, nullable=False)
    name = Column(String, nullable=False)
    contact_email = Column(String)
    lead_time_days = Column(Float, nullable=False, default=7.0)
    min_order_qty = Column(Float, default=0.0)
    currency = Column(String, default="USD")
    active = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    products = relationship("Product", back_populates="supplier")
    purchase_orders = relationship("PurchaseOrder", back_populates="supplier")


class Product(Base):
    __tablename__ = "products"
    id = Column(Integer, primary_key=True, autoincrement=True)
    sku = Column(String, unique=True, nullable=False)
    description = Column(String, nullable=False)
    category = Column(String)
    unit_of_measure = Column(String, default="EA")
    cost = Column(Float, nullable=False, default=0.0)
    selling_price = Column(Float, default=0.0)
    supplier_id = Column(Integer, ForeignKey("suppliers.id"))
    lead_time_days = Column(Float, nullable=False, default=7.0)
    moq = Column(Float, default=1.0)
    reorder_point = Column(Float, default=0.0)
    safety_stock_days = Column(Float, default=7.0)
    safety_stock_qty = Column(Float, default=0.0)
    service_level = Column(Float, default=0.95)
    abc_class = Column(String)
    item_type = Column(String, default="purchased")   # "purchased" | "produced"
    max_weekly_capacity = Column(Float)               # nullable = no constraint
    smoothing_alpha = Column(Float, default=0.3)
    active = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    supplier = relationship("Supplier", back_populates="products")
    sales_history = relationship("SalesHistory", back_populates="product")
    forecasts = relationship("Forecast", back_populates="product")
    inventory = relationship("Inventory", back_populates="product", uselist=False)
    purchase_orders = relationship("PurchaseOrder", back_populates="product")
    production_orders = relationship("ProductionOrder", back_populates="product")


class SalesHistory(Base):
    __tablename__ = "sales_history"
    id = Column(Integer, primary_key=True, autoincrement=True)
    product_id = Column(Integer, ForeignKey("products.id"), nullable=False)
    period_date = Column(Date, nullable=False)
    quantity = Column(Float, nullable=False)
    revenue = Column(Float, default=0.0)
    source = Column(String, default="actual")
    created_at = Column(DateTime, server_default=func.now())

    product = relationship("Product", back_populates="sales_history")
    __table_args__ = (UniqueConstraint("product_id", "period_date"),)


class ForecastRun(Base):
    __tablename__ = "forecast_runs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String, unique=True, nullable=False)
    name = Column(String)                              # user-assigned name (nullable = unsaved draft)
    model = Column(String, nullable=False)
    periods_ahead = Column(Integer, nullable=False)
    granularity = Column(String, default="week")
    mape = Column(Float)
    mae = Column(Float)
    created_at = Column(DateTime, server_default=func.now())

    forecasts = relationship("Forecast", back_populates="run")


class Forecast(Base):
    __tablename__ = "forecasts"
    id = Column(Integer, primary_key=True, autoincrement=True)
    product_id = Column(Integer, ForeignKey("products.id"), nullable=False)
    run_id = Column(String, ForeignKey("forecast_runs.run_id"), nullable=False)
    model = Column(String, nullable=False)
    period_date = Column(Date, nullable=False)
    forecast_qty = Column(Float, nullable=False)
    lower_bound = Column(Float)
    upper_bound = Column(Float)
    is_adjusted = Column(Boolean, default=False)
    adjusted_qty = Column(Float)
    adjusted_by = Column(String)
    adjusted_at = Column(DateTime)
    created_at = Column(DateTime, server_default=func.now())

    product = relationship("Product", back_populates="forecasts")
    run = relationship("ForecastRun", back_populates="forecasts")
    __table_args__ = (UniqueConstraint("product_id", "period_date", "run_id"),)


class ForecastAdjustLog(Base):
    __tablename__ = "forecast_adjust_log"
    id = Column(Integer, primary_key=True, autoincrement=True)
    forecast_id = Column(Integer, ForeignKey("forecasts.id"), nullable=False)
    product_id = Column(Integer, ForeignKey("products.id"), nullable=False)
    period_date = Column(Date, nullable=False)
    old_qty = Column(Float)
    new_qty = Column(Float, nullable=False)
    changed_by = Column(String, default="user")
    changed_at = Column(DateTime, server_default=func.now())

    product = relationship("Product")


class Inventory(Base):
    __tablename__ = "inventory"
    id = Column(Integer, primary_key=True, autoincrement=True)
    product_id = Column(Integer, ForeignKey("products.id"), unique=True, nullable=False)
    quantity_on_hand = Column(Float, nullable=False, default=0.0)
    quantity_on_order = Column(Float, default=0.0)
    quantity_reserved = Column(Float, default=0.0)
    avg_daily_demand = Column(Float, default=0.0)
    demand_std_dev = Column(Float, default=0.0)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    product = relationship("Product", back_populates="inventory")


class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"
    id = Column(Integer, primary_key=True, autoincrement=True)
    po_number = Column(String, unique=True)
    product_id = Column(Integer, ForeignKey("products.id"), nullable=False)
    supplier_id = Column(Integer, ForeignKey("suppliers.id"))
    status = Column(String, default="recommended")
    quantity = Column(Float, nullable=False)
    unit_cost = Column(Float)
    order_date = Column(Date)
    due_date = Column(Date)
    received_date = Column(Date)
    notes = Column(Text)
    mrp_run_id = Column(String)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    product = relationship("Product", back_populates="purchase_orders")
    supplier = relationship("Supplier", back_populates="purchase_orders")


class ProductionOrder(Base):
    __tablename__ = "production_orders"
    id = Column(Integer, primary_key=True, autoincrement=True)
    wo_number = Column(String, unique=True)
    product_id = Column(Integer, ForeignKey("products.id"), nullable=False)
    work_center = Column(String)
    status = Column(String, default="planned")
    quantity = Column(Float, nullable=False)
    unit_cost = Column(Float)
    order_date = Column(Date)
    due_date = Column(Date)
    notes = Column(Text)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    product = relationship("Product", back_populates="production_orders")


class MrpRun(Base):
    __tablename__ = "mrp_runs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String, unique=True, nullable=False)
    run_date = Column(DateTime, server_default=func.now())
    horizon_weeks = Column(Integer, default=12)
    status = Column(String, default="completed")
    po_count = Column(Integer)
    total_po_value = Column(Float)
    created_at = Column(DateTime, server_default=func.now())


class ChangeLog(Base):
    __tablename__ = "changelog"
    id = Column(Integer, primary_key=True, autoincrement=True)
    entity_type = Column(String, nullable=False)   # "product" | "supplier"
    entity_id = Column(Integer, nullable=False)
    entity_name = Column(String)                   # SKU or supplier code
    field = Column(String, nullable=False)
    old_value = Column(Text)
    new_value = Column(Text)
    changed_by = Column(String, default="user")
    changed_at = Column(DateTime, server_default=func.now())


class CustomerDemand(Base):
    __tablename__ = "customer_demand"
    id = Column(Integer, primary_key=True, autoincrement=True)
    product_id = Column(Integer, ForeignKey("products.id"), nullable=False)
    customer = Column(String, nullable=False)
    period_date = Column(Date, nullable=False)
    quantity = Column(Float, nullable=False, default=0.0)
    revenue = Column(Float, default=0.0)
    source = Column(String, default="actual")  # "actual" | "forecast"
    created_at = Column(DateTime, server_default=func.now())

    product = relationship("Product")
    __table_args__ = (UniqueConstraint("product_id", "customer", "period_date", "source"),)


class BomItem(Base):
    __tablename__ = "bom_items"
    id = Column(Integer, primary_key=True, autoincrement=True)
    parent_product_id = Column(Integer, ForeignKey("products.id"), nullable=False)
    child_product_id = Column(Integer, ForeignKey("products.id"), nullable=False)
    quantity_per = Column(Float, nullable=False, default=1.0)
    created_at = Column(DateTime, server_default=func.now())

    parent = relationship("Product", foreign_keys=[parent_product_id])
    child = relationship("Product", foreign_keys=[child_product_id])
    __table_args__ = (UniqueConstraint("parent_product_id", "child_product_id"),)


class DataConnector(Base):
    __tablename__ = "data_connectors"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    connector_type = Column(String, nullable=False)
    target_entity = Column(String, nullable=False)
    config = Column(Text)
    status = Column(String, default="not_configured")
    last_sync = Column(DateTime)
    last_sync_rows = Column(Integer)
    error_msg = Column(Text)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
