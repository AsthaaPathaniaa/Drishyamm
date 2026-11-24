"""Rule-based Smart Search query parser (English + Hindi), no LLM, no network.

    "man, red top, backpack, gate 3, 1-4 pm"
      → chips:  Person · Red top · Gate 3 · 1:00 PM – 4:00 PM
      → text:   "a photo of a man, red top, backpack"   (embedded by SigLIP 2)

What becomes a filter:
  * time words → ``since`` / ``until`` (hard filter)
  * camera names / codes the tenant has → ``camera_ids`` (hard filter)
  * person / vehicle words → ``object_class`` (hard filter)
  * colours tied to a garment → ``top_colour`` / ``bottom_colour`` — a *soft*
    boost in ranking, never a hard filter: the colour heuristic is a guess.
Everything descriptive stays in the text, so "backpack", "helmet", "saree"
are found by the image embedding even without an attribute model.

The UI shows the chips and lets the user remove or edit them; the edited
chips come back as explicit filters and win over the parse.
"""
from __future__ import annotations

import datetime as dt
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Iterable, Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

COLOURS = {
    # English
    "black": "black", "white": "white", "grey": "grey", "gray": "grey", "red": "red", "maroon": "red",
    "orange": "orange", "yellow": "yellow", "green": "green", "blue": "blue", "navy": "navy",
    "purple": "purple", "violet": "purple", "pink": "pink", "brown": "brown", "beige": "beige", "cream": "beige",
    # Hindi (both gendered forms)
    "काला": "black", "काली": "black", "काले": "black", "सफेद": "white", "सफ़ेद": "white",
    "स्लेटी": "grey", "ग्रे": "grey", "लाल": "red", "नारंगी": "orange", "पीला": "yellow", "पीली": "yellow",
    "पीले": "yellow", "हरा": "green", "हरी": "green", "हरे": "green", "नीला": "blue", "नीली": "blue",
    "नीले": "blue", "बैंगनी": "purple", "गुलाबी": "pink", "भूरा": "brown", "भूरी": "brown", "भूरे": "brown",
}
TOP_WORDS = {
    "top", "shirt", "tshirt", "t-shirt", "tee", "jacket", "hoodie", "sweater", "kurta", "kurti", "blouse",
    "coat", "uniform", "vest", "jersey",
    "शर्ट", "कमीज", "कमीज़", "टॉप", "कुर्ता", "कुर्ती", "जैकेट", "टी-शर्ट", "स्वेटर",
}
BOTTOM_WORDS = {
    "pants", "pant", "trousers", "jeans", "shorts", "skirt", "lower", "track", "trackpants", "salwar", "leggings",
    "पैंट", "पेंट", "जींस", "सलवार", "निक्कर", "स्कर्ट",
}
PERSON_WORDS = {
    "man", "men", "woman", "women", "person", "people", "boy", "girl", "guy", "lady", "child", "kid", "someone",
    "आदमी", "औरत", "महिला", "व्यक्ति", "लड़का", "लड़की", "लडका", "लडकी", "बच्चा", "बच्ची", "इंसान",
}
VEHICLE_WORDS = {
    "car": "vehicle", "suv": "vehicle", "van": "vehicle", "vehicle": "vehicle", "bike": "vehicle",
    "motorcycle": "vehicle", "scooter": "vehicle", "truck": "vehicle", "bus": "vehicle", "auto": "vehicle",
    "rickshaw": "vehicle", "tempo": "vehicle", "कार": "vehicle", "गाड़ी": "vehicle", "गाडी": "vehicle",
    "बाइक": "vehicle", "स्कूटर": "vehicle", "ट्रक": "vehicle", "बस": "vehicle", "ऑटो": "vehicle",
}
# Vehicle words → the type the index stores (COCO classes). Auto-rickshaws and
# tempos aren't COCO classes, so they only make it a vehicle search.
VEHICLE_TYPES = {
    "car": "car", "suv": "car", "van": "car", "jeep": "car", "sedan": "car", "taxi": "car", "कार": "car",
    "bike": "motorcycle", "motorcycle": "motorcycle", "motorbike": "motorcycle", "scooter": "motorcycle",
    "scooty": "motorcycle", "बाइक": "motorcycle", "स्कूटर": "motorcycle",
    "bus": "bus", "बस": "bus", "truck": "truck", "lorry": "truck", "ट्रक": "truck",
    "cycle": "bicycle", "bicycle": "bicycle", "साइकिल": "bicycle",
}
GENERIC_CAMERA_WORDS = {"camera", "cam", "cctv", "ch", "channel", "ipc", "nvr", "कैमरा"}
STOP_WORDS = {
    "a", "an", "the", "in", "with", "wearing", "and", "of", "at", "on", "near", "from", "to", "between",
    "camera", "cam", "who", "was", "is", "seen", "find", "show", "me", "any", "all",
    "में", "का", "की", "के", "वाला", "वाली", "वाले", "और", "पर", "से", "तक", "पहने", "पहना", "पहनी",
}

AM_PM = r"(am|pm|a\.m\.|p\.m\.)"
_TIME = r"(\d{1,2})(?:[:.](\d{2}))?\s*" + AM_PM + r"?"


@dataclass
class Chip:
    kind: str          # time | camera | object_class | top_colour | bottom_colour
    label: str
    value: object


@dataclass
class ParsedQuery:
    text: str                                  # what gets embedded
    object_class: str | None = None
    top_colour: str | None = None
    bottom_colour: str | None = None
    vehicle_type: str | None = None
    vehicle_colour: str | None = None
    camera_ids: list[str] = field(default_factory=list)
    since: dt.datetime | None = None
    until: dt.datetime | None = None
    chips: list[Chip] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "object_class": self.object_class,
            "top_colour": self.top_colour,
            "bottom_colour": self.bottom_colour,
            "vehicle_type": self.vehicle_type,
            "vehicle_colour": self.vehicle_colour,
            "camera_ids": self.camera_ids,
            "since": self.since.isoformat() if self.since else None,
            "until": self.until.isoformat() if self.until else None,
            "chips": [{"kind": c.kind, "label": c.label, "value": _json(c.value)} for c in self.chips],
        }


def _json(v):
    if isinstance(v, dt.datetime):
        return v.isoformat()
    if isinstance(v, (list, tuple)):
        return [_json(x) for x in v]
    return v


# Old IANA names browsers still report (Chrome in India says "Asia/Calcutta").
# The container's zoneinfo lacks the "backward" links, so map the common ones.
TZ_ALIASES = {
    "Asia/Calcutta": "Asia/Kolkata", "Asia/Katmandu": "Asia/Kathmandu", "Asia/Rangoon": "Asia/Yangon",
    "Asia/Saigon": "Asia/Ho_Chi_Minh", "Asia/Dacca": "Asia/Dhaka", "Asia/Thimbu": "Asia/Thimphu",
    "US/Eastern": "America/New_York", "US/Central": "America/Chicago", "US/Mountain": "America/Denver",
    "US/Pacific": "America/Los_Angeles", "GB": "Europe/London", "UTC": "UTC", "Etc/UTC": "UTC",
}
DEFAULT_TZ = "Asia/Kolkata"


def zone(name: str | None) -> ZoneInfo:
    """The viewer's time zone. Unknown or old names never fail a search: an
    alias is mapped, anything else falls back to India time."""
    for key in (name, TZ_ALIASES.get(name or ""), DEFAULT_TZ):
        if not key:
            continue
        try:
            return ZoneInfo(key)
        except (ZoneInfoNotFoundError, ValueError, KeyError):
            continue
    return ZoneInfo("UTC")


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFC", s.lower())
    s = re.sub(r"[^\wऀ-ॿ]+", " ", s)
    s = re.sub(r"(?<=[a-z\u0900-\u097f])(?=\d)|(?<=\d)(?=[a-z])", " ", s)   # "gate2" == "gate 2"
    s = re.sub(r"\b0+(\d)", r"\1", s)                 # "gate 03" == "gate 3"
    return re.sub(r"\s+", " ", s).strip()


def _hour(h: int, m: int, ampm: str | None, hint: str | None) -> tuple[int, int]:
    ap = (ampm or hint or "").replace(".", "")
    if ap == "pm" and h < 12:
        h += 12
    if ap == "am" and h == 12:
        h = 0
    return h % 24, m


def _fmt(t: dt.datetime) -> str:
    return t.strftime("%I:%M %p").lstrip("0")


class _Text:
    """The query with spans cut out as they are consumed."""

    def __init__(self, q: str) -> None:
        self.s = q

    def take(self, pattern: str, flags=re.I):
        m = re.search(pattern, self.s, flags)
        if m:
            self.s = self.s[: m.start()] + " , " + self.s[m.end():]
        return m


def parse(
    q: str,
    *,
    now: dt.datetime,
    tz: ZoneInfo | str = "Asia/Kolkata",
    cameras: Iterable[tuple[str, str | None, str | None]] = (),
) -> ParsedQuery:
    """Parse a description. ``cameras``: (camera_id, code, name) of the tenant."""
    tz = zone(tz) if isinstance(tz, str) or tz is None else tz
    now = now.astimezone(tz)
    t = _Text(unicodedata.normalize("NFC", q or ""))
    out = ParsedQuery(text="")

    _parse_time(t, now, out)
    _parse_cameras(t, cameras, out)

    # Words that remain, in order, for colour/garment/class tagging.
    words = [w for w in re.split(r"[\s,;।]+", t.s) if w]
    lower = [w.lower().strip(".!?\"'()") for w in words]
    pending_colour: str | None = None
    for i, w in enumerate(lower):
        if w in COLOURS:
            pending_colour = COLOURS[w]
            nxt = lower[i + 1] if i + 1 < len(lower) else ""
            prev = lower[i - 1] if i else ""
            if nxt in BOTTOM_WORDS or prev in BOTTOM_WORDS:
                out.bottom_colour = out.bottom_colour or pending_colour
                pending_colour = None
            elif nxt in TOP_WORDS or prev in TOP_WORDS:
                out.top_colour = out.top_colour or pending_colour
                pending_colour = None
        elif w in PERSON_WORDS and not out.object_class:
            out.object_class = "person"
        elif w in VEHICLE_WORDS or w in VEHICLE_TYPES:
            out.object_class = "vehicle"
            out.vehicle_type = out.vehicle_type or VEHICLE_TYPES.get(w)
    if pending_colour:            # "red, backpack": a bare colour describes the top / vehicle
        if out.object_class == "vehicle":
            out.vehicle_colour = pending_colour
        elif not out.top_colour:
            out.top_colour = pending_colour
    if out.object_class is None and (out.top_colour or out.bottom_colour or any(w in TOP_WORDS | BOTTOM_WORDS for w in lower)):
        out.object_class = "person"

    if out.object_class:
        out.chips.insert(0, Chip("object_class", out.object_class.capitalize(), out.object_class))
    if out.top_colour:
        out.chips.append(Chip("top_colour", f"{out.top_colour.capitalize()} top", out.top_colour))
    if out.bottom_colour:
        out.chips.append(Chip("bottom_colour", f"{out.bottom_colour.capitalize()} bottom", out.bottom_colour))
    if out.vehicle_type:
        out.chips.append(Chip("vehicle_type", out.vehicle_type.capitalize(), out.vehicle_type))
    if out.vehicle_colour:
        out.chips.append(Chip("vehicle_colour", f"{out.vehicle_colour.capitalize()} vehicle", out.vehicle_colour))

    # Embed the person's own words (SigLIP reads sentences): only the time and
    # camera phrases are cut out, plus filler left dangling where they were.
    text = re.sub(r"\s*,(\s*,)+", ",", t.s)
    text = re.sub(r"\s+", " ", text).strip(" ,;।")
    text = re.sub(r"(?i)\b(at|on|in|from|near|between|camera|cam)\s*(,|$)", r"\2", text).strip(" ,;।")
    if not any(lw not in STOP_WORDS for lw in lower):
        text = ""
    if not text:
        text = {"vehicle": "a vehicle"}.get(out.object_class or "", "a person")
    if re.match(r"(?i)^(a|an) (photo|picture)", text):
        out.text = text
    elif re.match(r"(?i)^(a|an|the|some|someone|somebody|anyone|people|men|women|two|three)\b", text) or not re.match(r"[a-z]", text, re.I):
        out.text = f"a photo of {text}"
    else:
        out.text = f"a photo of a {text}"
    return out


def _parse_cameras(t: _Text, cameras: Iterable[tuple[str, str | None, str | None]], out: ParsedQuery) -> None:
    forms: list[tuple[str, str, str]] = []           # (normalised form, camera_id, label)
    for cid, code, name in cameras:
        for raw in (name, code):
            if raw and len(_norm(raw)) >= 2:
                forms.append((_norm(raw), str(cid), name or code or str(cid)))
        # "Camera Gate2" is also just "gate 2": drop generic words people leave out.
        if name:
            short = " ".join(w for w in _norm(name).split() if w not in GENERIC_CAMERA_WORDS)
            if len(short) >= 3 and not short.replace(" ", "").isdigit() and short != _norm(name):
                forms.append((short, str(cid), name))
    forms.sort(key=lambda f: -len(f[0]))             # longest first: "gate 3 exit" before "gate 3"
    for form, cid, label in forms:
        if cid in out.camera_ids:
            continue
        # Match on whole words, tolerant to spacing/punctuation/leading zeros.
        pattern = r"(?<![\wऀ-ॿ])" + r"[\s\-_]*0*".join(re.escape(p) for p in form.split(" ")) + r"(?![\wऀ-ॿ])"
        if t.take(pattern):
            out.camera_ids.append(cid)
            out.chips.append(Chip("camera", label, cid))


def _day_start(d: dt.datetime) -> dt.datetime:
    return d.replace(hour=0, minute=0, second=0, microsecond=0)


def _parse_time(t: _Text, now: dt.datetime, out: ParsedQuery) -> None:
    day: dt.datetime | None = None
    since = until = None
    label_day = ""

    # "last 2 hours", "past 30 min", "पिछले 2 घंटे"
    m = t.take(r"(?:last|past|पिछले|पिछली)\s+(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|days?|घंटे|घंटा|मिनट|दिन)\b")
    if m:
        n, unit = int(m.group(1)), m.group(2).lower()
        delta = (dt.timedelta(hours=n) if unit[0] in "hघ" else dt.timedelta(days=n) if unit[0] in "dद"
                 else dt.timedelta(minutes=n))
        out.since, out.until = now - delta, now
        out.chips.append(Chip("time", f"Last {m.group(1)} {m.group(2)}", [out.since, out.until]))
        return

    m = t.take(r"(?:last|past|पिछले|पिछली|पिछला)\s+(hour|minute|min|day|week|घंटे|घंटा|मिनट|दिन|हफ्ते)\b")
    if m:
        unit = m.group(1).lower()
        delta = {"h": dt.timedelta(hours=1), "घ": dt.timedelta(hours=1), "d": dt.timedelta(days=1), "द": dt.timedelta(days=1),
                 "w": dt.timedelta(days=7), "ह": dt.timedelta(days=7)}.get(unit[0], dt.timedelta(minutes=1))
        out.since, out.until = now - delta, now
        out.chips.append(Chip("time", f"Last {unit}", [out.since, out.until]))
        return

    if t.take(r"\blast night\b|\bकल रात\b"):
        y = _day_start(now) - dt.timedelta(days=1)
        out.since, out.until = y.replace(hour=18), _day_start(now).replace(hour=6)
        out.chips.append(Chip("time", "Last night", [out.since, out.until]))
        return

    if t.take(r"\byesterday\b|(?<!\S)कल(?!\S)"):
        day, label_day = _day_start(now) - dt.timedelta(days=1), "Yesterday "
    elif t.take(r"\btoday\b|(?<!\S)आज(?!\S)"):
        day, label_day = _day_start(now), "Today "
    else:
        m = t.take(r"\b(\d{4})-(\d{2})-(\d{2})\b")
        if m:
            day = now.replace(year=int(m.group(1)), month=int(m.group(2)), day=int(m.group(3)), hour=0, minute=0,
                              second=0, microsecond=0)
        else:
            m = t.take(r"\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b")
            if m:
                mon = "janfebmaraprmayjunjulaugsepoctnovdec".index(m.group(2).lower()) // 3 + 1
                day = _day_start(now).replace(month=mon, day=int(m.group(1)))
                if day > now:
                    day = day.replace(year=day.year - 1)
        if day is not None:
            label_day = day.strftime("%d %b ")

    # Part of day: "morning", "evening", "सुबह", "शाम", "रात", "दोपहर"
    parts = {r"\bmorning\b|सुबह": (6, 12), r"\bafternoon\b|दोपहर": (12, 17), r"\bevening\b|शाम": (17, 21),
             r"\bnight\b|(?<!\S)रात(?!\S)": (21, 30)}
    hint = None
    for pat, (h1, h2) in parts.items():
        if t.take(pat):
            base = day or _day_start(now)
            since, until = base + dt.timedelta(hours=h1), base + dt.timedelta(hours=h2)
            hint = "pm" if h1 >= 12 else "am"
            break

    # Ranges: "1-4 pm", "1 to 4pm", "13:00-16:00", "between 1 and 4 pm", "1 से 4 बजे"
    m = t.take(r"(?:between\s+)?" + _TIME + r"\s*(?:-|–|to|and|till|until|से)\s*" + _TIME + r"(?:\s*बजे)?")
    if m:
        h1, m1, ap1, h2, m2, ap2 = m.groups()
        base = day or _day_start(now)
        e = _hour(int(h2), int(m2 or 0), ap2, hint)
        s = _hour(int(h1), int(m1 or 0), ap1 or (ap2 if int(h1) <= int(h2) else None), hint)
        since, until = base.replace(hour=s[0], minute=s[1]), base.replace(hour=e[0], minute=e[1])
        if until <= since:
            until += dt.timedelta(days=1)
    else:
        m = t.take(r"\b(after|since|before|by|around|at)\s+" + _TIME + r"|" + _TIME + r"\s*बजे\s*(के बाद|से पहले)?")
        if m:
            g = m.groups()
            word = (g[0] or ("after" if g[7] == "के बाद" else "before" if g[7] else "at")).lower()
            hh, mm, ap = (g[1], g[2], g[3]) if g[1] else (g[4], g[5], g[6])
            base = day or _day_start(now)
            h, mi = _hour(int(hh), int(mm or 0), ap, hint)
            at = base.replace(hour=h, minute=mi)
            if word in ("after", "since"):
                since, until = at, base + dt.timedelta(days=1)
            elif word in ("before", "by"):
                since, until = base, at
            else:
                since, until = at - dt.timedelta(minutes=30), at + dt.timedelta(minutes=30)

    if since is None and day is not None:
        since, until = day, day + dt.timedelta(days=1)
    if since is None:
        return
    if day is None and since > now:            # "2-4 pm" said at 11 am means yesterday
        since -= dt.timedelta(days=1)
        until -= dt.timedelta(days=1)
        label_day = "Yesterday "
    out.since, out.until = since, min(until, max(now, since))
    until = out.until           # the label says what is searched: "today" ends now, not at midnight
    label = f"{label_day}{_fmt(since)} – {_fmt(until)}" if since.date() == (until - dt.timedelta(seconds=1)).date() \
        else f"{label_day}{since:%d %b} {_fmt(since)} – {until:%d %b} {_fmt(until)}"
    out.chips.append(Chip("time", label.strip(), [out.since, out.until]))
