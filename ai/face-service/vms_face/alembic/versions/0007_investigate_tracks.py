"""investigation search index (I-1): tracks, track_points, activity_buckets

One row per person / vehicle pass ("track"), not per frame. The summariser
(vms_face/investigate, next PR) writes a row when a track ends (plus a 30 s
heartbeat for long tracks), with its best crop in MinIO and its image
embedding in the Qdrant collection `vms_tracks` (point id = tracks.id).
Nothing writes these tables until INVESTIGATE_INDEX_ENABLED=true.

  * tracks            one row per pass: camera, time span, best crop, voted
                      attributes, links to the face/body vectors, IR flag,
                      and the model versions that produced it (forensic rule 16)
  * track_points      where the box was, 1 point/s, on a 0–1000 grid
                      (click-to-track and the journey map read this)
  * activity_buckets  per camera, per minute, per object class counts
                      (density bar and smart skim)

Plain tables with time indexes, no partitioning: the Postgres image has no
TimescaleDB, and the retention step deletes by `first_seen` per camera.
`vms_appearance` and the photo journey are untouched.

Revision ID: 0007_investigate_tracks
Revises: 0006_journey
Create Date: 2026-11-24
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID

revision: str = "0007_investigate_tracks"
down_revision: Union[str, None] = "0006_journey"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── tracks ──────────────────────────────────────────────────────────────
    op.create_table(
        "tracks",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("camera_id", UUID(as_uuid=True), sa.ForeignKey("cameras.id", ondelete="CASCADE"), nullable=False),
        # live | backfill | file
        sa.Column("source", sa.String(length=16), nullable=False, server_default="live"),
        # Set while a case holds this track: retention skips it. Cases live in
        # the backend (MySQL), so no foreign key.
        sa.Column("case_id", UUID(as_uuid=True), nullable=True),
        # The pipeline's own id ("t00000042"): per process, unique only with
        # camera + time, hence our own uuid primary key.
        sa.Column("tracker_id", sa.String(length=64), nullable=True),
        sa.Column("object_class", sa.String(length=32), nullable=False, server_default="person"),
        sa.Column("first_seen", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen", sa.DateTime(timezone=True), nullable=False),
        sa.Column("hits", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("best_crop_key", sa.Text(), nullable=True),
        sa.Column("best_crop_ts", sa.DateTime(timezone=True), nullable=True),
        # Voted per track: {"top_colour": {"value": "red", "conf": 0.82}, ...}
        sa.Column("attributes", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("zones", ARRAY(sa.Text()), nullable=True),
        # Links into the existing journey data (vms_appearance point, OSNet vector).
        sa.Column("appearance_id", UUID(as_uuid=True), nullable=True),
        sa.Column("body_vector_id", sa.String(length=64), nullable=True),
        sa.Column("person_id", UUID(as_uuid=True), sa.ForeignKey("persons.id", ondelete="SET NULL"), nullable=True),
        sa.Column("plate", sa.String(length=32), nullable=True),
        sa.Column("quality", sa.Float(), nullable=True),
        # Night / IR footage: colour attributes are not stored (rule 7).
        sa.Column("ir", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        # {"embedder": "siglip-base-patch16-224@<sha>", "detector": ..., "attributes": ...}
        sa.Column("model_info", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("tracks_tenant_idx", "tracks", ["tenant_id"])
    op.create_index("tracks_tenant_camera_time_idx", "tracks", ["tenant_id", "camera_id", "first_seen"])
    op.create_index("tracks_tenant_class_time_idx", "tracks", ["tenant_id", "object_class", "first_seen"])
    op.create_index("tracks_camera_time_idx", "tracks", ["camera_id", "first_seen"])   # retention
    op.create_index("tracks_case_idx", "tracks", ["case_id"], postgresql_where=sa.text("case_id IS NOT NULL"))
    op.create_index("tracks_person_idx", "tracks", ["person_id"], postgresql_where=sa.text("person_id IS NOT NULL"))
    op.execute("CREATE INDEX tracks_attributes_gin ON tracks USING gin (attributes jsonb_path_ops)")

    # ── track_points ────────────────────────────────────────────────────────
    op.create_table(
        "track_points",
        sa.Column("track_id", UUID(as_uuid=True), sa.ForeignKey("tracks.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("ts", sa.DateTime(timezone=True), primary_key=True),
        # x1, y1, x2, y2 on a 0–1000 grid of the frame (resolution independent)
        sa.Column("bbox", ARRAY(sa.SmallInteger()), nullable=False),
    )

    # ── activity_buckets ────────────────────────────────────────────────────
    op.create_table(
        "activity_buckets",
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("camera_id", UUID(as_uuid=True), sa.ForeignKey("cameras.id", ondelete="CASCADE"), nullable=False),
        sa.Column("minute", sa.DateTime(timezone=True), nullable=False),
        sa.Column("object_class", sa.String(length=32), nullable=False),
        sa.Column("count", sa.Integer(), nullable=False, server_default="0"),
        sa.PrimaryKeyConstraint("camera_id", "minute", "object_class", name="pk_activity_buckets"),
    )
    op.create_index("activity_buckets_tenant_idx", "activity_buckets", ["tenant_id"])
    op.create_index("activity_buckets_tenant_time_idx", "activity_buckets", ["tenant_id", "minute"])


def downgrade() -> None:
    op.drop_index("activity_buckets_tenant_time_idx", table_name="activity_buckets")
    op.drop_index("activity_buckets_tenant_idx", table_name="activity_buckets")
    op.drop_table("activity_buckets")
    op.drop_table("track_points")
    op.execute("DROP INDEX IF EXISTS tracks_attributes_gin")
    op.drop_index("tracks_person_idx", table_name="tracks")
    op.drop_index("tracks_case_idx", table_name="tracks")
    op.drop_index("tracks_camera_time_idx", table_name="tracks")
    op.drop_index("tracks_tenant_class_time_idx", table_name="tracks")
    op.drop_index("tracks_tenant_camera_time_idx", table_name="tracks")
    op.drop_index("tracks_tenant_idx", table_name="tracks")
    op.drop_table("tracks")
