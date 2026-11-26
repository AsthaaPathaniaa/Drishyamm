"""The VMS end of the contract, parsed by the service that has to read it.

WHY THIS FILE EXISTS

Every bug found in head count has been a BOUNDARY bug -- two correct
components disagreeing -- and a unit test on either side of a boundary cannot
see the boundary. Two that shipped:

  * a camera an operator ticked for counting was excluded by the VMS's master
    AI switch, so it counted nothing. The tick's tests passed. The selector's
    tests passed.
  * a zone saved into the camera registry was never applied by this detector.
    The editor's tests passed. ``test_zones.py`` passed.

Both were invisible to full-green suites on both sides, in two languages.

So this reads ``contracts/headcount-camera-row.json`` -- one camera row exactly
as ``GET /api/internal/headcount/cameras`` emits it -- and asserts THIS
service's own parsers accept it. ``backend/test/headcountChain.test.js`` reads
the same file and asserts the backend emits it. Rename a field on either side
and a test fails on the other.

Changing the contract file to make a test pass defeats the whole arrangement.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

CONTRACT_PATH = (
    Path(__file__).resolve().parents[3] / "contracts" / "headcount-camera-row.json"
)


def load_contract() -> dict:
    with CONTRACT_PATH.open(encoding="utf-8") as fh:
        return json.load(fh)


class ContractFileTest(unittest.TestCase):
    """The file is reachable and is what both sides think it is."""

    def test_the_contract_file_exists_where_both_sides_look(self):
        self.assertTrue(
            CONTRACT_PATH.is_file(),
            f"the VMS contract is missing from {CONTRACT_PATH}; the backend test "
            "reads the same path and will be failing too",
        )

    def test_it_carries_one_camera_and_what_to_expect_of_it(self):
        c = load_contract()
        self.assertIn("camera", c)
        self.assertIn("expect", c)
        self.assertEqual(c["expect"]["zoneCount"], 2)


class ZonesReachTheCounterTest(unittest.TestCase):
    """The half that decides whether a zone counts anybody.

    numpy only, so it runs anywhere -- including a machine with none of the
    service's heavy dependencies installed.
    """

    def setUp(self):
        self.contract = load_contract()
        self.headcount = self.contract["camera"]["settings"]["headcount"]

    def test_every_drawn_zone_is_parsed_none_silently_dropped(self):
        from headcount.zones import Zone

        drawn = self.headcount["zones"]
        parsed = [Zone.from_config(z) for z in drawn]
        self.assertEqual(
            [z.name for z in parsed if z],
            self.contract["expect"]["zoneNames"],
            "a zone the operator drew did not survive this parser -- which is "
            "exactly the drop that left a zone with no number on it",
        )

    def test_the_counter_is_ACTIVE_so_the_count_is_scoped_to_the_room(self):
        from headcount.zones import ZoneCounter

        counter = ZoneCounter.from_config({"zones": self.headcount["zones"]})
        self.assertTrue(
            counter.active,
            "the counter reports no zones, so the camera would count its whole "
            "view while the UI drew an outline claiming otherwise",
        )
        self.assertEqual(len(counter.zones), self.contract["expect"]["zoneCount"])

    def test_the_zone_ids_survive_so_the_breakdown_can_be_labelled(self):
        from headcount.zones import ZoneCounter

        counter = ZoneCounter.from_config({"zones": self.headcount["zones"]})
        self.assertEqual(
            [z.id for z in counter.zones],
            [z["id"] for z in self.headcount["zones"]],
        )

    def test_a_point_inside_the_drawn_room_is_inside_the_parsed_one(self):
        from headcount.zones import ZoneCounter

        counter = ZoneCounter.from_config({"zones": self.headcount["zones"]})
        reception = counter.zones[0]
        # Dead centre of the Reception polygon in the contract.
        self.assertTrue(reception.contains(0.5, 0.6))
        # Well above it, where the corridor would be.
        self.assertFalse(reception.contains(0.5, 0.05))

    def test_normalised_points_are_what_this_parser_expects(self):
        # The contract stores 0..1 pairs. If the VMS ever sent pixels, every
        # point would clamp to 1.0 and every zone would collapse -- so assert
        # the range rather than trusting it.
        for zone in self.headcount["zones"]:
            for x, y in zone["points"]:
                self.assertGreaterEqual(x, 0.0)
                self.assertLessEqual(x, 1.0)
                self.assertGreaterEqual(y, 0.0)
                self.assertLessEqual(y, 1.0)


class RegistryRowIsParsedTest(unittest.TestCase):
    """The half that decides whether the camera is opened at all.

    Needs ``headcount.config`` (pydantic), so it is skipped where the service's
    dependencies are not installed rather than failing there.
    """

    def setUp(self):
        self.contract = load_contract()
        try:
            from headcount.source import _to_streams  # noqa: F401
        except Exception as exc:                      # pragma: no cover
            self.skipTest(f"headcount.source unavailable: {exc}")

    def test_the_row_becomes_a_stream_the_service_will_open(self):
        from headcount.source import _to_streams

        streams = _to_streams([self.contract["camera"]], prefer_sub=True)
        self.assertEqual(
            len(streams), 1,
            "the camera the VMS says is counting was dropped by this parser",
        )
        self.assertEqual(streams[0].id, self.contract["camera"]["monitorId"])

    def test_the_zones_ride_along_into_the_stream_config(self):
        from headcount.source import _to_streams

        [stream] = _to_streams([self.contract["camera"]], prefer_sub=True)
        self.assertEqual(
            [z["name"] for z in stream.zones],
            self.contract["expect"]["zoneNames"],
            "the camera was opened but its zones were not carried -- the camera "
            "would count its whole view with an outline drawn over it",
        )

    def test_the_name_the_operator_knows_it_by_is_carried(self):
        from headcount.source import _to_streams

        [stream] = _to_streams([self.contract["camera"]], prefer_sub=True)
        self.assertEqual(stream.name, self.contract["camera"]["name"])

    def test_the_sub_stream_is_preferred_when_one_is_offered(self):
        from headcount.source import _to_streams

        [stream] = _to_streams([self.contract["camera"]], prefer_sub=True)
        self.assertEqual(stream.source, self.contract["camera"]["rtspSub"])

    def test_a_camera_with_no_sub_stream_falls_back_to_main(self):
        from headcount.source import _to_streams

        row = json.loads(json.dumps(self.contract["camera"]))
        row["rtspSub"] = None
        [stream] = _to_streams([row], prefer_sub=True)
        self.assertEqual(stream.source, self.contract["camera"]["rtsp"])

    def test_a_camera_the_vms_reports_offline_is_skipped(self):
        from headcount.source import _to_streams

        row = json.loads(json.dumps(self.contract["camera"]))
        row["status"] = "offline"
        self.assertEqual(_to_streams([row], prefer_sub=True), [])

    def test_the_config_this_builds_still_turns_the_zone_counter_on(self):
        # The end of the chain: registry row -> StreamConfig -> ZoneCounter.
        # This is the join the two earlier classes each see only one side of.
        from headcount.source import _to_streams
        from headcount.zones import ZoneCounter

        [stream] = _to_streams([self.contract["camera"]], prefer_sub=True)
        counter = ZoneCounter.from_config({"zones": list(stream.zones)})
        self.assertTrue(counter.active)
        self.assertEqual(
            [z.name for z in counter.zones],
            self.contract["expect"]["zoneNames"],
        )


if __name__ == "__main__":
    unittest.main()
