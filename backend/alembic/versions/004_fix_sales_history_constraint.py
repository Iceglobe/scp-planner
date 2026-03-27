"""drop stale unique(product_id, period_date) constraint from sales_history

Revision ID: 004
Revises: 003
Create Date: 2026-03-26

"""
from alembic import op

revision = "004"
down_revision = "003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # SQLite doesn't support DROP CONSTRAINT, so we recreate the table
    # keeping only the correct 3-column unique constraint (product_id, period_date, customer).
    # Migration 003 left behind the old unnamed UNIQUE(product_id, period_date) which
    # prevents importing sales data with multiple customers per SKU/period.
    op.execute("""
        CREATE TABLE sales_history_new (
            id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            period_date DATE NOT NULL,
            quantity FLOAT NOT NULL,
            revenue FLOAT,
            source VARCHAR,
            created_at DATETIME DEFAULT (CURRENT_TIMESTAMP),
            customer VARCHAR,
            PRIMARY KEY (id),
            CONSTRAINT uq_sales_history_product_period_customer UNIQUE (product_id, period_date, customer),
            FOREIGN KEY(product_id) REFERENCES products (id)
        )
    """)
    op.execute("""
        INSERT INTO sales_history_new (id, product_id, period_date, quantity, revenue, source, created_at, customer)
        SELECT id, product_id, period_date, quantity, revenue, source, created_at, customer
        FROM sales_history
    """)
    op.execute("DROP TABLE sales_history")
    op.execute("ALTER TABLE sales_history_new RENAME TO sales_history")


def downgrade() -> None:
    # Restore the old dual-constraint table (reverses the fix)
    op.execute("""
        CREATE TABLE sales_history_new (
            id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            period_date DATE NOT NULL,
            quantity FLOAT NOT NULL,
            revenue FLOAT,
            source VARCHAR,
            created_at DATETIME DEFAULT (CURRENT_TIMESTAMP),
            customer VARCHAR,
            PRIMARY KEY (id),
            CONSTRAINT uq_sales_history_product_period_customer UNIQUE (product_id, period_date, customer),
            UNIQUE (product_id, period_date),
            FOREIGN KEY(product_id) REFERENCES products (id)
        )
    """)
    op.execute("""
        INSERT INTO sales_history_new (id, product_id, period_date, quantity, revenue, source, created_at, customer)
        SELECT id, product_id, period_date, quantity, revenue, source, created_at, customer
        FROM sales_history
    """)
    op.execute("DROP TABLE sales_history")
    op.execute("ALTER TABLE sales_history_new RENAME TO sales_history")
