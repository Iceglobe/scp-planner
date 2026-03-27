"""Add is_adjusted/note to customer_demand; add customer to forecast_adjust_log

Revision ID: 005
Revises: 004
Create Date: 2026-03-26

"""
from alembic import op

revision = "005"
down_revision = "004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # customer_demand: add is_adjusted and note columns
    op.execute("ALTER TABLE customer_demand ADD COLUMN is_adjusted BOOLEAN DEFAULT 0")
    op.execute("ALTER TABLE customer_demand ADD COLUMN note VARCHAR")

    # forecast_adjust_log: add customer column (nullable)
    op.execute("ALTER TABLE forecast_adjust_log ADD COLUMN customer VARCHAR")

    # forecast_adjust_log: make forecast_id nullable (customer adjustments don't have a forecast row id)
    # SQLite doesn't support ALTER COLUMN, so we recreate the table
    op.execute("""
        CREATE TABLE forecast_adjust_log_new (
            id INTEGER NOT NULL,
            forecast_id INTEGER,
            product_id INTEGER NOT NULL,
            period_date DATE NOT NULL,
            old_qty FLOAT,
            new_qty FLOAT NOT NULL,
            changed_by VARCHAR,
            note VARCHAR,
            customer VARCHAR,
            changed_at DATETIME DEFAULT (CURRENT_TIMESTAMP),
            PRIMARY KEY (id),
            FOREIGN KEY(product_id) REFERENCES products (id)
        )
    """)
    op.execute("""
        INSERT INTO forecast_adjust_log_new (id, forecast_id, product_id, period_date, old_qty, new_qty, changed_by, note, customer, changed_at)
        SELECT id, forecast_id, product_id, period_date, old_qty, new_qty, changed_by, note, customer, changed_at
        FROM forecast_adjust_log
    """)
    op.execute("DROP TABLE forecast_adjust_log")
    op.execute("ALTER TABLE forecast_adjust_log_new RENAME TO forecast_adjust_log")


def downgrade() -> None:
    pass
