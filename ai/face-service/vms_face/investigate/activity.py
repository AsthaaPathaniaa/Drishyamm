"""Smart Skim (I-6): where the activity is on one camera's timeline.

From the index's track spans (first_seen..last_seen per person pass):
  * bins      — people on screen per bin (a density bar over the timeline);
  * segments  — merged busy stretches, padded a little, for "play only activity":
                the player jumps from the end of one to the start of the next.

A person spanning several bins counts in each (unlike activity_buckets, which
counts a pass once, in the minute it started). Pure logic, unit-tested.
"""
from __future__ import annotations

import datetime as dt
from typing import Iterable, Sequence

MAX_BINS = 1500
PAD_S = 3.0          # play a little before someone appears and after they leave
MERGE_GAP_S = 8.0    # busy stretches closer than this play as one

Span = tuple[dt.datetime, dt.datetime]


def bin_seconds(since: dt.datetime, until: dt.datetime, wanted: float | None = None) -> float:
    """Bin width: as asked, but never more than MAX_BINS bins, never under 1 s."""
    total = max(1.0, (until - since).total_seconds())
    return max(1.0, float(wanted or 0), total / MAX_BINS)


def bins(spans: Iterable[Span], since: dt.datetime, until: dt.datetime, width_s: float) -> list[int]:
    """People per bin: a span counts in every bin it overlaps."""
    n = max(1, int(((until - since).total_seconds() + width_s - 1e-9) // width_s))
    out = [0] * n
    for a, b in spans:
        if b < since or a > until:
            continue
        i0 = max(0, int((max(a, since) - since).total_seconds() // width_s))
        i1 = min(n - 1, int((min(b, until) - since).total_seconds() // width_s))
        for i in range(i0, i1 + 1):
            out[i] += 1
    return out


def segments(spans: Sequence[Span], *, pad_s: float = PAD_S, merge_gap_s: float = MERGE_GAP_S,
             since: dt.datetime | None = None, until: dt.datetime | None = None) -> list[Span]:
    """Busy stretches: spans padded by pad_s, merged when closer than merge_gap_s."""
    pad = dt.timedelta(seconds=pad_s)
    gap = dt.timedelta(seconds=merge_gap_s)
    padded = sorted((a - pad, b + pad) for a, b in spans)
    out: list[list[dt.datetime]] = []
    for a, b in padded:
        if out and a <= out[-1][1] + gap:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    res = []
    for a, b in out:
        if since is not None:
            a = max(a, since)
        if until is not None:
            b = min(b, until)
        if b > a:
            res.append((a, b))
    return res
