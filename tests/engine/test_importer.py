from engine import importer
from engine.types import ExcludedDirection
from tests.engine.helpers import B1, B2, B3

MIESZKANIE = {
    "scale_m_per_plan_px": 0.02,
    "rooms": {
        "living": {"name": "Living", "outline": [[0, 0], [4, 0], [4, 4], [0, 4]]},
        "hall": {"outline": [[4, 0], [6, 0], [6, 4], [4, 4]], "entrance": True},
        "nook": {"outline": [[1, 1], [2, 1], [2, 2]]},
        "broken": {"outline": [[0, 0], "x"]},
        "store": "nothing",
    },
    "adjacent": [["living", "hall"], ["living", "garage"], "bad"],
    "bulbs": [
        {"id": "a", "z2m": "Bulb A", "ieee": B1.upper().replace("0X", "0x"), "room": "living", "at": [1, 1]},
        {"id": "b", "ieee": B2, "at": [5, 2]},
        {"id": "c", "ieee": B3, "room": "garage", "at": [9, 9]},
        {"id": "d", "at": [1, 1]},
        {"z2m": "E", "ieee": "0x0000000000000005", "at": [1, True]},
        "junk",
    ],
}


def test_mieszkanie_import_with_warnings() -> None:
    imported = importer.from_mieszkanie(MIESZKANIE)
    plan = imported.plan
    assert [r.id for r in plan.rooms] == ["living", "hall", "nook"]
    assert plan.rooms[1].name == "hall"
    assert plan.rooms[1].entrance
    assert plan.adjacent == (("living", "hall"),)
    assert [(b.ieee, b.room) for b in plan.bulbs] == [(B1, "living"), (B2, None), (B3, None)]
    assert imported.names == {"Bulb A": B1, "b": B2, "c": B3}
    codes = [(w["code"], w["params"]) for w in imported.warnings]
    assert ("dropped_field", {"field": "scale_m_per_plan_px"}) in codes
    assert ("dropped_field", {"field": "rooms.broken.outline"}) in codes
    assert ("unknown_room", {"room": "['living', 'garage']"}) in codes
    assert ("unknown_room", {"room": "garage", "bulb": B3}) in codes
    assert ("unknown_bulb", {"name": "d"}) in codes
    assert ("unknown_bulb", {"name": "E"}) in codes
    assert ("bulb_outside_rooms", {"bulb": B3}) in codes
    assert ("dropped_field", {"field": "rooms.store.outline"}) in codes
    assert "overlapping_rooms" not in [code for code, _ in codes]


def test_mieszkanie_import_warns_about_rooms_that_overlap_in_part_only() -> None:
    rooms = {
        "ell": {"outline": [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]]},
        "corner": {"outline": [[1, 1], [4, 1], [4, 4], [1, 4]]},
        "closet": {"outline": [[0, 0], [1, 0], [1, 1], [0, 1]]},
        "porch": {"outline": [[3, 3], [6, 3], [6, 6], [3, 6]]},
    }
    warnings = importer.from_mieszkanie({"rooms": rooms}).warnings
    assert [w["params"] for w in warnings if w["code"] == "overlapping_rooms"] == [{"a": "corner", "b": "porch"}]


def test_layout_import_and_skip_list() -> None:
    imported = importer.from_layout(
        {"bulbs": [{"z2m": "A", "ieee": B1, "x": 1, "y": 2}], "view_rotation": 90, "walls_added": []}
    )
    assert imported.plan.view_rotation_deg == 90.0
    assert imported.plan.bulbs[0].x == 1.0
    assert [w["code"] for w in imported.warnings] == ["dropped_field", "bulb_outside_rooms"]
    assert importer.from_layout({"rooms": 5}).plan.bulbs == ()
    assert importer.from_mieszkanie({}).plan.rooms == ()
    lonely = importer.from_mieszkanie({"rooms": {"x": {"outline": [[0, 0], [1, 0], [1, 1]]}}})
    assert [w["code"] for w in lonely.warnings] == ["room_without_bulb"]
    assert importer.skip_directions([f"{B1}>{B2}", "nope", f">{B2}"]) == (
        ExcludedDirection(rx=B1, tx=B2, reason="imported"),
    )
