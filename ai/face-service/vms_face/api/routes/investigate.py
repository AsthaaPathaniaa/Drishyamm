"""Investigation toolkit API: Smart Search over the I-1 track index.

    POST /investigate/search          text query (English / Hindi) + optional chip overrides
    POST /investigate/track-at        click on video (camera, time, x, y) → the person there
    POST /investigate/journey         one track → the same person on other cameras (leads)
    POST /investigate/journey/review  confirm / reject a proposed sighting (who, when)
    POST /investigate/tracks/{id}/hold  a case holds the track (retention skips it) or releases it
    GET  /investigate/activity        Smart Skim: people per bin + busy stretches on one camera
    GET  /investigate/tracks/{id}/companions  who was with this person (here and on their confirmed journey)
    POST /investigate/synopsis        a reel of one camera's busy stretches, sped up; GET …/{id}, …/{id}/video
    POST /investigate/speech/transcribe   transcribe an imported video or a recorded range (Audio Search)
    GET  /investigate/speech          search what was said
    POST /investigate/imports         index an uploaded video file (I-7); GET/DELETE /investigate/imports/{id}
    POST /investigate/search/photo    a photo instead of words (same filters)
    GET  /investigate/tracks/{id}     one track: camera, times, attributes, 1 pt/s path
    GET  /investigate/tracks/{id}/crop  the track's best photo (JPEG)
    GET  /investigate/status          is the index on, is the model loaded, how many tracks

Tenant comes only from the JWT (``current_tenant_id``); another tenant's
track is a 404. Every search is audited with its query, filters and result
count (rule 3). 404 for everything while ``INVESTIGATE_INDEX_ENABLED`` is off.
The backend proxies these under /api/investigate with its own feature gate.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import uuid
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from vms_face.api.deps import current_tenant_id, db_session, operator_id
from vms_face.config import settings
from vms_face.core.executors import get_gpu_pool
from vms_face.core.logging import get_logger
from vms_face.domain.models import Camera, SpeechSegment, Track, TrackPoint, TrackReview
from vms_face.infra.minio_store import get_object_store
from vms_face.infra.qdrant import get_qdrant_tracks
from vms_face.investigate import activity as act
from vms_face.investigate import associations as assoc
from vms_face.investigate import journey as jny
from vms_face.investigate import query_parser
from vms_face.investigate.search import SearchFilters, query_tracks, rerank, result_row, text_relevance
from vms_face.services import audit as audit_log

log = get_logger(__name__)
router = APIRouter(prefix="/investigate", tags=["investigate"])

MAX_TOP_K = 200
MAX_PHOTO_BYTES = 8 * 1024 * 1024


def _enabled() -> None:
    if not settings.investigate_index_enabled:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "investigation index is not enabled")


class CameraHint(BaseModel):
    code: str                      # backend monitorId (= AI cameras.code)
    name: str | None = None        # what people call it ("Gate 3")


class Overrides(BaseModel):
    """Chips as the user left them. A field that is set replaces the parse."""
    camera_codes: list[str] | None = None
    object_class: str | None = None
    since: dt.datetime | None = None
    until: dt.datetime | None = None
    top_colour: str | None = None
    bottom_colour: str | None = None
    vehicle_type: str | None = None
    vehicle_colour: str | None = None
    gender: str | None = Field(None, pattern="^(male|female|)$")
    include_unknown_colour: bool | None = None       # also show people whose colour couldn't be read
    clear: list[str] = Field(default_factory=list)   # chip kinds the user removed


class SearchRequest(BaseModel):
    q: str = Field("", max_length=300)
    tz: str = "Asia/Kolkata"
    cameras: list[CameraHint] = Field(default_factory=list)
    overrides: Overrides = Field(default_factory=Overrides)
    # The caller's own cameras (set by the backend): results never come from
    # outside them, whatever the query or chips say.
    scope_codes: list[str] | None = None
    top_k: int = Field(50, ge=1, le=MAX_TOP_K)
    # Set by the backend from the account's `investigate_gender` switch (opt-in,
    # sensitive attribute, rule 8). Never trusted from a browser: the backend
    # builds this body itself.
    allow_gender: bool = False


async def _tenant_cameras(session: AsyncSession, tenant_id: uuid.UUID) -> dict[str, str]:
    """AI camera id → code (monitorId) for this tenant."""
    rows = await session.execute(select(Camera.id, Camera.code).where(Camera.tenant_id == tenant_id))
    return {str(cid): code for cid, code in rows.all()}


NO_CAMERA = "00000000-0000-0000-0000-000000000000"   # matches nothing
UNWATCHED = "unwatched:"                               # a camera of theirs the AI has no row for


def _filters(parsed: query_parser.ParsedQuery | None, ov: Overrides, code_to_id: dict[str, str],
             scope_codes: list[str] | None = None) -> SearchFilters:
    f = SearchFilters()
    if parsed is not None:
        f.camera_ids = list(parsed.camera_ids)
        f.object_classes = [parsed.object_class] if parsed.object_class else []
        f.since, f.until = parsed.since, parsed.until
        f.top_colour, f.bottom_colour = parsed.top_colour, parsed.bottom_colour
        f.vehicle_type, f.vehicle_colour = parsed.vehicle_type, parsed.vehicle_colour
        f.gender = parsed.gender
    if ov.camera_codes is not None:
        f.camera_ids = [code_to_id[c] for c in ov.camera_codes if c in code_to_id]
        if ov.camera_codes and not f.camera_ids:
            f.camera_ids = [NO_CAMERA]   # none of the tenant's: match nothing
    if ov.object_class is not None:
        f.object_classes = [ov.object_class] if ov.object_class else []
    if ov.since is not None:
        f.since = ov.since
    if ov.until is not None:
        f.until = ov.until
    if ov.top_colour is not None:
        f.top_colour = ov.top_colour or None
    if ov.bottom_colour is not None:
        f.bottom_colour = ov.bottom_colour or None
    if ov.vehicle_type is not None:
        f.vehicle_type = ov.vehicle_type or None
    if ov.vehicle_colour is not None:
        f.vehicle_colour = ov.vehicle_colour or None
    if ov.gender is not None:
        f.gender = ov.gender or None
    if ov.include_unknown_colour is not None:
        f.include_unknown_colour = ov.include_unknown_colour
    for kind in ov.clear:
        if kind == "camera":
            f.camera_ids = []
        elif kind == "object_class":
            f.object_classes = []
        elif kind == "time":
            f.since = f.until = None
        elif kind in ("top_colour", "bottom_colour", "vehicle_type", "vehicle_colour", "gender"):
            setattr(f, kind, None)
    if scope_codes is not None:
        allowed = {code_to_id[c] for c in scope_codes if c in code_to_id}
        f.camera_ids = [c for c in f.camera_ids if c in allowed] if f.camera_ids else sorted(allowed)
        if not f.camera_ids:
            f.camera_ids = [NO_CAMERA]
    return f


def _filters_meta(f: SearchFilters) -> dict:
    return {
        "camera_ids": f.camera_ids, "object_classes": f.object_classes,
        "since": f.since.isoformat() if f.since else None, "until": f.until.isoformat() if f.until else None,
        "top_colour": f.top_colour, "bottom_colour": f.bottom_colour,
        "vehicle_type": f.vehicle_type, "vehicle_colour": f.vehicle_colour,
        "gender": f.gender, "include_unknown_colour": f.include_unknown_colour,
    }


async def _run(tenant_id, vector, filters, top_k, to_score, cam_codes, *, gender_ok: bool = False,
               embedder=None, browse: bool = False, describes: bool = False) -> tuple[list[dict], list[dict]]:
    """Run a search → (result rows, notices for the page)."""
    from vms_face.investigate.search import (
        GENDER_PROMPTS, apply_margins, baseline_text, browse_tracks, count_unknown_colour, gender_filter,
    )

    store = get_qdrant_tracks()
    notices: list[dict] = []
    use_gender = bool(filters.gender and gender_ok and embedder is not None)
    if filters.gender and not gender_ok:
        notices.append({"kind": "gender_off", "message": "Man/woman filtering is switched off for this account, "
                        "so this shows everyone who fits the rest of the description."})
    use_margin = bool(describes and embedder is not None and vector is not None and not browse)
    limit = min(top_k * (8 if use_gender else 3), 600)
    try:
        if browse or vector is None:
            hits = await browse_tracks(store.client, store.collection, tenant_id=tenant_id, filters=filters,
                                       limit=limit, with_vectors=use_gender)
        else:
            hits = await query_tracks(store.client, store.collection, tenant_id=tenant_id, vector=vector,
                                      filters=filters, limit=limit, with_vectors=use_gender or use_margin)
        unknown = await count_unknown_colour(store.client, store.collection, tenant_id=tenant_id, filters=filters)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    if use_gender:
        loop = asyncio.get_running_loop()
        tv = await loop.run_in_executor(get_gpu_pool(), embedder.embed_texts, list(GENDER_PROMPTS))
        hits, unsure = gender_filter(hits, filters.gender, tv, embedder._scale)  # noqa: SLF001
        if unsure:
            notices.append({"kind": "gender_unsure", "count": unsure,
                            "message": f"{unsure} more {'person' if unsure == 1 else 'people'} left out: "
                                       "seen from above or too far to tell man from woman."})
    if use_margin:
        loop = asyncio.get_running_loop()
        cls = filters.object_classes[0] if len(filters.object_classes) == 1 else None
        base = (await loop.run_in_executor(get_gpu_pool(), embedder.embed_texts, [baseline_text(cls)]))[0]
        vouched = bool(filters.attribute_chips() or use_gender)
        before = len(hits)
        hits = apply_margins(hits, base, keep_below_zero=vouched)
        if before and not hits:
            notices.append({"kind": "no_good_match", "message": "Nobody here looks like that description. "
                            "Try fewer words, or check the time and cameras."})
    if unknown:
        notices.append({"kind": "colour_unknown", "count": unknown,
                        "message": f"{unknown} more {'person' if unknown == 1 else 'people'} left out because their "
                                   "colours couldn't be read (night, or unclear)."})
    rows = [result_row(h, camera_codes=cam_codes) for h in rerank(hits, filters, to_score=to_score, top_k=top_k)]
    return rows, notices


def _summary(results: list[dict]) -> dict:
    return {"count": len(results), "cameras": len({r["camera_id"] for r in results})}


@router.post("/search")
async def search(
    body: SearchRequest,
    session: AsyncSession = Depends(db_session),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    _enabled()
    from vms_face.investigate.embedder import SiglipEmbedder

    cam_codes = await _tenant_cameras(session, tenant_id)
    code_to_id = {code: cid for cid, code in cam_codes.items()}
    # Every camera of theirs can be named, also ones the AI doesn't watch:
    # "gate 1" with AI off on Gate 1 must say so, not search every camera.
    unwatched = {f"{UNWATCHED}{c.code}": (c.name or c.code) for c in body.cameras if c.code not in code_to_id}
    hints = [(code_to_id[c.code] if c.code in code_to_id else f"{UNWATCHED}{c.code}", c.code, c.name) for c in body.cameras]
    parsed = query_parser.parse(body.q, now=dt.datetime.now(dt.timezone.utc), tz=body.tz, cameras=hints)
    off_named = list(dict.fromkeys(unwatched[c] for c in parsed.camera_ids if c in unwatched))   # same name twice: once
    parsed.camera_ids = [c for c in parsed.camera_ids if c not in unwatched]
    filters = _filters(parsed, body.overrides, code_to_id, body.scope_codes)
    loop = asyncio.get_running_loop()
    embedder = await loop.run_in_executor(None, SiglipEmbedder.shared)
    picked_cameras = body.overrides.camera_codes is not None or "camera" in body.overrides.clear
    off_notice = [{"kind": "camera_not_indexed", "cameras": off_named,
                   "message": f"{', '.join(off_named)}: {'isn’t' if len(off_named) == 1 else 'aren’t'} being searched. "
                              "Smart features (AI) are switched off on "
                              f"{'that camera' if len(off_named) == 1 else 'those cameras'}, so nobody there is indexed."}] \
        if off_named and not picked_cameras else []

    # A place they named that is none of their cameras: say so (with close
    # names) instead of quietly searching every camera. Same when every camera
    # they named is one the AI doesn't watch.
    if off_notice and not parsed.camera_ids:
        notices, results = off_notice, []
    elif parsed.unknown_places and not picked_cameras:
        name_to_code = {c.name: c.code for c in body.cameras if c.name}
        notices = [{"kind": "unknown_place", "place": place,
                    "message": f"No camera called “{place}”.",
                    "suggestions": [{"name": n, "code": name_to_code.get(n)} for n in parsed.suggestions.get(place, [])]}
                   for place in parsed.unknown_places]
        results: list[dict] = []
    else:
        vector = None if parsed.browse else \
            (await loop.run_in_executor(get_gpu_pool(), embedder.embed_texts, [parsed.text]))[0]
        results, notices = await _run(tenant_id, vector, filters, body.top_k, text_relevance, cam_codes,
                                      gender_ok=body.allow_gender, embedder=embedder, browse=parsed.browse,
                                      describes=parsed.describes)
        if parsed.browse:
            notices.insert(0, {"kind": "browse", "message": "Everyone in this time and place, newest first."})
        notices = off_notice + notices

    await audit_log.record(
        actor=f"user:{actor}", actor_kind="user", action="investigate_search", tenant_id=tenant_id,
        target_type="tracks", target_id=None, reason="smart search",
        metadata={"q": body.q, "embedded_text": None if parsed.browse else parsed.text, "filters": _filters_meta(filters),
                  "gender_applied": bool(filters.gender and body.allow_gender), "browse": parsed.browse,
                  "unknown_places": parsed.unknown_places, "count": len(results), "model": embedder.model_tag})
    return {"parsed": parsed.to_dict(), "filters": _filters_meta(filters), "results": results, "notices": notices,
            "summary": _summary(results), "model": embedder.model_tag}


class ParseRequest(BaseModel):
    q: str = Field("", max_length=500)
    tz: str = "Asia/Kolkata"
    cameras: list[CameraHint] = Field(default_factory=list)


@router.post("/parse")
async def parse_query(
    body: ParseRequest,
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    """The rule parser alone (time, cameras, person/vehicle, colours): no
    search, no model. Ask Drishyam uses it to read times and places in a question."""
    cam_codes = await _tenant_cameras(session, tenant_id)
    code_to_id = {code: cid for cid, code in cam_codes.items()}
    hints = [(code_to_id[c.code], c.code, c.name) for c in body.cameras if c.code in code_to_id]
    parsed = query_parser.parse(body.q, now=dt.datetime.now(dt.timezone.utc), tz=body.tz, cameras=hints)
    out = parsed.to_dict()
    out["camera_codes"] = [cam_codes.get(c) for c in parsed.camera_ids if cam_codes.get(c)]
    return out


@router.post("/search/photo")
async def search_photo(
    photo: UploadFile = File(...),
    filters_json: str = Form("{}", alias="filters"),
    scope_json: str | None = Form(None, alias="scope_codes"),
    top_k: int = Form(50),
    session: AsyncSession = Depends(db_session),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    _enabled()
    from vms_face.investigate.embedder import SiglipEmbedder

    data = await photo.read(MAX_PHOTO_BYTES + 1)
    if len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "photo larger than 8 MB")
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "not an image")
    try:
        ov = Overrides(**json.loads(filters_json or "{}"))
        scope = json.loads(scope_json) if scope_json else None
        if scope is not None and not (isinstance(scope, list) and all(isinstance(c, str) for c in scope)):
            raise ValueError("scope_codes must be a list of camera codes")
    except Exception as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"bad filters: {e}") from e
    top_k = max(1, min(MAX_TOP_K, top_k))

    cam_codes = await _tenant_cameras(session, tenant_id)
    filters = _filters(None, ov, {code: cid for cid, code in cam_codes.items()}, scope)
    loop = asyncio.get_running_loop()
    embedder = await loop.run_in_executor(None, SiglipEmbedder.shared)
    vector = (await loop.run_in_executor(get_gpu_pool(), embedder.embed_images, [img]))[0]
    results, notices = await _run(tenant_id, vector, filters, top_k, lambda c: max(0.0, c), cam_codes)

    await audit_log.record(
        actor=f"user:{actor}", actor_kind="user", action="investigate_search_photo", tenant_id=tenant_id,
        target_type="tracks", target_id=None, reason="smart search by photo",
        metadata={"filters": _filters_meta(filters), "count": len(results), "model": embedder.model_tag,
                  "photo_bytes": len(data)})
    return {"filters": _filters_meta(filters), "results": results, "notices": notices, "summary": _summary(results),
            "model": embedder.model_tag}


async def _owned_track(session: AsyncSession, tenant_id: uuid.UUID, track_id: uuid.UUID) -> Track:
    row = await session.get(Track, track_id)
    if row is None or row.tenant_id != tenant_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "track not found")
    return row


@router.get("/tracks/{track_id}")
async def get_track(
    track_id: uuid.UUID,
    session: AsyncSession = Depends(db_session),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    _enabled()
    t = await _owned_track(session, tenant_id, track_id)
    cam = await session.get(Camera, t.camera_id)
    pts = await session.execute(select(TrackPoint.ts, TrackPoint.bbox).where(TrackPoint.track_id == t.id).order_by(TrackPoint.ts))
    await audit_log.record(actor=f"user:{actor}", actor_kind="user", action="investigate_track_open", tenant_id=tenant_id,
                           target_type="track", target_id=str(t.id))
    return {
        "track_id": str(t.id), "camera_id": str(t.camera_id), "camera_code": cam.code if cam else None,
        "object_class": t.object_class, "source": t.source,
        "first_seen": t.first_seen.isoformat(), "last_seen": t.last_seen.isoformat(),
        "best_crop_ts": t.best_crop_ts.isoformat() if t.best_crop_ts else None,
        "attributes": t.attributes or {}, "ir": t.ir, "person_id": str(t.person_id) if t.person_id else None,
        "case_id": str(t.case_id) if t.case_id else None, "model_info": t.model_info or {},
        "points": [{"ts": ts.isoformat(), "bbox": list(b)} for ts, b in pts.all()],
        "crop_path": f"/investigate/tracks/{t.id}/crop",
    }


@router.get("/tracks/{track_id}/crop")
async def get_track_crop(
    track_id: uuid.UUID,
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> Response:
    _enabled()
    t = await _owned_track(session, tenant_id, track_id)
    if not t.best_crop_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no photo for this track")
    loop = asyncio.get_running_loop()
    try:
        data = await loop.run_in_executor(None, get_object_store().get_bytes, settings.minio_bucket_investigate, t.best_crop_key)
    except Exception as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "photo no longer available") from e
    return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


class TrackAtRequest(BaseModel):
    camera_code: str
    ts: dt.datetime
    x: float = Field(..., ge=0, le=1000)      # 0-1000 across the frame
    y: float = Field(..., ge=0, le=1000)
    scope_codes: list[str] | None = None


@router.post("/track-at")
async def track_at(
    body: TrackAtRequest,
    session: AsyncSession = Depends(db_session),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    """Who is at (x, y) on this camera at this moment? 404 when nobody indexed is there."""
    _enabled()
    if body.scope_codes is not None and body.camera_code not in body.scope_codes:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "camera not found")
    cam_ids = (await session.execute(
        select(Camera.id).where(Camera.tenant_id == tenant_id, Camera.code == body.camera_code))).scalars().all()
    if not cam_ids:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "camera not found")
    ts = body.ts if body.ts.tzinfo else body.ts.replace(tzinfo=dt.timezone.utc)
    win = dt.timedelta(seconds=jny.PICK_TIME_S)
    rows = (await session.execute(
        select(TrackPoint.track_id, TrackPoint.ts, TrackPoint.bbox)
        .join(Track, Track.id == TrackPoint.track_id)
        .where(Track.tenant_id == tenant_id, Track.camera_id.in_(cam_ids),
               TrackPoint.ts >= ts - win, TrackPoint.ts <= ts + win)
    )).all()
    points: dict[str, list] = {}
    for tid, t, b in rows:
        points.setdefault(str(tid), []).append((t, list(b)))
    picked = jny.pick_track_at(points, ts, body.x, body.y)
    await audit_log.record(actor=f"user:{actor}", actor_kind="user", action="investigate_track_at", tenant_id=tenant_id,
                           target_type="track", target_id=picked, metadata={"camera": body.camera_code, "ts": ts.isoformat(),
                                                                            "x": body.x, "y": body.y})
    if not picked:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no indexed person at that spot and time")
    return {"track_id": picked}


class JourneyRequest(BaseModel):
    track_id: uuid.UUID
    window_s: int = Field(4 * 3600, ge=60, le=48 * 3600)    # look this far before and after the seed
    scope_codes: list[str] | None = None
    top_k: int = Field(120, ge=1, le=300)


def _cand_from_row(t: Track) -> jny.Candidate:
    return jny.Candidate(track_id=str(t.id), camera_id=str(t.camera_id), first_seen=t.first_seen, last_seen=t.last_seen,
                         cosine=1.0, attributes=t.attributes or {}, person_id=str(t.person_id) if t.person_id else None)


def _cand_from_hit(h: dict) -> jny.Candidate:
    pl = h["payload"]
    attrs = {k[5:]: {"value": v, "conf": 1.0} for k, v in pl.items() if k.startswith("attr_")}
    return jny.Candidate(
        track_id=h["id"], camera_id=pl.get("camera_id", ""), cosine=h["cosine"], attributes=attrs,
        first_seen=dt.datetime.fromtimestamp(pl["first_seen_ts"], dt.timezone.utc),
        last_seen=dt.datetime.fromtimestamp(pl.get("last_seen_ts", pl["first_seen_ts"]), dt.timezone.utc),
        person_id=pl.get("person_id"),
    )


def _stop_row(c: jny.Candidate, codes: dict[str, str]) -> dict[str, Any]:
    return {
        "track_id": c.track_id, "camera_id": c.camera_id, "camera_code": codes.get(c.camera_id),
        "first_seen": c.first_seen.isoformat(), "last_seen": c.last_seen.isoformat(),
        "score": round(c.score, 4), "status": c.status, "reasons": c.reasons,
        "attributes": {k: (v.get("value") if isinstance(v, dict) else v) for k, v in (c.attributes or {}).items()},
        "crop_path": f"/investigate/tracks/{c.track_id}/crop",
    }


@router.post("/journey")
async def journey(
    body: JourneyRequest,
    session: AsyncSession = Depends(db_session),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    """The seed track, proposed sightings of the same person (likely / possible),
    and the journey made of what has been confirmed. Leads, not identifications."""
    _enabled()
    seed_row = await _owned_track(session, tenant_id, body.track_id)
    codes = await _tenant_cameras(session, tenant_id)
    if body.scope_codes is not None and codes.get(str(seed_row.camera_id)) not in body.scope_codes:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "track not found")
    store = get_qdrant_tracks()
    got = await store.client.retrieve(store.collection, ids=[str(seed_row.id)], with_vectors=True, with_payload=True)
    if not got or (got[0].payload or {}).get("tenant_id") != str(tenant_id):
        raise HTTPException(status.HTTP_409_CONFLICT, "this track has no fingerprint to search with")
    vector = got[0].vector
    win = dt.timedelta(seconds=body.window_s)
    filters = _filters(None, Overrides(), {code: cid for cid, code in codes.items()}, body.scope_codes)
    filters.object_classes = [seed_row.object_class]
    filters.since, filters.until = seed_row.first_seen - win, seed_row.last_seen + win
    hits = await query_tracks(store.client, store.collection, tenant_id=tenant_id, vector=vector, filters=filters,
                              limit=body.top_k)
    reviews = {str(t): v for t, v in (await session.execute(
        select(TrackReview.track_id, TrackReview.verdict).where(
            TrackReview.tenant_id == tenant_id, TrackReview.seed_track_id == seed_row.id))).all()}
    # Confirmed sightings outside the search window or top_k still belong on the journey.
    missing = [uuid.UUID(t) for t, v in reviews.items() if v == "confirmed" and t not in {h["id"] for h in hits}]
    extra = []
    if missing:
        extra = [_cand_from_row(t) for t in (await session.execute(
            select(Track).where(Track.tenant_id == tenant_id, Track.id.in_(missing)))).scalars().all()]
    ranked = jny.rank(_cand_from_row(seed_row), [_cand_from_hit(h) for h in hits] + extra, reviews)
    stops = jny.journey(ranked)
    await audit_log.record(actor=f"user:{actor}", actor_kind="user", action="investigate_journey", tenant_id=tenant_id,
                           target_type="track", target_id=str(seed_row.id),
                           metadata={"window_s": body.window_s, "proposed": len(ranked) - 1, "stops": len(stops)})
    return {
        "seed": _stop_row(ranked[0], codes),
        "stops": [_stop_row(c, codes) for c in stops],
        "candidates": [_stop_row(c, codes) for c in ranked[1:] if c.status in ("likely", "possible")],
        "route_codes": jny.route(stops, codes),
        "sightings": [{
            "sighting_id": c.track_id, "camera_id": c.camera_id, "camera_code": codes.get(c.camera_id),
            "started_at": c.first_seen.isoformat(), "ended_at": c.last_seen.isoformat(),
            "best_similarity": round(c.score, 4), "candidate_count": 1,
        } for c in stops],
        "thresholds": {"likely": jny.LIKELY, "possible": jny.POSSIBLE},
    }


class ReviewRequest(BaseModel):
    seed_track_id: uuid.UUID
    track_id: uuid.UUID
    verdict: str = Field(..., pattern="^(confirmed|rejected|clear)$")
    score: float | None = None


@router.post("/journey/review")
async def review(
    body: ReviewRequest,
    session: AsyncSession = Depends(db_session),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    """Record who confirmed or rejected a proposed sighting ('clear' undoes it)."""
    _enabled()
    await _owned_track(session, tenant_id, body.seed_track_id)
    await _owned_track(session, tenant_id, body.track_id)
    from sqlalchemy import delete
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    if body.verdict == "clear":
        await session.execute(delete(TrackReview).where(
            TrackReview.tenant_id == tenant_id, TrackReview.seed_track_id == body.seed_track_id,
            TrackReview.track_id == body.track_id))
    else:
        stmt = pg_insert(TrackReview).values(tenant_id=tenant_id, seed_track_id=body.seed_track_id, track_id=body.track_id,
                                             verdict=body.verdict, score=body.score, actor=actor)
        await session.execute(stmt.on_conflict_do_update(
            constraint="uq_track_review",
            set_={"verdict": body.verdict, "score": body.score, "actor": actor, "updated_at": dt.datetime.now(dt.timezone.utc)}))
    await session.commit()
    await audit_log.record(actor=f"user:{actor}", actor_kind="user", action=f"investigate_journey_{body.verdict}",
                           tenant_id=tenant_id, target_type="track", target_id=str(body.track_id),
                           metadata={"seed": str(body.seed_track_id), "score": body.score})
    return {"ok": True, "verdict": body.verdict, "by": actor}


class HoldRequest(BaseModel):
    case_id: uuid.UUID | None = None      # None releases the hold


@router.post("/tracks/{track_id}/hold")
async def hold_track(
    track_id: uuid.UUID,
    body: HoldRequest,
    session: AsyncSession = Depends(db_session),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    """A case holds this track (I-4): retention keeps its row, points, photo
    and fingerprint until the hold is released (case_id null)."""
    _enabled()
    t = await _owned_track(session, tenant_id, track_id)
    t.case_id = body.case_id
    await session.commit()
    store = get_qdrant_tracks()
    if body.case_id:
        await store.client.set_payload(store.collection, payload={"case_id": str(body.case_id)}, points=[str(t.id)])
    else:
        await store.client.delete_payload(store.collection, keys=["case_id"], points=[str(t.id)])
    await audit_log.record(actor=f"user:{actor}", actor_kind="user",
                           action="investigate_track_hold" if body.case_id else "investigate_track_release",
                           tenant_id=tenant_id, target_type="track", target_id=str(t.id),
                           metadata={"case_id": str(body.case_id) if body.case_id else None})
    return {"track_id": str(t.id), "case_id": str(body.case_id) if body.case_id else None}


@router.get("/activity")
async def activity(
    camera_code: str = Query(..., max_length=64),
    since: dt.datetime = Query(...),
    until: dt.datetime = Query(...),
    bin_s: float | None = Query(None, ge=1, le=3600),
    scope: str | None = Query(None, max_length=8000),        # comma-separated camera codes (set by the backend)
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    """Where the activity is on one camera between since and until (at most 7 days)."""
    _enabled()
    since = since if since.tzinfo else since.replace(tzinfo=dt.timezone.utc)
    until = until if until.tzinfo else until.replace(tzinfo=dt.timezone.utc)
    if until <= since or until - since > dt.timedelta(days=7):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "the range must be positive and at most 7 days")
    if scope is not None and camera_code not in scope.split(","):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "camera not found")
    cam_ids = (await session.execute(
        select(Camera.id).where(Camera.tenant_id == tenant_id, Camera.code == camera_code))).scalars().all()
    spans: list[tuple[dt.datetime, dt.datetime]] = []
    if cam_ids:
        spans = [(a, b) for a, b in (await session.execute(
            select(Track.first_seen, Track.last_seen).where(
                Track.tenant_id == tenant_id, Track.camera_id.in_(cam_ids),
                Track.first_seen <= until, Track.last_seen >= since))).all()]
    width = act.bin_seconds(since, until, bin_s)
    return {
        "camera_code": camera_code, "since": since.isoformat(), "until": until.isoformat(), "bin_s": width,
        "bins": act.bins(spans, since, until, width),
        "segments": [[a.isoformat(), b.isoformat()] for a, b in act.segments(spans, since=since, until=until)],
        "passes": len(spans),
    }


class ImportRequest(BaseModel):
    import_id: str = Field(..., pattern=r"^[0-9a-fA-F-]{36}$")
    path: str
    name: str = Field(..., max_length=200)
    recorded_start: dt.datetime
    sample_fps: float | None = Field(None, ge=0.5, le=25)


@router.post("/imports", status_code=202)
async def start_import(
    body: ImportRequest,
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    """Index an uploaded video (it must be in the imports folder). One at a time, on the GPU."""
    _enabled()
    from vms_face.investigate import file_import as fi

    try:
        path = fi.safe_path(settings.investigate_imports_root, body.path)
    except ValueError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    existing = fi.get_job(body.import_id)
    if existing and existing.tenant_id != tenant_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "import not found")
    start = body.recorded_start if body.recorded_start.tzinfo else body.recorded_start.replace(tzinfo=dt.timezone.utc)
    job = fi.submit(fi.ImportJob(import_id=body.import_id, tenant_id=tenant_id, path=str(path), name=body.name,
                                 recorded_start=start, sample_fps=body.sample_fps or settings.investigate_import_sample_fps))
    await audit_log.record(actor=f"user:{actor}", actor_kind="user", action="investigate_import", tenant_id=tenant_id,
                           target_type="import", target_id=body.import_id, metadata={"name": body.name, "path": path.name})
    return job.view()


@router.get("/imports/{import_id}")
async def import_status(import_id: str, tenant_id: uuid.UUID = Depends(current_tenant_id)) -> dict[str, Any]:
    _enabled()
    from vms_face.investigate import file_import as fi

    job = fi.get_job(import_id)
    if job is None or job.tenant_id != tenant_id:
        # Not in memory: finished before a restart, or never started here.
        return {"import_id": import_id, "status": "unknown", "camera_code": fi.camera_code(import_id)}
    return job.view()


@router.delete("/imports/{import_id}")
async def delete_import(
    import_id: str,
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    _enabled()
    from vms_face.investigate import file_import as fi

    removed = await fi.delete_import(tenant_id, import_id)
    await audit_log.record(actor=f"user:{actor}", actor_kind="user", action="investigate_import_delete", tenant_id=tenant_id,
                           target_type="import", target_id=import_id, metadata={"tracks": removed})
    return {"ok": True, "tracks_removed": removed}


@router.get("/tracks/{track_id}/companions")
async def companions(
    track_id: uuid.UUID,
    journey: bool = Query(True, description="also look at the confirmed stops of their journey"),
    scope: str | None = Query(None, max_length=8000),
    session: AsyncSession = Depends(db_session),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    """People (and vehicles) seen close to this person for a few seconds or more,
    per stop. Geometry on the index (box trails), not recognition: leads."""
    _enabled()
    seed = await _owned_track(session, tenant_id, track_id)
    codes = await _tenant_cameras(session, tenant_id)
    allowed = set(scope.split(",")) if scope is not None else None
    if allowed is not None and codes.get(str(seed.camera_id)) not in allowed:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "track not found")
    stops = [seed]
    if journey:
        confirmed = (await session.execute(select(TrackReview.track_id).where(
            TrackReview.tenant_id == tenant_id, TrackReview.seed_track_id == seed.id,
            TrackReview.verdict == "confirmed"))).scalars().all()
        if confirmed:
            stops += (await session.execute(select(Track).where(
                Track.tenant_id == tenant_id, Track.id.in_(confirmed)))).scalars().all()

    async def trail(ids: list[uuid.UUID]) -> dict[str, list]:
        rows = (await session.execute(select(TrackPoint.track_id, TrackPoint.ts, TrackPoint.bbox)
                                      .where(TrackPoint.track_id.in_(ids)))).all()
        out: dict[str, list] = {}
        for tid, ts, b in rows:
            out.setdefault(str(tid), []).append((ts, list(b)))
        return out

    per_stop, merged = [], {}
    for st in stops:
        if allowed is not None and codes.get(str(st.camera_id)) not in allowed:
            continue
        others = (await session.execute(select(Track).where(
            Track.tenant_id == tenant_id, Track.camera_id == st.camera_id, Track.id != st.id,
            Track.first_seen <= st.last_seen, Track.last_seen >= st.first_seen))).scalars().all()
        if not others:
            per_stop.append({"track_id": str(st.id), "camera_code": codes.get(str(st.camera_id)), "companions": []})
            continue
        trails = await trail([st.id] + [o.id for o in others])
        found = assoc.companions(trails.get(str(st.id), []), {str(o.id): trails.get(str(o.id), []) for o in others})
        by_id = {str(o.id): o for o in others}
        rows = []
        for c in found:
            o = by_id[c.track_id]
            row = {
                "track_id": c.track_id, "object_class": o.object_class, "seconds": c.seconds,
                "first": c.first.isoformat(), "last": c.last.isoformat(), "closest_heights": c.closest,
                "attributes": {k: (v.get("value") if isinstance(v, dict) else v) for k, v in (o.attributes or {}).items()},
                "crop_path": f"/investigate/tracks/{c.track_id}/crop", "camera_code": codes.get(str(o.camera_id)),
            }
            rows.append(row)
            m = merged.setdefault(c.track_id, {**row, "stops": 0})
            m["stops"] += 1
        per_stop.append({"track_id": str(st.id), "camera_code": codes.get(str(st.camera_id)),
                         "first_seen": st.first_seen.isoformat(), "companions": rows})
    await audit_log.record(actor=f"user:{actor}", actor_kind="user", action="investigate_companions", tenant_id=tenant_id,
                           target_type="track", target_id=str(seed.id),
                           metadata={"stops": len(per_stop), "companions": len(merged)})
    return {"track_id": str(seed.id), "stops": per_stop,
            "companions": sorted(merged.values(), key=lambda r: -r["seconds"]),
            "rule": {"near_heights": assoc.NEAR_HEIGHTS, "min_seconds": assoc.MIN_TOGETHER_S}}


class SynopsisRequest(BaseModel):
    camera_code: str
    camera_name: str | None = Field(None, max_length=200)
    since: dt.datetime
    until: dt.datetime
    tz_offset_min: int = Field(330, ge=-720, le=840)       # the viewer's offset, for the burned-in clock
    speed: float | None = Field(None, ge=1, le=16)
    target_s: float = Field(180, ge=30, le=1800)
    scope_codes: list[str] | None = None


@router.post("/synopsis", status_code=202)
async def start_synopsis(
    body: SynopsisRequest,
    session: AsyncSession = Depends(db_session),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    """Make a reel of the busy stretches (from the index) of one camera or imported video."""
    _enabled()
    from vms_face.investigate import synopsis as syn

    since = body.since if body.since.tzinfo else body.since.replace(tzinfo=dt.timezone.utc)
    until = body.until if body.until.tzinfo else body.until.replace(tzinfo=dt.timezone.utc)
    if until <= since or until - since > dt.timedelta(days=2):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "the range must be positive and at most 2 days")
    if body.scope_codes is not None and body.camera_code not in body.scope_codes:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "camera not found")
    cams = (await session.execute(select(Camera).where(Camera.tenant_id == tenant_id, Camera.code == body.camera_code))).scalars().all()
    if not cams:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "camera not found")
    spans = [(a, b) for a, b in (await session.execute(select(Track.first_seen, Track.last_seen).where(
        Track.tenant_id == tenant_id, Track.camera_id.in_([c.id for c in cams]),
        Track.first_seen <= until, Track.last_seen >= since))).all()]
    p = syn.plan(act.segments(spans, since=since, until=until), since, until, target_s=body.target_s, speed=body.speed)
    if not p.pieces:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no activity in that range: nothing to put in a synopsis")
    file_source = None
    cfg = next((c.config_json or {} for c in cams if (c.config_json or {}).get("import")), None)
    if body.camera_code.startswith("file:"):
        if not cfg or not cfg.get("path") or not cfg.get("recorded_start"):
            raise HTTPException(status.HTTP_409_CONFLICT, "index this video again to make a synopsis of it")
        file_source = (cfg["path"], dt.datetime.fromisoformat(cfg["recorded_start"]))
    else:
        from vms_face.journey import recordings

        segs = await asyncio.get_running_loop().run_in_executor(
            None, recordings.locate_window, body.camera_code, p.pieces[0][0], p.pieces[-1][1])
        if not segs:
            # Never fall back to replaying the NVR: a synopsis would pull hours from it.
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                "this server has no recordings of that camera for that time; a synopsis is made from "
                                "recordings kept on this server or from an imported video")
    job = syn.SynopsisJob(job_id=str(uuid.uuid4()), tenant_id=tenant_id, camera_code=body.camera_code,
                          camera_name=body.camera_name or body.camera_code, since=since, until=until,
                          tz_offset_min=body.tz_offset_min, plan=p)

    def upload(path, key):
        get_object_store().put_bytes(settings.minio_bucket_investigate, key, Path(path).read_bytes(), "video/mp4")

    syn.start(job, file_source, upload)
    await audit_log.record(actor=f"user:{actor}", actor_kind="user", action="investigate_synopsis", tenant_id=tenant_id,
                           target_type="camera", target_id=body.camera_code,
                           metadata={"since": since.isoformat(), "until": until.isoformat(), "speed": p.speed, "stretches": len(p.pieces)})
    return job.view()


def _own_synopsis(job_id: str, tenant_id: uuid.UUID):
    from vms_face.investigate import synopsis as syn

    job = syn.get(job_id)
    if job is None or job.tenant_id != tenant_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "synopsis not found (it is kept until the AI service restarts)")
    return job


@router.get("/synopsis/{job_id}")
async def synopsis_status(job_id: str, tenant_id: uuid.UUID = Depends(current_tenant_id)) -> dict[str, Any]:
    _enabled()
    return _own_synopsis(job_id, tenant_id).view()


@router.get("/synopsis/{job_id}/video")
async def synopsis_video(job_id: str, tenant_id: uuid.UUID = Depends(current_tenant_id)) -> Response:
    _enabled()
    job = _own_synopsis(job_id, tenant_id)
    if job.status != "ready" or not job.output_key:
        raise HTTPException(status.HTTP_409_CONFLICT, "not ready")
    data = await asyncio.get_running_loop().run_in_executor(
        None, get_object_store().get_bytes, settings.minio_bucket_investigate, job.output_key)
    return Response(content=data, media_type="video/mp4", headers={"Cache-Control": "private, max-age=3600"})


class TranscribeRequest(BaseModel):
    camera_code: str
    since: dt.datetime | None = None          # imported video: omit for the whole file
    until: dt.datetime | None = None
    scope_codes: list[str] | None = None


@router.post("/speech/transcribe", status_code=202)
async def transcribe(
    body: TranscribeRequest,
    session: AsyncSession = Depends(db_session),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    """Turn speech into searchable text, for one imported video or a recorded time range
    (at most 6 hours, from this server's recordings; never the recorder)."""
    _enabled()
    from vms_face.investigate import speech

    if body.scope_codes is not None and body.camera_code not in body.scope_codes:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "camera not found")
    cam = (await session.execute(select(Camera).where(Camera.tenant_id == tenant_id, Camera.code == body.camera_code)
                                 .order_by(Camera.enabled.desc()))).scalars().first()
    if cam is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "camera not found")
    cfg = cam.config_json or {}
    if body.camera_code.startswith("file:"):
        if not cfg.get("path") or not cfg.get("recorded_start"):
            raise HTTPException(status.HTTP_409_CONFLICT, "index this video again first")
        start = dt.datetime.fromisoformat(cfg["recorded_start"])
        since = body.since or start
        until = body.until or (start + dt.timedelta(hours=6))
        pieces = [(cfg["path"], max(0.0, (since - start).total_seconds()), (until - since).total_seconds(), since)]
        source = "file"
    else:
        if not body.since or not body.until:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "since and until are required for a camera")
        since, until = body.since, body.until
        if until <= since or until - since > dt.timedelta(hours=6):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "the range must be positive and at most 6 hours")
        from vms_face.journey import recordings

        segs = await asyncio.get_running_loop().run_in_executor(None, recordings.locate_window, body.camera_code, since, until)
        if not segs:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "this server has no recordings of that camera for that time")
        pieces = [(str(x.path), x.seek_sec, x.take_sec, x.segment_started_at + dt.timedelta(seconds=x.seek_sec)) for x in segs]
        source = "recording"
    job = speech.start_job(speech.SpeechJob(job_id=str(uuid.uuid4()), tenant_id=tenant_id, camera_id=cam.id,
                                            camera_code=body.camera_code, since=since, until=until),
                           pieces, source, asyncio.get_running_loop())
    await audit_log.record(actor=f"user:{actor}", actor_kind="user", action="investigate_speech_transcribe", tenant_id=tenant_id,
                           target_type="camera", target_id=body.camera_code,
                           metadata={"since": since.isoformat(), "until": until.isoformat(), "source": source})
    return job.view()


@router.get("/speech/jobs/{job_id}")
async def transcribe_status(job_id: str, tenant_id: uuid.UUID = Depends(current_tenant_id)) -> dict[str, Any]:
    _enabled()
    from vms_face.investigate import speech

    job = speech.get_job(job_id)
    if job is None or job.tenant_id != tenant_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "job not found")
    return job.view()


@router.get("/speech")
async def search_speech(
    q: str = Query(..., min_length=2, max_length=200),
    scope: str | None = Query(None, max_length=8000),
    limit: int = Query(50, ge=1, le=200),
    session: AsyncSession = Depends(db_session),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    """Transcribed speech containing the words (any order), newest first."""
    _enabled()
    from sqlalchemy import func, or_

    codes = await _tenant_cameras(session, tenant_id)
    allowed = set(scope.split(",")) if scope is not None else None
    cam_ids = [uuid.UUID(cid) for cid, code in codes.items() if allowed is None or code in allowed]
    match = or_(func.to_tsvector("simple", SpeechSegment.text).op("@@")(func.plainto_tsquery("simple", q)),
                SpeechSegment.text.ilike(f"%{q.replace('%', '').replace('_', '')}%"))
    rows = (await session.execute(select(SpeechSegment).where(
        SpeechSegment.tenant_id == tenant_id, SpeechSegment.camera_id.in_(cam_ids), match)
        .order_by(SpeechSegment.start_ts.desc()).limit(limit))).scalars().all() if cam_ids else []
    await audit_log.record(actor=f"user:{actor}", actor_kind="user", action="investigate_speech_search", tenant_id=tenant_id,
                           target_type="speech", target_id=None, metadata={"q": q, "count": len(rows)})
    return {"q": q, "results": [{
        "id": str(r.id), "camera_code": codes.get(str(r.camera_id)), "start": r.start_ts.isoformat(), "end": r.end_ts.isoformat(),
        "text": r.text, "lang": r.lang, "source": r.source,
    } for r in rows]}


@router.get("/status")
async def index_status(
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    out: dict[str, Any] = {"enabled": settings.investigate_index_enabled,
                           "person_detection": settings.pipeline_person_detection_enabled}
    if not settings.investigate_index_enabled:
        return out
    n, first, last = (await session.execute(
        select(func.count(), func.min(Track.first_seen), func.max(Track.last_seen)).where(Track.tenant_id == tenant_id)
    )).one()
    out.update(tracks=int(n), oldest=first.isoformat() if first else None, newest=last.isoformat() if last else None)
    try:
        from vms_face.investigate.embedder import SiglipEmbedder

        out["model"] = SiglipEmbedder.shared().model_tag
    except Exception as e:
        out["model_error"] = str(e)
    return out
