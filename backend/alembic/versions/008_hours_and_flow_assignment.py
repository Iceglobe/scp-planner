"""Add hours_per_day and cycle_rate to workstations; production_flow_id to products

Revision ID: 008
Revises: 007
"""
from alembic import op

revision = '008'
down_revision = '007'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Workstations: hours operational per day + cycle rate (units/min)
    op.execute("ALTER TABLE workstations ADD COLUMN hours_per_day FLOAT NOT NULL DEFAULT 8.0")
    op.execute("ALTER TABLE workstations ADD COLUMN cycle_rate_units_per_min FLOAT NOT NULL DEFAULT 0.0")
    # Seed hours_per_day = 8; convert cycle_time_minutes (min/unit) → cycle_rate (units/min)
    op.execute("UPDATE workstations SET hours_per_day = 8.0")
    op.execute(
        "UPDATE workstations SET cycle_rate_units_per_min = "
        "CASE WHEN cycle_time_minutes > 0 THEN ROUND(1.0 / cycle_time_minutes, 4) ELSE 0.0 END"
    )
    # Recompute capacity: hours/day × 60 min/hr × rate units/min × 5 days/week
    op.execute(
        "UPDATE workstations SET capacity_units_per_week = "
        "ROUND(hours_per_day * 60.0 * cycle_rate_units_per_min * 5.0, 0)"
    )
    op.execute("UPDATE workstations SET capacity_per_shift = capacity_units_per_week")

    # Products: assign to a production flow (replaces per-product workstation assignment for VSM)
    op.execute("ALTER TABLE products ADD COLUMN production_flow_id INTEGER")


def downgrade() -> None:
    pass
