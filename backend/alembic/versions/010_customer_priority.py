"""Add customer_priority table

Revision ID: 010
Revises: 009
"""
from alembic import op
import sqlalchemy as sa

revision = '010'
down_revision = '009'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "customer_priority",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("customer", sa.String(), nullable=False),
        sa.Column("product_id", sa.Integer(), sa.ForeignKey("products.id"), nullable=False),
        sa.UniqueConstraint("customer", "product_id", name="uq_customer_priority"),
    )


def downgrade() -> None:
    op.drop_table("customer_priority")
