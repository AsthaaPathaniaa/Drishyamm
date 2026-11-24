"""Smart Search rule parser (English + Hindi) — pure, fixed clock.

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_investigate_query_parser -v
"""
from __future__ import annotations

import datetime as dt
import unittest
from zoneinfo import ZoneInfo

from vms_face.investigate.query_parser import parse

IST = ZoneInfo("Asia/Kolkata")
NOW = dt.datetime(2026, 11, 24, 18, 30, tzinfo=IST)        # Tue evening
CAMS = [("c-gate3", "GATE-03", "Gate 3"), ("c-lobby", "LOBBY-01", "Main Lobby"), ("c-gate", "GATE-01", "Gate")]


def p(q, now=NOW):
    return parse(q, now=now, tz=IST, cameras=CAMS)


def hm(t):
    return t.astimezone(IST).strftime("%Y-%m-%d %H:%M")


class EnglishTest(unittest.TestCase):
    def test_the_picture_example(self):
        r = p("man, red top, backpack, gate 3, 1-4 pm")
        self.assertEqual(r.object_class, "person")
        self.assertEqual(r.top_colour, "red")
        self.assertEqual(r.camera_ids, ["c-gate3"])
        self.assertEqual((hm(r.since), hm(r.until)), ("2026-11-24 13:00", "2026-11-24 16:00"))
        self.assertIn("backpack", r.text)
        self.assertIn("red top", r.text)
        self.assertNotIn("gate", r.text.lower())
        self.assertNotIn("pm", r.text.lower())
        self.assertEqual({c.kind for c in r.chips}, {"object_class", "top_colour", "camera", "time"})

    def test_bottom_colour_and_garment_words(self):
        r = p("woman in yellow kurta and blue jeans")
        self.assertEqual((r.top_colour, r.bottom_colour), ("yellow", "blue"))

    def test_bare_colour_is_the_top(self):
        self.assertEqual(p("someone in red with a helmet").top_colour, "red")

    def test_longest_camera_name_wins_and_codes_match(self):
        self.assertEqual(p("gate 3").camera_ids, ["c-gate3"])
        self.assertEqual(p("GATE-03 white shirt").camera_ids, ["c-gate3"])
        self.assertEqual(p("main lobby").camera_ids, ["c-lobby"])
        self.assertEqual(p("person at gate").camera_ids, ["c-gate"])

    def test_generic_words_and_glued_numbers_in_camera_names(self):
        cams = [("c-g2", "fe26", "Camera Gate2"), ("c-sup", "0eb5", "Camera Support")]
        self.assertEqual(parse("dark jacket, gate2", now=NOW, cameras=cams).camera_ids, ["c-g2"])
        self.assertEqual(parse("gate 2 red top", now=NOW, cameras=cams).camera_ids, ["c-g2"])
        self.assertEqual(parse("support camera", now=NOW, cameras=cams).camera_ids, ["c-sup"])
        self.assertEqual(parse("person", now=NOW, cameras=cams).camera_ids, [])

    def test_last_hour_without_a_number(self):
        r = p("dark jacket, last hour")
        self.assertEqual(hm(r.since), "2026-11-24 17:30")
        self.assertEqual(hm(p("past day").since), "2026-11-23 18:30")

    def test_future_time_today_means_yesterday(self):
        r = p("8-10 pm")
        self.assertEqual(hm(r.since), "2026-11-23 20:00")

    def test_yesterday_and_last_hours_and_last_night(self):
        r = p("yesterday after 6 pm")
        self.assertEqual((hm(r.since), hm(r.until)), ("2026-11-23 18:00", "2026-11-24 00:00"))
        r = p("last 2 hours")
        self.assertEqual(hm(r.since), "2026-11-24 16:30")
        r = p("last night white car")
        self.assertEqual((hm(r.since), hm(r.until)), ("2026-11-23 18:00", "2026-11-24 06:00"))
        self.assertEqual(r.object_class, "vehicle")

    def test_24h_range_and_at(self):
        r = p("13:00-16:00")
        self.assertEqual(hm(r.until), "2026-11-24 16:00")
        r = p("at 3 pm")
        self.assertEqual((hm(r.since), hm(r.until)), ("2026-11-24 14:30", "2026-11-24 15:30"))

    def test_morning(self):
        r = p("this morning")
        self.assertEqual((hm(r.since), hm(r.until)), ("2026-11-24 06:00", "2026-11-24 12:00"))

    def test_no_description_still_embeds_something(self):
        self.assertEqual(p("gate 3 yesterday").text, "a photo of a person")


class TimeZoneTest(unittest.TestCase):
    def test_old_browser_names_and_junk_never_fail(self):
        from vms_face.investigate.query_parser import zone

        ist = dt.timedelta(hours=5, minutes=30)
        for name in ("Asia/Calcutta", "Not/AZone", None):           # Chrome in India sends Asia/Calcutta
            self.assertEqual(NOW.astimezone(zone(name)).utcoffset(), ist, name)
        r = parse("red top 1-4 pm", now=NOW, tz="Asia/Calcutta")
        self.assertEqual(hm(r.since), "2026-11-24 13:00")


class HindiTest(unittest.TestCase):
    def test_hindi_colour_garment_person(self):
        r = p("लाल शर्ट वाला आदमी")
        self.assertEqual((r.object_class, r.top_colour), ("person", "red"))
        self.assertIn("लाल", r.text)               # SigLIP 2 reads Hindi directly

    def test_today_label_ends_now(self):
        self.assertEqual([c.label for c in p("आज").chips], ["Today 12:00 AM – 6:30 PM"])

    def test_hindi_time(self):
        r = p("कल रात नीली जींस")
        self.assertEqual(hm(r.since), "2026-11-23 18:00")
        self.assertEqual(r.bottom_colour, "blue")
        r = p("कल 2 से 4 बजे")
        self.assertEqual((hm(r.since), hm(r.until)), ("2026-11-23 02:00", "2026-11-23 04:00"))
        r = p("आज शाम")
        self.assertEqual((hm(r.since), hm(r.until)), ("2026-11-24 17:00", "2026-11-24 18:30"))


class ChipsTest(unittest.TestCase):
    def test_chips_serialise(self):
        d = p("red top gate 3 1-4 pm").to_dict()
        self.assertTrue(all(isinstance(c["label"], str) for c in d["chips"]))
        self.assertIsInstance(d["since"], str)


if __name__ == "__main__":
    unittest.main()
