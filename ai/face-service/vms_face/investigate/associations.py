"""Associations (investigation phase 4): who was with whom.

Every indexed pass has its box once a second (track_points, 0-1000 grid).
Two passes on the same camera were *together* for the seconds in which
  * both were on screen within ALIGN_S of each other (nearest points), and
  * their box centres were within NEAR_HEIGHTS × the mean box height
    (people walking together are about a body-height apart or less).
Seconds closer than GAP_S are merged into one stretch; a companion needs at
least MIN_TOGETHER_S together. This is geometry on the index, not
recognition: "walked together · 3 min" is a lead to check on the footage.

Pure logic; the route (api/routes/investigate.py) does the I/O.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Sequence

ALIGN_S = 0.6        # 1 pt/s trails are at most 0.5 s out of phase; wider double-counts one point
NEAR_HEIGHTS = 1.5
MIN_TOGETHER_S = 3.0
GAP_S = 5.0

Point = tuple[dt.datetime, Sequence[int]]   # (ts, [x1, y1, x2, y2] on 0-1000)


@dataclass
class Together:
    track_id: str
    seconds: float
    first: dt.datetime
    last: dt.datetime
    closest: float          # smallest centre distance, in box heights


def _centre_h(b: Sequence[int]) -> tuple[float, float, float]:
    x1, y1, x2, y2 = b
    return (x1 + x2) / 2.0, (y1 + y2) / 2.0, max(1.0, float(y2 - y1))


def _near(a: Sequence[int], b: Sequence[int]) -> float | None:
    """Centre distance in mean box heights, or None when farther than NEAR_HEIGHTS."""
    ax, ay, ah = _centre_h(a)
    bx, by, bh = _centre_h(b)
    d = ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5 / ((ah + bh) / 2.0)
    return d if d <= NEAR_HEIGHTS else None


def together(seed: Sequence[Point], other: Sequence[Point]) -> tuple[float, dt.datetime | None, dt.datetime | None, float]:
    """(seconds together, first, last, closest) between two 1 pt/s tracks."""
    if not seed or not other:
        return 0.0, None, None, 0.0
    other = sorted(other, key=lambda p: p[0])
    near_ts: list[dt.datetime] = []
    closest = float("inf")
    j = 0
    for ts, box in sorted(seed, key=lambda p: p[0]):
        while j + 1 < len(other) and other[j + 1][0] <= ts:
            j += 1
        best = None
        for k in (j, j + 1):
            if 0 <= k < len(other) and abs((other[k][0] - ts).total_seconds()) <= ALIGN_S:
                d = _near(box, other[k][1])
                if d is not None and (best is None or d < best):
                    best = d
        if best is not None:
            near_ts.append(ts)
            closest = min(closest, best)
    if not near_ts:
        return 0.0, None, None, 0.0
    # Merge close seconds into stretches; count each stretch's span (+1 s for its last point).
    total = 0.0
    start = prev = near_ts[0]
    for ts in near_ts[1:]:
        if (ts - prev).total_seconds() > GAP_S:
            total += (prev - start).total_seconds() + 1.0
            start = ts
        prev = ts
    total += (prev - start).total_seconds() + 1.0
    return total, near_ts[0], near_ts[-1], closest


def companions(seed: Sequence[Point], others: dict[str, Sequence[Point]], *, min_s: float = MIN_TOGETHER_S) -> list[Together]:
    """Passes that were with the seed for at least `min_s`, longest first."""
    out = []
    for tid, pts in others.items():
        secs, first, last, closest = together(seed, pts)
        if secs >= min_s:
            out.append(Together(tid, round(secs, 1), first, last, round(closest, 2)))
    return sorted(out, key=lambda t: -t.seconds)
