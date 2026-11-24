"""Click to track (I-3): from one person pass to their journey across cameras.

    click on video (camera, time, x, y) ──pick_track_at──▶ seed track
    seed fingerprint ──vms_tracks search──▶ candidates ──rank──▶ likely / possible
    person confirms / rejects ──▶ journey = seed + confirmed (+ same known face)

The fingerprint is SigLIP 2, an image model, not a person re-identification
model: measured on real crops, the same person scores 0.92-0.99 and different
people up to ~0.92. So proposals are leads (forensic rule 15): ranked,
labelled, and only a person's confirmation puts them on the journey. Physics
helps: nobody is on two cameras' footage at the same moment, and two
simultaneous tracks on one camera are two people.

Pure logic; the route (api/routes/investigate.py) does the I/O.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Iterable, Sequence

LIKELY = 0.92            # cosine (after adjustments) to call a candidate "likely the same person"
POSSIBLE = 0.88          # below this, not proposed at all
COLOUR_AGREE = 0.01
COLOUR_DISAGREE = 0.03
SIMULTANEOUS = 0.06      # on another camera at the very same time: almost surely someone else
CONF_FOR_COLOUR = 0.5    # only confident colours count as evidence
PICK_TIME_S = 6.0        # a click matches track positions within this many seconds (recorded vs live clock + latency)
PICK_MARGIN = 40         # grid units (of 1000) a click may fall outside a box and still pick it


@dataclass
class Candidate:
    track_id: str
    camera_id: str
    first_seen: dt.datetime
    last_seen: dt.datetime
    cosine: float
    attributes: dict = field(default_factory=dict)
    person_id: str | None = None
    score: float = 0.0
    status: str = ""          # seed | confirmed | same_face | likely | possible
    reasons: list[str] = field(default_factory=list)


def pick_track_at(points: dict[str, Sequence[tuple[dt.datetime, Sequence[int]]]], ts: dt.datetime,
                  x: float, y: float) -> str | None:
    """The track whose box (1 pt/s, 0-1000 grid) holds the clicked point closest
    in time to `ts`. A click just outside a box still counts (PICK_MARGIN)."""
    best: tuple[float, str] | None = None
    for tid, pts in points.items():
        for t, b in pts:
            gap = abs((t - ts).total_seconds())
            if gap > PICK_TIME_S:
                continue
            x1, y1, x2, y2 = b
            dx = max(x1 - x, 0, x - x2)
            dy = max(y1 - y, 0, y - y2)
            if dx > PICK_MARGIN or dy > PICK_MARGIN:
                continue
            # Inside beats near; then nearer in time; smaller boxes win ties (the person, not the crowd).
            cost = (dx + dy) * 10 + gap * 100 + ((x2 - x1) * (y2 - y1)) / 1e4
            if best is None or cost < best[0]:
                best = (cost, tid)
    return best[1] if best else None


def _colour(a: dict, key: str) -> str | None:
    v = (a or {}).get(key) or {}
    return v.get("value") if float(v.get("conf", 0) or 0) >= CONF_FOR_COLOUR else None


def _overlaps(a1: dt.datetime, a2: dt.datetime, b1: dt.datetime, b2: dt.datetime) -> bool:
    return a1 < b2 and b1 < a2


def rank(seed: Candidate, hits: Iterable[Candidate], reviews: dict[str, str]) -> list[Candidate]:
    """Score and label candidates for a seed. `reviews`: track_id → confirmed|rejected.
    Returns seed first, then the rest by time; rejected and implausible ones dropped."""
    out = [Candidate(**{**seed.__dict__, "score": 1.0, "status": "seed", "reasons": ["the person you picked"]})]
    for h in hits:
        if h.track_id == seed.track_id or reviews.get(h.track_id) == "rejected":
            continue
        same_cam = h.camera_id == seed.camera_id
        together = _overlaps(h.first_seen, h.last_seen, seed.first_seen, seed.last_seen)
        if same_cam and together:
            continue                                  # two people on one camera at once
        score, reasons = h.cosine, []
        if together:
            score -= SIMULTANEOUS
            reasons.append("seen at the same time on another camera")
        for key, label in (("top_colour", "top"), ("bottom_colour", "bottom"), ("vehicle_colour", "vehicle colour"),
                           ("vehicle_type", "vehicle type")):
            a, b = _colour(seed.attributes, key), _colour(h.attributes, key)
            if a and b:
                if a == b:
                    score += COLOUR_AGREE
                    reasons.append(f"same {label} ({a})" if label.startswith("vehicle") else f"same {label} colour ({a})")
                else:
                    score -= COLOUR_DISAGREE
                    reasons.append(f"different {label} ({b}, not {a})" if label.startswith("vehicle")
                                   else f"different {label} colour ({b}, not {a})")
        c = Candidate(**{**h.__dict__, "score": round(min(1.0, score), 4), "reasons": reasons})
        if reviews.get(h.track_id) == "confirmed":
            c.status = "confirmed"
        elif seed.person_id and h.person_id == seed.person_id:
            c.status = "same_face"
            c.reasons.insert(0, "same known face")
        elif score >= LIKELY:
            c.status = "likely"
        elif score >= POSSIBLE:
            c.status = "possible"
        else:
            continue
        out.append(c)
    head, rest = out[0], out[1:]
    rest.sort(key=lambda c: c.first_seen)
    return [head] + rest


def journey(ranked: Sequence[Candidate]) -> list[Candidate]:
    """What the person has accepted: the seed, confirmed sightings and same-face ones, by time."""
    return sorted((c for c in ranked if c.status in ("seed", "confirmed", "same_face")), key=lambda c: c.first_seen)


def route(stops: Sequence[Candidate], names: dict[str, str]) -> list[str]:
    """'Gate 3 → Lobby → Corridor': camera names in order, repeats collapsed."""
    out: list[str] = []
    for c in stops:
        n = names.get(c.camera_id) or c.camera_id
        if not out or out[-1] != n:
            out.append(n)
    return out
