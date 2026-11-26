"""Shapes shared by everything that writes or reads the I-1 search index.

One person / vehicle pass ("track") is stored three ways, all keyed by the
same uuid:

  * Postgres ``tracks`` row (+ ``track_points``, ``activity_buckets``),
    migration ``0007_investigate_tracks``;
  * Qdrant ``vms_tracks`` point: image embedding + the payload built by
    :func:`track_payload`;
  * MinIO crop at :func:`crop_key`.

Rules enforced here, so the writer (summariser) and the readers
(``/investigate/*``) can't drift apart:

  * every search filter carries ``tenant_id`` (:func:`track_filter` refuses
    to build one without it) — rule 2;
  * night / IR tracks carry no colour attributes — rule 7;
  * sensitive attributes (gender, age) are dropped unless the tenant opted
    in — rule 8; there is no emotion or "suspicious" attribute at all.

Pure Python (no DB, no network): unit-tested in tests/test_investigate_index_schema.py.
"""
from __future__ import annotations

import datetime as dt
import uuid
from typing import Any, Iterable, Mapping

from qdrant_client.http.models import FieldCondition, Filter, MatchAny, MatchValue, PayloadSchemaType, Range

OBJECT_CLASSES = frozenset({"person", "vehicle", "car", "motorcycle", "bus", "truck", "bicycle", "auto_rickshaw"})
SOURCES = frozenset({"live", "backfill", "file"})

COLOUR_ATTRIBUTES = frozenset({"top_colour", "bottom_colour", "vehicle_colour"})
SENSITIVE_ATTRIBUTES = frozenset({"gender", "age_band"})
ATTRIBUTES = COLOUR_ATTRIBUTES | SENSITIVE_ATTRIBUTES | frozenset({
    "top_type", "bottom_type", "bag", "headwear", "vehicle_type",
})

# A voted attribute below this confidence stays in Postgres for review but is
# not put in the Qdrant payload, so a filter never hard-excludes on a guess.
PAYLOAD_MIN_CONF = 0.5

GRID = 1000  # track_points boxes are stored on a 0..GRID grid of the frame

TRACKS_PAYLOAD_INDEXES: tuple[tuple[str, PayloadSchemaType], ...] = (
    ("tenant_id", PayloadSchemaType.KEYWORD),
    ("camera_id", PayloadSchemaType.KEYWORD),
    ("site_id", PayloadSchemaType.KEYWORD),
    ("object_class", PayloadSchemaType.KEYWORD),
    ("source", PayloadSchemaType.KEYWORD),
    ("case_id", PayloadSchemaType.KEYWORD),
    ("first_seen_ts", PayloadSchemaType.INTEGER),
    ("ir", PayloadSchemaType.BOOL),
    *((f"attr_{name}", PayloadSchemaType.KEYWORD) for name in sorted(ATTRIBUTES)),
)


def _utc(ts: dt.datetime) -> dt.datetime:
    if ts.tzinfo is None:
        raise ValueError("timestamps must be timezone-aware")
    return ts.astimezone(dt.timezone.utc)


def crop_key(tenant_id: uuid.UUID | str, track_id: uuid.UUID | str, first_seen: dt.datetime) -> str:
    """MinIO key of a track's best crop: ``<tenant>/tracks/<UTC date>/<track>.jpg``."""
    return f"{tenant_id}/tracks/{_utc(first_seen):%Y-%m-%d}/{track_id}.jpg"


def bbox_to_grid(bbox: Iterable[float], frame_w: int, frame_h: int) -> list[int]:
    """(x1, y1, x2, y2) in pixels → ints on a 0..1000 grid, clamped to the frame."""
    if frame_w <= 0 or frame_h <= 0:
        raise ValueError("frame size must be positive")
    x1, y1, x2, y2 = list(bbox)[:4]
    out = []
    for v, size in ((x1, frame_w), (y1, frame_h), (x2, frame_w), (y2, frame_h)):
        out.append(int(round(min(max(v / size, 0.0), 1.0) * GRID)))
    return out


def minute_floor(ts: dt.datetime) -> dt.datetime:
    """The ``activity_buckets.minute`` a timestamp falls in (UTC, seconds zeroed)."""
    return _utc(ts).replace(second=0, microsecond=0)


def clean_attributes(
    attributes: Mapping[str, Any] | None,
    *,
    ir: bool,
    allow_sensitive: bool = False,
) -> dict[str, dict[str, Any]]:
    """Keep only known attributes shaped ``{"value": str, "conf": float}``.

    Drops colour attributes on IR tracks and sensitive ones unless allowed.
    """
    out: dict[str, dict[str, Any]] = {}
    for name, vote in (attributes or {}).items():
        if name not in ATTRIBUTES:
            continue
        if ir and name in COLOUR_ATTRIBUTES:
            continue
        if name in SENSITIVE_ATTRIBUTES and not allow_sensitive:
            continue
        if not isinstance(vote, Mapping) or not vote.get("value"):
            continue
        try:
            conf = float(vote.get("conf", 0.0))
        except (TypeError, ValueError):
            continue
        out[name] = {"value": str(vote["value"]).lower(), "conf": round(min(max(conf, 0.0), 1.0), 3)}
    return out


def track_payload(
    *,
    tenant_id: uuid.UUID | str,
    camera_id: uuid.UUID | str,
    object_class: str,
    first_seen: dt.datetime,
    last_seen: dt.datetime,
    source: str = "live",
    attributes: Mapping[str, Any] | None = None,
    ir: bool = False,
    allow_sensitive: bool = False,
    site_id: str | None = None,
    case_id: uuid.UUID | str | None = None,
) -> dict[str, Any]:
    """Qdrant payload for one track. Attributes become ``attr_<name>`` keys."""
    if not tenant_id:
        raise ValueError("tenant_id is required")
    if object_class not in OBJECT_CLASSES:
        raise ValueError(f"unknown object_class {object_class!r}")
    if source not in SOURCES:
        raise ValueError(f"unknown source {source!r}")
    payload: dict[str, Any] = {
        "tenant_id": str(tenant_id),
        "camera_id": str(camera_id),
        "object_class": object_class,
        "source": source,
        "first_seen_ts": int(_utc(first_seen).timestamp()),
        "last_seen_ts": int(_utc(last_seen).timestamp()),
        "ir": bool(ir),
    }
    if site_id:
        payload["site_id"] = str(site_id)
    if case_id:
        payload["case_id"] = str(case_id)
    for name, vote in clean_attributes(attributes, ir=ir, allow_sensitive=allow_sensitive).items():
        if vote["conf"] >= PAYLOAD_MIN_CONF:
            payload[f"attr_{name}"] = vote["value"]
    return payload


def track_filter(
    tenant_id: uuid.UUID | str,
    *,
    camera_ids: Iterable[uuid.UUID | str] | None = None,
    object_classes: Iterable[str] | None = None,
    since: dt.datetime | None = None,
    until: dt.datetime | None = None,
    sources: Iterable[str] | None = None,
    attributes: Mapping[str, str | Iterable[str]] | None = None,
) -> Filter:
    """Qdrant filter for a ``vms_tracks`` search. Always scoped to one tenant."""
    if not tenant_id:
        raise ValueError("tenant_id is required for every track search")
    must: list[FieldCondition] = [FieldCondition(key="tenant_id", match=MatchValue(value=str(tenant_id)))]
    cams = [str(c) for c in camera_ids or []]
    if cams:
        must.append(FieldCondition(key="camera_id", match=MatchAny(any=cams)))
    classes = list(object_classes or [])
    if classes:
        unknown = set(classes) - OBJECT_CLASSES
        if unknown:
            raise ValueError(f"unknown object_class {sorted(unknown)}")
        must.append(FieldCondition(key="object_class", match=MatchAny(any=classes)))
    srcs = list(sources or [])
    if srcs:
        must.append(FieldCondition(key="source", match=MatchAny(any=srcs)))
    if since is not None or until is not None:
        # A track overlaps [since, until] when it starts before `until`;
        # `since` is matched on first_seen too (tracks are short, ≤ minutes).
        must.append(FieldCondition(key="first_seen_ts", range=Range(
            gte=int(_utc(since).timestamp()) if since is not None else None,
            lte=int(_utc(until).timestamp()) if until is not None else None,
        )))
    for name, value in (attributes or {}).items():
        if name not in ATTRIBUTES:
            raise ValueError(f"unknown attribute {name!r}")
        values = [value] if isinstance(value, str) else list(value)
        if values:
            must.append(FieldCondition(key=f"attr_{name}", match=MatchAny(any=[v.lower() for v in values])))
    return Filter(must=must)
