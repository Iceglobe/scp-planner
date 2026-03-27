"""Add workstations table and workstation_id to products

Revision ID: 006
Revises: 005
Create Date: 2026-03-27

"""
from alembic import op

revision = "006"
down_revision = "005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE workstations (
            id INTEGER NOT NULL,
            name VARCHAR NOT NULL UNIQUE,
            capacity_units_per_week FLOAT NOT NULL DEFAULT 0.0,
            cycle_time_minutes FLOAT NOT NULL DEFAULT 0.0,
            department VARCHAR,
            notes TEXT,
            created_at DATETIME DEFAULT (CURRENT_TIMESTAMP),
            PRIMARY KEY (id)
        )
    """)
    op.execute("ALTER TABLE products ADD COLUMN workstation_id INTEGER")


def downgrade() -> None:
    pass
