"""investigation phase 4: speech_segments (Audio Search)

What was said, as text, per camera (or imported video) and time: one row per
transcribed chunk with speech. Searched by words ('simple' text search, which
splits any script, Devanagari included, on spaces and punctuation).

Only filled when someone asks to transcribe a file or a time range, on an
account with Audio Search switched on. Retention: camera rows go with the
index retention; imported-video rows go with their import.

Revision ID: 0009_investigate_speech
Revises: 0008_investigate_reviews
Create Date: 2026-11-24
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0009_investigate_speech"
down_revision: Union[str, None] = "0008_investigate_reviews"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "speech_segments",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("camera_id", UUID(as_uuid=True), sa.ForeignKey("cameras.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False, server_default="recording"),   # recording | file
        sa.Column("start_ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("end_ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("lang", sa.String(length=8), nullable=True),
        sa.Column("model_info", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("speech_segments_tenant_idx", "speech_segments", ["tenant_id"])
    op.create_index("speech_segments_camera_time_idx", "speech_segments", ["camera_id", "start_ts"])
    op.execute("CREATE INDEX speech_segments_text_idx ON speech_segments USING gin (to_tsvector('simple', text))")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS speech_segments_text_idx")
    op.drop_index("speech_segments_camera_time_idx", table_name="speech_segments")
    op.drop_index("speech_segments_tenant_idx", table_name="speech_segments")
    op.drop_table("speech_segments")
