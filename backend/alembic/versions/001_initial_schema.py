"""initial schema

Revision ID: 001
Revises:
Create Date: 2026-03-22

"""
from alembic import op
import sqlalchemy as sa

revision = "001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "suppliers",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("code", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("contact_email", sa.String(), nullable=True),
        sa.Column("lead_time_days", sa.Float(), nullable=False),
        sa.Column("min_order_qty", sa.Float(), nullable=True),
        sa.Column("currency", sa.String(), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code"),
    )

    op.create_table(
        "products",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("sku", sa.String(), nullable=False),
        sa.Column("description", sa.String(), nullable=False),
        sa.Column("category", sa.String(), nullable=True),
        sa.Column("unit_of_measure", sa.String(), nullable=True),
        sa.Column("cost", sa.Float(), nullable=False),
        sa.Column("selling_price", sa.Float(), nullable=True),
        sa.Column("supplier_id", sa.Integer(), nullable=True),
        sa.Column("lead_time_days", sa.Float(), nullable=False),
        sa.Column("moq", sa.Float(), nullable=True),
        sa.Column("reorder_point", sa.Float(), nullable=True),
        sa.Column("safety_stock_days", sa.Float(), nullable=True),
        sa.Column("safety_stock_qty", sa.Float(), nullable=True),
        sa.Column("service_level", sa.Float(), nullable=True),
        sa.Column("abc_class", sa.String(), nullable=True),
        sa.Column("item_type", sa.String(), nullable=True),
        sa.Column("max_weekly_capacity", sa.Float(), nullable=True),
        sa.Column("smoothing_alpha", sa.Float(), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.ForeignKeyConstraint(["supplier_id"], ["suppliers.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("sku"),
    )

    op.create_table(
        "sales_history",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("product_id", sa.Integer(), nullable=False),
        sa.Column("period_date", sa.Date(), nullable=False),
        sa.Column("quantity", sa.Float(), nullable=False),
        sa.Column("revenue", sa.Float(), nullable=True),
        sa.Column("source", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("product_id", "period_date"),
    )

    op.create_table(
        "forecast_runs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("run_id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=True),
        sa.Column("model", sa.String(), nullable=False),
        sa.Column("periods_ahead", sa.Integer(), nullable=False),
        sa.Column("granularity", sa.String(), nullable=True),
        sa.Column("mape", sa.Float(), nullable=True),
        sa.Column("mae", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_id"),
    )

    op.create_table(
        "forecasts",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("product_id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.String(), nullable=False),
        sa.Column("model", sa.String(), nullable=False),
        sa.Column("period_date", sa.Date(), nullable=False),
        sa.Column("forecast_qty", sa.Float(), nullable=False),
        sa.Column("lower_bound", sa.Float(), nullable=True),
        sa.Column("upper_bound", sa.Float(), nullable=True),
        sa.Column("is_adjusted", sa.Boolean(), nullable=True),
        sa.Column("adjusted_qty", sa.Float(), nullable=True),
        sa.Column("adjusted_by", sa.String(), nullable=True),
        sa.Column("adjusted_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"]),
        sa.ForeignKeyConstraint(["run_id"], ["forecast_runs.run_id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("product_id", "period_date", "run_id"),
    )

    op.create_table(
        "forecast_adjust_log",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("forecast_id", sa.Integer(), nullable=False),
        sa.Column("product_id", sa.Integer(), nullable=False),
        sa.Column("period_date", sa.Date(), nullable=False),
        sa.Column("old_qty", sa.Float(), nullable=True),
        sa.Column("new_qty", sa.Float(), nullable=False),
        sa.Column("changed_by", sa.String(), nullable=True),
        sa.Column("changed_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.ForeignKeyConstraint(["forecast_id"], ["forecasts.id"]),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "inventory",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("product_id", sa.Integer(), nullable=False),
        sa.Column("quantity_on_hand", sa.Float(), nullable=False),
        sa.Column("quantity_on_order", sa.Float(), nullable=True),
        sa.Column("quantity_reserved", sa.Float(), nullable=True),
        sa.Column("avg_daily_demand", sa.Float(), nullable=True),
        sa.Column("demand_std_dev", sa.Float(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("product_id"),
    )

    op.create_table(
        "purchase_orders",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("po_number", sa.String(), nullable=True),
        sa.Column("product_id", sa.Integer(), nullable=False),
        sa.Column("supplier_id", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(), nullable=True),
        sa.Column("quantity", sa.Float(), nullable=False),
        sa.Column("unit_cost", sa.Float(), nullable=True),
        sa.Column("order_date", sa.Date(), nullable=True),
        sa.Column("due_date", sa.Date(), nullable=True),
        sa.Column("received_date", sa.Date(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("mrp_run_id", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"]),
        sa.ForeignKeyConstraint(["supplier_id"], ["suppliers.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("po_number"),
    )

    op.create_table(
        "production_orders",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("wo_number", sa.String(), nullable=True),
        sa.Column("product_id", sa.Integer(), nullable=False),
        sa.Column("work_center", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=True),
        sa.Column("quantity", sa.Float(), nullable=False),
        sa.Column("unit_cost", sa.Float(), nullable=True),
        sa.Column("order_date", sa.Date(), nullable=True),
        sa.Column("due_date", sa.Date(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("wo_number"),
    )

    op.create_table(
        "mrp_runs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("run_id", sa.String(), nullable=False),
        sa.Column("run_date", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.Column("horizon_weeks", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(), nullable=True),
        sa.Column("po_count", sa.Integer(), nullable=True),
        sa.Column("total_po_value", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_id"),
    )

    op.create_table(
        "changelog",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("entity_type", sa.String(), nullable=False),
        sa.Column("entity_id", sa.Integer(), nullable=False),
        sa.Column("entity_name", sa.String(), nullable=True),
        sa.Column("field", sa.String(), nullable=False),
        sa.Column("old_value", sa.Text(), nullable=True),
        sa.Column("new_value", sa.Text(), nullable=True),
        sa.Column("changed_by", sa.String(), nullable=True),
        sa.Column("changed_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "customer_demand",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("product_id", sa.Integer(), nullable=False),
        sa.Column("customer", sa.String(), nullable=False),
        sa.Column("period_date", sa.Date(), nullable=False),
        sa.Column("quantity", sa.Float(), nullable=False),
        sa.Column("revenue", sa.Float(), nullable=True),
        sa.Column("source", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("product_id", "customer", "period_date", "source"),
    )

    op.create_table(
        "bom_items",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("parent_product_id", sa.Integer(), nullable=False),
        sa.Column("child_product_id", sa.Integer(), nullable=False),
        sa.Column("quantity_per", sa.Float(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.ForeignKeyConstraint(["child_product_id"], ["products.id"]),
        sa.ForeignKeyConstraint(["parent_product_id"], ["products.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("parent_product_id", "child_product_id"),
    )

    op.create_table(
        "data_connectors",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("connector_type", sa.String(), nullable=False),
        sa.Column("target_entity", sa.String(), nullable=False),
        sa.Column("config", sa.Text(), nullable=True),
        sa.Column("status", sa.String(), nullable=True),
        sa.Column("last_sync", sa.DateTime(), nullable=True),
        sa.Column("last_sync_rows", sa.Integer(), nullable=True),
        sa.Column("error_msg", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("data_connectors")
    op.drop_table("bom_items")
    op.drop_table("customer_demand")
    op.drop_table("changelog")
    op.drop_table("mrp_runs")
    op.drop_table("production_orders")
    op.drop_table("purchase_orders")
    op.drop_table("inventory")
    op.drop_table("forecast_adjust_log")
    op.drop_table("forecasts")
    op.drop_table("forecast_runs")
    op.drop_table("sales_history")
    op.drop_table("products")
    op.drop_table("suppliers")
