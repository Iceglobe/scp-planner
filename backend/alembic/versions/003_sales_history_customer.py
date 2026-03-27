"""add customer column to sales_history

Revision ID: 003
Revises: 002
Create Date: 2026-03-26

"""
from alembic import op
import sqlalchemy as sa

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # SQLite requires batch mode to modify constraints (recreates the table)
    with op.batch_alter_table("sales_history", recreate="always") as batch_op:
        batch_op.add_column(sa.Column("customer", sa.String(), nullable=True))
        batch_op.create_unique_constraint(
            "uq_sales_history_product_period_customer",
            ["product_id", "period_date", "customer"],
        )


def downgrade() -> None:
    with op.batch_alter_table("sales_history", recreate="always") as batch_op:
        batch_op.drop_column("customer")
