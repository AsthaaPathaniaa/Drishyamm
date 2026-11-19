"""Footfall: whose day "today" is, and not losing counts over a gate save.

Two fixes, both invisible until you look at a total and ask which hours it
covers:

  1. "Today" started at UTC midnight -- 05:30 IST -- so on an Indian site
     every crossing between midnight and half past five was filed under
     yesterday, and the operator's "today" was missing the night shift.
     api/routes/footfall._today_midnight now takes the caller's zone.

  2. Saving a gate replaced the camera's counter wholesale, dropping whatever
     had not reached Postgres yet (up to _FLUSH_INTERVAL_SEC of crossings).
     services/footfall.configure_camera now drains it first.

Run inside the ai container (no GPU, no Redis, no live Postgres needed):

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_footfall_day_and_flush -v
"""
from __future__ import annotations

import asyncio
import datetime as dt
import unittest
import uuid
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest import mock
from zoneinfo import ZoneInfo

from vms_face.api.routes import footfall as routes
from vms_face.services import footfall
from vms_face.services.footfall import FootfallConfig, FootfallRegistry

CAM = uuid.uuid4()
TENANT = uuid.uuid4()
IST = "Asia/Kolkata"


# ── 1. Whose day is "today"? ────────────────────────────────────────────


class _FrozenDatetime:
    """datetime.datetime with `now()` pinned, everything else untouched."""

    def __init__(self, instant: dt.datetime) -> None:
        self._instant = instant

    def __getattr__(self, name):            # .fromisoformat, .min, ...
        return getattr(dt.datetime, name)

    def now(self, tz=None):
        return self._instant if tz is None else self._instant.astimezone(tz)


def _frozen_dt_module(instant: dt.datetime):
    """A stand-in for the `datetime` MODULE, to be swapped in as the route
    module's own `dt` name.

    Patching `routes.dt.datetime` instead would reach through to the real
    datetime module -- the test module imported the same object -- and break
    the very constructors the assertions are written with. Replacing the name
    `dt` in the route's namespace keeps the fake where it belongs.
    """
    return SimpleNamespace(
        datetime=_FrozenDatetime(instant),
        timezone=dt.timezone,
        timedelta=dt.timedelta,
        date=dt.date,
    )


class TodayMidnightTest(unittest.TestCase):
    # 01:00 IST on 14 March = 19:30 UTC on 13 March. The crossing is in
    # "today" for the operator in India and in "yesterday" for UTC, which is
    # the entire bug.
    ONE_AM_IST = dt.datetime(2026, 3, 13, 19, 30, tzinfo=dt.timezone.utc)

    def _at(self, instant):
        patcher = mock.patch.object(routes, "dt", _frozen_dt_module(instant))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_no_tz_keeps_the_old_utc_day(self):
        self._at(self.ONE_AM_IST)
        self.assertEqual(
            routes._today_midnight(),
            dt.datetime(2026, 3, 13, 0, 0, tzinfo=dt.timezone.utc),
        )
        # Empty string and None are both "no opinion", not a broken zone.
        self.assertEqual(routes._today_midnight(""), routes._today_midnight())
        self.assertEqual(routes._today_midnight(None), routes._today_midnight())

    def test_a_1am_ist_crossing_falls_inside_the_ist_day(self):
        self._at(self.ONE_AM_IST)
        start = routes._today_midnight(IST)
        # Midnight IST on the 14th is 18:30 UTC on the 13th.
        self.assertEqual(start, dt.datetime(2026, 3, 13, 18, 30, tzinfo=dt.timezone.utc))
        # The bucket query is `bucket_minute >= start`: 01:00 IST is in.
        self.assertGreaterEqual(self.ONE_AM_IST, start)
        self.assertEqual(start.astimezone(ZoneInfo(IST)).hour, 0)
        self.assertEqual(start.astimezone(ZoneInfo(IST)).day, 14)
        # ...and under the old behaviour it was not: UTC midnight on the 13th
        # is a whole day earlier, so the total also swept up the 13th.
        self.assertLess(routes._today_midnight(), start)

    def test_the_ist_day_does_not_start_before_the_utc_one_in_the_afternoon(self):
        # 14:00 UTC = 19:30 IST, same date either way. IST midnight is then
        # EARLIER than UTC midnight, the opposite offset to the 01:00 case --
        # a sign error here would pass the test above and fail this one.
        self._at(dt.datetime(2026, 3, 13, 14, 0, tzinfo=dt.timezone.utc))
        self.assertEqual(
            routes._today_midnight(IST),
            dt.datetime(2026, 3, 12, 18, 30, tzinfo=dt.timezone.utc),
        )

    def test_a_zone_behind_utc(self):
        # 02:00 UTC on the 13th is still 21:00 on the 12th in New York, so
        # "today" there began at 04:00 UTC on the 12th.
        self._at(dt.datetime(2026, 3, 13, 2, 0, tzinfo=dt.timezone.utc))
        self.assertEqual(
            routes._today_midnight("America/New_York"),
            dt.datetime(2026, 3, 12, 4, 0, tzinfo=dt.timezone.utc),
        )

    def test_an_unusable_zone_falls_back_to_utc_instead_of_raising(self):
        # This endpoint feeds a dashboard's camera list. A nonsense zone, or a
        # container with no tz database, must not blank the page.
        self._at(self.ONE_AM_IST)
        utc = dt.datetime(2026, 3, 13, 0, 0, tzinfo=dt.timezone.utc)
        for bad in ("Mars/Olympus_Mons", "../etc/passwd", "Asia/Kolkatta", 42):
            with self.subTest(tz=bad):
                self.assertEqual(routes._today_midnight(bad), utc)

    def test_the_result_is_always_an_aware_utc_instant(self):
        # bucket_minute is timestamptz; a naive datetime would be compared
        # against it as if it were already UTC.
        self._at(self.ONE_AM_IST)
        for tz in (None, IST, "America/New_York", "nonsense"):
            with self.subTest(tz=tz):
                got = routes._today_midnight(tz)
                self.assertIsNotNone(got.tzinfo)
                self.assertEqual(got.utcoffset(), dt.timedelta(0))


# ── 2. A gate save must not eat the counts ──────────────────────────────


class _FakeSession:
    """Collects the UPSERTs a flush would send, with the values it bound."""

    def __init__(self, written: list[dict]) -> None:
        self._written = written
        self.commits = 0

    async def execute(self, stmt):
        self._written.append(dict(stmt.compile().params))

    async def commit(self):
        self.commits += 1


def patch_session(test, written: list[dict]) -> list[_FakeSession]:
    """Replace session_scope in the service with one that records writes."""
    sessions: list[_FakeSession] = []

    @asynccontextmanager
    async def fake_scope():
        s = _FakeSession(written)
        sessions.append(s)
        yield s

    patcher = mock.patch.object(footfall, "session_scope", fake_scope)
    patcher.start()
    test.addCleanup(patcher.stop)
    return sessions


def totals(written: list[dict]) -> tuple[int, int]:
    return (
        sum(w["in_count"] for w in written),
        sum(w["out_count"] for w in written),
    )


class ConfigureFlushTest(unittest.TestCase):
    """configure_camera is what both a gate save (PUT .../config) and an
    orchestrator start call, and it replaces the camera's counter."""

    def setUp(self):
        self.written: list[dict] = []
        self.sessions = patch_session(self, self.written)
        self.reg = FootfallRegistry()
        self.cfg = FootfallConfig.from_camera_config(
            {"footfall": {"enabled": True, "line": {"a": [0.1, 0.5], "b": [0.9, 0.5]}}},
        )
        asyncio.run(self.reg.configure_camera(CAM, TENANT, self.cfg))

    def _count(self, *, in_n: int = 0, out_n: int = 0, minute: int = 7) -> None:
        """Put counts straight into pending — the same place update() puts
        them — so this test is about the flush, not about the tracker."""
        bucket = dt.datetime(2026, 3, 13, 10, minute, tzinfo=dt.timezone.utc)
        st = self.reg._cameras[CAM]
        counts = st.pending.setdefault(bucket, {"in": 0, "out": 0, "falls": 0})
        counts["in"] += in_n
        counts["out"] += out_n

    def test_a_save_while_counting_loses_nothing(self):
        self._count(in_n=9, out_n=4)
        # The operator drags the line and saves. Before the fix this replaced
        # the state and those 13 crossings were gone.
        moved = FootfallConfig.from_camera_config(
            {"footfall": {"enabled": True, "line": {"a": [0.1, 0.7], "b": [0.9, 0.7]}}},
        )
        asyncio.run(self.reg.configure_camera(CAM, TENANT, moved))

        self.assertEqual(totals(self.written), (9, 4))
        written = self.written[0]
        self.assertEqual(written["camera_id"], CAM)
        self.assertEqual(written["tenant_id"], TENANT)
        self.assertEqual(self.sessions[0].commits, 1)
        # The new config is live, and the drained counts are not pending twice.
        self.assertEqual(self.reg.get_config(CAM).line, {"a": [0.1, 0.7], "b": [0.9, 0.7]})
        self.assertEqual(self.reg._cameras[CAM].pending, {})

    def test_counts_are_written_per_minute_not_merged(self):
        self._count(in_n=2, minute=58)
        self._count(in_n=5, minute=59)
        asyncio.run(self.reg.configure_camera(CAM, TENANT, self.cfg))
        self.assertEqual(len(self.written), 2)
        self.assertEqual(totals(self.written), (7, 0))
        self.assertEqual(
            sorted(w["bucket_minute"].minute for w in self.written), [58, 59],
        )

    def test_nothing_counted_yet_writes_nothing(self):
        asyncio.run(self.reg.configure_camera(CAM, TENANT, self.cfg))
        self.assertEqual(self.written, [])
        self.assertEqual(self.sessions, [])

    def test_a_first_configure_on_an_unknown_camera_writes_nothing(self):
        other = uuid.uuid4()
        asyncio.run(self.reg.configure_camera(other, TENANT, self.cfg))
        self.assertEqual(self.written, [])
        self.assertIsNotNone(self.reg.get_config(other))

    def test_the_tracks_are_still_discarded(self):
        # The point of rebuilding the state: a person half-way across the OLD
        # line must not be credited with crossing the new one.
        self.reg._cameras[CAM].tracks[1] = footfall._Track(x=1.0, y=2.0, last_seen=0.0, side=1)
        self._count(in_n=1)
        asyncio.run(self.reg.configure_camera(CAM, TENANT, self.cfg))
        self.assertEqual(self.reg._cameras[CAM].tracks, {})
        self.assertEqual(totals(self.written), (1, 0))    # ...but the count stayed

    def test_a_failed_flush_does_not_fail_the_save(self):
        # The config row is already committed by the time configure_camera
        # runs, so raising here would tell the operator "not saved" about a
        # gate that was saved.
        self._count(in_n=3)

        @asynccontextmanager
        async def exploding_scope():
            raise RuntimeError("postgres is away")
            yield  # pragma: no cover

        with mock.patch.object(footfall, "session_scope", exploding_scope):
            asyncio.run(self.reg.configure_camera(CAM, TENANT, self.cfg))
        self.assertIsNotNone(self.reg.get_config(CAM))

    def test_counting_through_a_save_keeps_both_halves(self):
        # End to end over the tracker itself: walk someone through, save the
        # gate mid-shift, walk another through, flush. Both must be in the DB.
        clock = Clock()
        with mock.patch.object(footfall.time, "monotonic", clock):
            reg = FootfallRegistry()
            line = {"enabled": True, "line": {"a": [0.1, 0.5], "b": [0.9, 0.5]},
                    "direction": "right_is_in"}
            cfg = FootfallConfig.from_camera_config({"footfall": line})
            asyncio.run(reg.configure_camera(CAM, TENANT, cfg))

            walk(reg, clock)                                     # one IN
            self.assertEqual(reg._cameras[CAM].live_in, 1)
            asyncio.run(reg.configure_camera(CAM, TENANT, cfg))  # the save
            walk(reg, clock)                                     # another IN
            asyncio.run(reg._flush_once())

        self.assertEqual(totals(self.written), (2, 0))


class Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


def walk(reg: FootfallRegistry, clock: Clock) -> None:
    """One person crossing a level line at y=0.5 downward (counts IN for
    right_is_in). Feet anchor, 1000x1000 frame — as test_footfall_line does."""
    for i in range(11):
        y = (0.3 + (0.7 - 0.3) * i / 10) * 1000
        reg.update(CAM, 1000, 1000, [(460.0, y - 200.0, 540.0, y, 0.9)], anchor="feet")
        clock.t += 0.2


if __name__ == "__main__":
    unittest.main()
