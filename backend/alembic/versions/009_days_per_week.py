"""Add days_per_week to workstations

Revision ID: 009
Revises: 008
"""
from alembic import op

revision = '009'
down_revision = '008'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE workstations ADD COLUMN days_per_week INTEGER NOT NULL DEFAULT 5")
    # Recompute capacity with days_per_week (replaces the hardcoded 5.0 from migration 008)
    op.execute(
        "UPDATE workstations SET capacity_units_per_week = "
        "ROUND(hours_per_day * 60.0 * cycle_rate_units_per_min * days_per_week, 0)"
    )
    op.execute("UPDATE workstations SET capacity_per_shift = capacity_units_per_week")


def downgrade() -> None:
    pass
