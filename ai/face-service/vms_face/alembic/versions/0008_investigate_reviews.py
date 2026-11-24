"""investigation: who confirmed or rejected a journey sighting (I-3)

Click to track proposes "the same person on other cameras" from the image
fingerprint. Those are leads, not identifications (forensic rule 15): a person
confirms or rejects each one, and that decision — who, when, about which pair
of tracks — is stored here. Confirmed sightings form the journey; rejected
ones never come back for that seed.

Revision ID: 0008_investigate_reviews
Revises: 0007_investigate_tracks
Create Date: 2026-11-24
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0008_investigate_reviews"
down_revision: Union[str, None] = "0007_investigate_tracks"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "track_reviews",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("seed_track_id", UUID(as_uuid=True), sa.ForeignKey("tracks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("track_id", UUID(as_uuid=True), sa.ForeignKey("tracks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("verdict", sa.String(length=16), nullable=False),          # confirmed | rejected
        sa.Column("score", sa.Float(), nullable=True),                       # what the system proposed it at
        sa.Column("actor", sa.String(length=128), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("tenant_id", "seed_track_id", "track_id", name="uq_track_review"),
    )
    op.create_index("track_reviews_tenant_idx", "track_reviews", ["tenant_id"])
    op.create_index("track_reviews_seed_idx", "track_reviews", ["seed_track_id"])


def downgrade() -> None:
    op.drop_index("track_reviews_seed_idx", table_name="track_reviews")
    op.drop_index("track_reviews_tenant_idx", table_name="track_reviews")
    op.drop_table("track_reviews")
