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

import numpy as np
from qdrant_client.http.models import (
    FieldCondition, Filter, IsEmptyCondition, MatchValue, OrderBy, PayloadField,
)

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
    # Asked-for colours and vehicle type are FILTERS: someone whose top was read
    # as blue never answers "red top". Tracks whose colour couldn't be read
    # (night/IR, unclear) are left out unless include_unknown_colour.
    top_colour: str | None = None
    bottom_colour: str | None = None
    vehicle_type: str | None = None
    vehicle_colour: str | None = None
    include_unknown_colour: bool = False
    # "male" / "female": applied only when the account allows the man/woman
    # filter (sensitive attribute, rule 8); see gender_filter.
    gender: str | None = None

    def attribute_chips(self) -> dict[str, str]:
        return {k: v for k, v in (("top_colour", self.top_colour), ("bottom_colour", self.bottom_colour),
                                  ("vehicle_type", self.vehicle_type), ("vehicle_colour", self.vehicle_colour)) if v}


def build_filter(tenant_id: uuid.UUID, f: SearchFilters, *, unknown_colour: bool | None = None) -> Filter:
    """Hard filters. Each asked-for attribute must match; with ``unknown_colour``
    an attribute that was never read (missing) is accepted too."""
    flt = ix.track_filter(tenant_id, camera_ids=f.camera_ids or None, object_classes=f.object_classes or None,
                          since=f.since, until=f.until)
    lenient = f.include_unknown_colour if unknown_colour is None else unknown_colour
    for name, value in f.attribute_chips().items():
        key = f"attr_{name}"
        exact = FieldCondition(key=key, match=MatchValue(value=value.lower()))
        if lenient:
            flt.must.append(Filter(should=[exact, IsEmptyCondition(is_empty=PayloadField(key=key))]))
        else:
            flt.must.append(exact)
    return flt


def assert_tenant_scoped(flt: Filter, tenant_id: uuid.UUID) -> None:
    """Refuse a vms_tracks query whose filter isn't pinned to this tenant."""
    for c in flt.must or []:
        if getattr(c, "key", None) == "tenant_id" and getattr(getattr(c, "match", None), "value", None) == str(tenant_id):
            return
    raise ValueError("vms_tracks query without the caller's tenant filter")


async def query_tracks(client: Any, collection: str, *, tenant_id: uuid.UUID, vector: Sequence[float],
                       filters: SearchFilters, limit: int, with_vectors: bool = False) -> list[dict]:
    flt = build_filter(tenant_id, filters)
    assert_tenant_scoped(flt, tenant_id)
    resp = await client.query_points(collection_name=collection, query=list(map(float, vector)), query_filter=flt,
                                     limit=limit, with_payload=True, with_vectors=with_vectors)
    return [{"id": str(p.id), "cosine": float(p.score), "payload": dict(p.payload or {}),
             **({"vector": p.vector} if with_vectors else {})}
            for p in getattr(resp, "points", resp)]


async def browse_tracks(client: Any, collection: str, *, tenant_id: uuid.UUID, filters: SearchFilters,
                        limit: int, with_vectors: bool = False) -> list[dict]:
    """Everyone matching the filters, newest first: for searches that describe
    no one ("movement at gate 2"). No similarity, so no score."""
    flt = build_filter(tenant_id, filters)
    assert_tenant_scoped(flt, tenant_id)
    points, _ = await client.scroll(collection_name=collection, scroll_filter=flt, limit=limit, with_payload=True,
                                    with_vectors=with_vectors, order_by=OrderBy(key="first_seen_ts", direction="desc"))
    return [{"id": str(p.id), "cosine": None, "payload": dict(p.payload or {}),
             **({"vector": p.vector} if with_vectors else {})} for p in points]


async def count_unknown_colour(client: Any, collection: str, *, tenant_id: uuid.UUID, filters: SearchFilters) -> int:
    """How many tracks a colour/type filter left out only because theirs was
    never read (night, unclear): the page offers to show them."""
    if not filters.attribute_chips() or filters.include_unknown_colour:
        return 0
    lenient, strict = build_filter(tenant_id, filters, unknown_colour=True), build_filter(tenant_id, filters, unknown_colour=False)
    assert_tenant_scoped(lenient, tenant_id)
    assert_tenant_scoped(strict, tenant_id)
    a = await client.count(collection_name=collection, count_filter=lenient, exact=True)
    b = await client.count(collection_name=collection, count_filter=strict, exact=True)
    return max(0, int(a.count) - int(b.count))


# How much a description fits a picture BEYOND it being a person (or vehicle):
# cos(picture, description) − cos(picture, "a photo of a person"). Measured on
# lab tracks (2026-11-25): real matches +0.01 … +0.05, "a dog" all below 0,
# "yellow raincoat" (none present) ≤ +0.007. Unlike the raw cosine, it doesn't
# shift between cameras and sites (the testing server showed every raw score as
# 100%), because each picture is compared with itself.
MATCH_STRONG = 0.015
MATCH_GOOD = 0.005
BASELINE_TEXT = {"vehicle": "a photo of a vehicle"}


def baseline_text(object_class: str | None) -> str:
    return BASELINE_TEXT.get(object_class or "", "a photo of a person")


def match_label(margin: float | None) -> str | None:
    if margin is None:
        return None
    return "strong" if margin >= MATCH_STRONG else "good" if margin >= MATCH_GOOD else "possible"


def apply_margins(hits: list[dict], base_vector: Sequence[float], *, keep_below_zero: bool) -> list[dict]:
    """Add each hit's margin over the baseline, best first. Without filters that
    already vouch for a hit (a colour, man/woman), a hit the description doesn't
    fit any better than "a person" (margin < 0) is unrelated and dropped."""
    base = np.asarray(base_vector, dtype=np.float32)
    out = []
    for h in hits:
        if h.get("vector") is None or h.get("cosine") is None:
            out.append(h)
            continue
        margin = float(h["cosine"]) - float(np.asarray(h["vector"], dtype=np.float32) @ base)
        if margin < 0 and not keep_below_zero:
            continue
        out.append({**h, "margin": round(margin, 4)})
    out.sort(key=lambda h: h.get("margin", -1.0), reverse=True)
    return out


# Man/woman from the track's own picture vector, at query time: nothing about
# gender is stored. Only confident readings count; measured on lab crops
# (2026-11-25), the unclear ones (seen from above, no face) sit at 0.3–0.7.
GENDER_PROMPTS = ("a photo of a man", "a photo of a woman")
GENDER_SURE = 0.8


def gender_filter(hits: list[dict], gender: str, text_vectors: np.ndarray, scale: float) -> tuple[list[dict], int]:
    """Keep the hits confidently of ``gender``; return (kept, how many were unsure)."""
    if not hits:
        return [], 0
    vecs = np.asarray([h["vector"] for h in hits], dtype=np.float32)
    logits = (vecs @ np.asarray(text_vectors, dtype=np.float32).T) * scale
    p_man = 1.0 / (1.0 + np.exp(-(logits[:, 0] - logits[:, 1])))
    kept, unsure = [], 0
    for h, pm in zip(hits, p_man):
        p = float(pm) if gender == "male" else 1.0 - float(pm)
        if p >= GENDER_SURE:
            kept.append({**h, "gender_p": round(p, 3)})
        elif p > 1.0 - GENDER_SURE:
            unsure += 1
    return kept, unsure


def rerank(hits: list[dict], filters: SearchFilters, *, to_score: Callable[[float], float], top_k: int,
           min_score: float = 0.0) -> list[dict]:
    """Score, nudge by matching chips, drop what scores ``min_score`` or less
    (unrelated), best first. Browse hits (no cosine) keep their order, unscored."""
    if hits and all(h.get("cosine") is None for h in hits):
        return [{**h, "score": None, "boosts": []} for h in hits[:top_k]]
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
        if to_score(h["cosine"]) <= min_score:
            continue                       # unrelated to the description, whatever the chips say
        out.append({**h, "score": round(max(0.0, min(1.0, score)), 4), "boosts": boosts})
    if any("margin" in r for r in out):
        out.sort(key=lambda r: r.get("margin", -1.0), reverse=True)     # set by apply_margins: keep its order
    else:
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
        "match": match_label(hit.get("margin")),          # strong | good | possible | None (no description)
        "cosine": round(hit["cosine"], 4) if hit.get("cosine") is not None else None,
        "matched": hit.get("boosts", []),
        "attributes": attrs,
        "ir": bool(pl.get("ir")),
        "person_id": pl.get("person_id"),
        "crop_path": f"/investigate/tracks/{hit['id']}/crop",
    }
