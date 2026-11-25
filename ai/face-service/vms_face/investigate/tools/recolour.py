"""Re-read the clothing colours of people already in the search index.

Tracks indexed before 2026-11-25 had their top colour read from the whole
person (trousers, floor and wall included), so about half had no colour sure
enough to store and a "red top" search could not find them. This re-reads
top (upper body) and bottom (lower half) colours from each track's stored best
crop, the same way the indexer now does, and updates Postgres and Qdrant.
Night (IR) tracks and vehicles are left alone. Safe to run again.

    docker exec drishyam-ai sh -c 'cd /srv/app/face_detection && python -m vms_face.investigate.tools.recolour'
    ... --dry-run          only report what would change
    ... --tenant <uuid>    one organisation only
"""
from __future__ import annotations

import argparse
import asyncio
import collections
import uuid

import cv2
import numpy as np


async def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tenant", type=uuid.UUID, default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--batch", type=int, default=32)
    args = ap.parse_args(argv)

    from sqlalchemy import select, update

    from vms_face.config import settings
    from vms_face.domain.models import Track
    from vms_face.infra.minio_store import get_object_store
    from vms_face.infra.postgres import session_scope
    from vms_face.infra.qdrant import get_qdrant_tracks
    from vms_face.investigate import index_schema as ix
    from vms_face.investigate.embedder import SiglipEmbedder
    from vms_face.investigate.indexer import COLOURS, BOTTOM_PROMPT, TOP_PROMPT, lower_half, upper_body

    q = select(Track.id, Track.tenant_id, Track.best_crop_key, Track.attributes).where(
        Track.object_class == "person", Track.ir.is_(False), Track.best_crop_key.is_not(None))
    if args.tenant:
        q = q.where(Track.tenant_id == args.tenant)
    async with session_scope() as s:
        rows = (await s.execute(q)).all()
    print(f"{len(rows)} people to re-read")
    embedder = SiglipEmbedder.shared()
    store, qd = get_object_store(), get_qdrant_tracks()
    stats = collections.Counter()
    for i in range(0, len(rows), args.batch):
        chunk, crops = [], []
        for r in rows[i:i + args.batch]:
            try:
                img = cv2.imdecode(np.frombuffer(store.get_bytes(settings.minio_bucket_investigate, r.best_crop_key), np.uint8),
                                   cv2.IMREAD_COLOR)
            except Exception:  # noqa: BLE001 — crop gone (retention): skip
                img = None
            if img is None or img.size == 0:
                stats["no_crop"] += 1
                continue
            chunk.append(r)
            crops.append(img)
        if not chunk:
            continue
        vecs = embedder.embed_images([upper_body(c) for c in crops] + [lower_half(c) for c in crops])
        n = len(chunk)
        tops = embedder.classify(vecs[:n], COLOURS, TOP_PROMPT)
        bottoms = embedder.classify(vecs[n:], COLOURS, BOTTOM_PROMPT)
        for r, top, bottom in zip(chunk, tops, bottoms):
            attrs = dict(r.attributes or {})
            before = (attrs.get("top_colour") or {}).get("value"), (attrs.get("bottom_colour") or {}).get("value")
            attrs["top_colour"] = {"value": top[0], "conf": round(top[1], 3)}
            attrs["bottom_colour"] = {"value": bottom[0], "conf": round(bottom[1], 3)}
            stored = {k: attrs[k]["value"] for k in ("top_colour", "bottom_colour") if attrs[k]["conf"] >= ix.PAYLOAD_MIN_CONF}
            stats["searchable_top" if "top_colour" in stored else "unsure_top"] += 1
            if before != (top[0], bottom[0]):
                stats["changed"] += 1
            if args.dry_run:
                continue
            async with session_scope() as s:
                await s.execute(update(Track).where(Track.id == r.id).values(attributes=attrs))
                await s.commit()
            gone = [f"attr_{k}" for k in ("top_colour", "bottom_colour") if k not in stored]
            if stored:
                await qd.client.set_payload(qd.collection, payload={f"attr_{k}": v for k, v in stored.items()},
                                            points=[str(r.id)])
            if gone:
                await qd.client.delete_payload(qd.collection, keys=gone, points=[str(r.id)])
        print(f"  {min(i + args.batch, len(rows))}/{len(rows)}")
    print(dict(stats), "(dry run, nothing written)" if args.dry_run else "")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
