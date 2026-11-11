"""Places marked on the map by whoever is looking at it. The flight controller knows nothing of them.

They are kept here rather than in one browser, so every device sees the same ones and something other
than the page can refer to them by name. Changing them commands nothing, so it needs no execution.
"""
import json
import logging
import math
import os
import secrets
import tempfile
from pathlib import Path

log = logging.getLogger("dronestats")

MAX_MARKS = 200
MAX_NAME = 40


class BadMark(ValueError):
    """A mark that does not make sense. The argument says which part."""


def _place(lat, lon):
    for value, limit in ((lat, 90), (lon, 180)):
        if type(value) not in (int, float) or not math.isfinite(value) or abs(value) > limit:
            raise BadMark("place")
    return round(float(lat), 7), round(float(lon), 7)


def _name(name):
    if not isinstance(name, str) or not name.strip():
        raise BadMark("name")
    return name.strip()[:MAX_NAME]


class Marks:
    def __init__(self, path=None):
        self.path = Path(path) if path else None
        self.items = []
        if self.path and self.path.exists():
            try:
                self.items = [m for m in json.loads(self.path.read_text("utf-8")) if self._sound(m)][:MAX_MARKS]
            except (OSError, ValueError) as e:
                log.warning("marks not read: %s", e)

    @staticmethod
    def _sound(mark):
        try:
            _place(mark["lat"], mark["lon"])
            _name(mark["name"])
            return isinstance(mark["id"], str)
        except (KeyError, TypeError, BadMark):
            return False

    def _save(self):
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=self.path.parent, delete=False) as f:
                json.dump(self.items, f, ensure_ascii=False)
            os.replace(f.name, self.path)
        except OSError as e:
            log.warning("marks not saved: %s", e)

    def _find(self, mark_id):
        for mark in self.items:
            if mark["id"] == mark_id:
                return mark
        raise BadMark("id")

    def add(self, lat, lon, name):
        if len(self.items) >= MAX_MARKS:
            raise BadMark("full")
        lat, lon = _place(lat, lon)
        mark = {"id": secrets.token_hex(4), "lat": lat, "lon": lon, "name": _name(name)}
        self.items.append(mark)
        self._save()
        return mark

    def update(self, mark_id, **changes):
        mark = self._find(mark_id)
        fresh = dict(mark)
        if "lat" in changes or "lon" in changes:
            fresh["lat"], fresh["lon"] = _place(changes.get("lat", mark["lat"]), changes.get("lon", mark["lon"]))
        if "name" in changes:
            fresh["name"] = _name(changes["name"])
        mark.update(fresh)
        self._save()
        return mark

    def remove(self, mark_id):
        self.items.remove(self._find(mark_id))
        self._save()

    def apply(self, body):
        """One change as the page asks for it: {"op": "add" | "update" | "remove", ...}. Raises BadMark."""
        op = body.get("op")
        if op == "add":
            return self.add(body.get("lat"), body.get("lon"), body.get("name"))
        if op == "update":
            changes = {key: body[key] for key in ("lat", "lon", "name") if key in body}
            return self.update(body.get("id"), **changes)
        if op == "remove":
            self.remove(body.get("id"))
            return None
        raise BadMark("op")
