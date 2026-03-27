"""Add production flows and workstation shifts

Revision ID: 007
Revises: 006
"""
from alembic import op

revision = '007'
down_revision = '006'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add shift columns to workstations
    op.execute("ALTER TABLE workstations ADD COLUMN capacity_per_shift FLOAT NOT NULL DEFAULT 0.0")
    op.execute("ALTER TABLE workstations ADD COLUMN num_shifts INTEGER NOT NULL DEFAULT 1")
    # Seed: existing capacity is treated as 1-shift capacity
    op.execute("UPDATE workstations SET capacity_per_shift = capacity_units_per_week, num_shifts = 1")

    # Production flows table
    op.execute("""
        CREATE TABLE IF NOT EXISTS production_flows (
            id INTEGER NOT NULL,
            name VARCHAR NOT NULL,
            workstation_ids TEXT NOT NULL DEFAULT '[]',
            created_at DATETIME DEFAULT (CURRENT_TIMESTAMP),
            PRIMARY KEY (id)
        )
    """)


def downgrade() -> None:
    pass
