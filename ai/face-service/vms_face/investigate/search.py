"""Smart Search over the I-1 index (``vms_tracks``).

query (text or photo) → vector → Qdrant search under hard filters (tenant,
cameras, time, object class) → re-rank with the soft colour chips → results.

The score shown to the user is SigLIP's calibrated sigmoid probability for a
text query (how likely the description fits the photo) or the cosine
similarity for a photo query, nudged by the colour chips; it is a lead, not an
identification (rule 15).
"""
from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence

from qdrant_client.http.models import Filter

from vms_face.investigate import index_schema as ix

COLOUR_MATCH_BONUS = 0.10
# Text → photo relevance shown to people, 0..1, from SigLIP 2 cosine. Measured
# on real person crops (2026-11-24): unrelated ≈ 0.05, clear match ≈ 0.12–0.16.
# SigLIP's own sigmoid probability is near 0 for short descriptions, so it is
# returned (`probability`) but not shown. Retune on lab data.
TEXT_COS_FLOOR = 0.05
TEXT_COS_GOOD = 0.16


def text_relevance(cosine: float) -> float:
    return max(0.0, min(1.0, (cosine - TEXT_COS_FLOOR) / (TEXT_COS_GOOD - TEXT_COS_FLOOR)))
COLOUR_MISMATCH_PENALTY = 0.05
OVERFETCH = 3          # candidates fetched per result shown, for re-ranking


@dataclass
class SearchFilters:
    camera_ids: list[str] = field(default_factory=list)      # AI camera uuids
    object_classes: list[str] = field(default_factory=list)
    since: dt.datetime | None = None
    until: dt.datetime | None = None
    top_colour: str | None = None                             # soft
    bottom_colour: str | None = None                          # soft
    vehicle_type: str | None = None                           # soft
    vehicle_colour: str | None = None                         # soft


def build_filter(tenant_id: uuid.UUID, f: SearchFilters) -> Filter:
    return ix.track_filter(tenant_id, camera_ids=f.camera_ids or None, object_classes=f.object_classes or None,
                           since=f.since, until=f.until)


def assert_tenant_scoped(flt: Filter, tenant_id: uuid.UUID) -> None:
    """Refuse a vms_tracks query whose filter isn't pinned to this tenant."""
    for c in flt.must or []:
        if getattr(c, "key", None) == "tenant_id" and getattr(getattr(c, "match", None), "value", None) == str(tenant_id):
            return
    raise ValueError("vms_tracks query without the caller's tenant filter")


async def query_tracks(client: Any, collection: str, *, tenant_id: uuid.UUID, vector: Sequence[float],
                       filters: SearchFilters, limit: int) -> list[dict]:
    flt = build_filter(tenant_id, filters)
    assert_tenant_scoped(flt, tenant_id)
    resp = await client.query_points(collection_name=collection, query=list(map(float, vector)), query_filter=flt,
                                     limit=limit, with_payload=True)
    return [{"id": str(p.id), "cosine": float(p.score), "payload": dict(p.payload or {})}
            for p in getattr(resp, "points", resp)]


def rerank(hits: list[dict], filters: SearchFilters, *, to_score: Callable[[float], float], top_k: int) -> list[dict]:
    out = []
    for h in hits:
        pl = h["payload"]
        score = to_score(h["cosine"])
        boosts = []
        for chip, key in ((filters.top_colour, "attr_top_colour"), (filters.bottom_colour, "attr_bottom_colour"),
                          (filters.vehicle_colour, "attr_vehicle_colour"), (filters.vehicle_type, "attr_vehicle_type")):
            if not chip or (pl.get("ir") and key != "attr_vehicle_type"):
                continue
            seen = pl.get(key)
            if seen == chip:
                score += COLOUR_MATCH_BONUS
                boosts.append(f"{key[5:]}={chip}")
            elif seen:
                score -= COLOUR_MISMATCH_PENALTY
        out.append({**h, "score": round(max(0.0, min(1.0, score)), 4), "boosts": boosts})
    out.sort(key=lambda r: r["score"], reverse=True)
    return out[:top_k]


def result_row(hit: dict, *, camera_codes: dict[str, str]) -> dict:
    pl = hit["payload"]
    attrs = {k[5:]: v for k, v in pl.items() if k.startswith("attr_")}
    first = dt.datetime.fromtimestamp(pl["first_seen_ts"], dt.timezone.utc)
    last = dt.datetime.fromtimestamp(pl.get("last_seen_ts", pl["first_seen_ts"]), dt.timezone.utc)
    return {
        "track_id": hit["id"],
        "camera_id": pl.get("camera_id"),
        "camera_code": camera_codes.get(pl.get("camera_id", ""), None),
        "object_class": pl.get("object_class"),
        "first_seen": first.isoformat(),
        "last_seen": last.isoformat(),
        "score": hit["score"],
        "cosine": round(hit["cosine"], 4),
        "matched": hit.get("boosts", []),
        "attributes": attrs,
        "ir": bool(pl.get("ir")),
        "person_id": pl.get("person_id"),
        "crop_path": f"/investigate/tracks/{hit['id']}/crop",
    }
