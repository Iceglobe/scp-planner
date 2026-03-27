"""add note to forecast adjustments

Revision ID: 002
Revises: 001
Create Date: 2026-03-25

"""
from alembic import op
import sqlalchemy as sa

revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("forecasts", sa.Column("adjusted_note", sa.String(), nullable=True))
    op.add_column("forecast_adjust_log", sa.Column("note", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("forecasts", "adjusted_note")
    op.drop_column("forecast_adjust_log", "note")
