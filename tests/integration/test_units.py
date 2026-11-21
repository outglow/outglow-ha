import importlib
import json
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest

from custom_components.outglow import plan_import, repairs
from custom_components.outglow.coordinator import OutglowCoordinator
from custom_components.outglow.engine import recording
from custom_components.outglow.engine.types import (
    Context,
    GlobalSettings,
    Header,
    Json,
    Label,
    LightEvent,
    Observation,
    Plan,
    Recommendation,
    Room,
    Settings,
)
from custom_components.outglow.errors import OutglowError
from custom_components.outglow.live import frame_delta
from custom_components.outglow.session import (
    SUGGEST_MARGIN,
    confusion,
    cross_validated,
    learned_model,
    predicted,
    summarise,
)
from custom_components.outglow.z2m import Z2MDevices, check_value, effects
from tests.integration.common import BULBS, bulb_state, devices_payload

FULL = {
    "t": 1.0,
    "status": "learning",
    "model_version": 0,
    "directions": [{"rx": "a", "tx": "b", "level": 1}],
    "pairs": [{"a": "a", "b": "b", "obs": 0}],
    "rooms": {"x": {"p": 0.1}},
    "veto": None,
    "gates": {"a": "open"},
    "trail": [],
    "illustrative_xy": {},
}


def test_delta_falls_back_to_full_when_anything_is_removed() -> None:
    assert frame_delta(FULL, {**FULL, "t": 2.0}) == {"t": 2.0}
    assert frame_delta(FULL, {**FULL, "directions": []}) is None
    assert frame_delta(FULL, {**FULL, "rooms": {}}) is None
    changed = frame_delta(FULL, {**FULL, "veto": {"kind": "common", "rx": None}, "gates": {"a": "closed"}})
    assert changed == {"t": 1.0, "veto": {"kind": "common", "rx": None}, "gates": {"a": "closed"}}


def test_import_prototype_layout_json() -> None:
    layout = {
        "layout": {
            "bulbs": [
                {"id": "one", "z2m": "Hall", "x": 6.0, "y": 3.0},
                {"id": "two", "ieee": "0x0000000000000004", "x": 3.5, "y": 5.5, "height": "lamp"},
                {"id": "bad", "x": 1.0},
            ],
            "rooms": {"hall": {"outline": [[5, 0], [7, 0], [7, 6], [5, 6]], "area": "hallway", "spin": 1}},
            "skip": [["Hall", "0x0000000000000004"], {"rx": "0x0000000000000004", "tx": "Hall", "reason": "noisy"}],
            "walls_erased": ["1,2"],
        }
    }
    plan, warnings = plan_import.parse("outglow_json", json.dumps(layout), BULBS)
    assert [b.ieee for b in plan.bulbs] == ["0x0000000000000003", "0x0000000000000004"]
    assert plan.bulbs[1].height == "lamp"
    assert plan.rooms[0].area_id == "hallway"
    assert [(e.rx, e.tx, e.reason) for e in plan.excluded_directions] == [
        ("0x0000000000000003", "0x0000000000000004", "imported"),
        ("0x0000000000000004", "0x0000000000000003", "noisy"),
    ]
    codes = [w["code"] for w in warnings]
    assert codes.count("dropped_field") == 2
    assert "unknown_bulb" in codes
    assert "bulb_outside_rooms" in codes


def test_import_rejects_garbage_and_flags_overlaps() -> None:
    with pytest.raises(OutglowError):
        plan_import.parse("outglow_json", "nope", {})
    with pytest.raises(OutglowError):
        plan_import.parse("mieszkanie_yaml", "- just a list", {})
    with pytest.raises(OutglowError):
        plan_import.parse("other", "", {})
    text = "rooms:\n  a:\n    outline: [[0,0],[4,0],[4,4],[0,4]]\n  b:\n    outline: [[1,1],[3,1],[3,3],[1,3]]\n"
    _plan, warnings = plan_import.parse("mieszkanie_yaml", text, {})
    assert {"code": "overlapping_rooms", "params": {"a": "a", "b": "b"}} in warnings


def test_import_puts_a_bulb_in_nested_rooms_in_the_smallest() -> None:
    text = (
        "rooms:\n  big:\n    outline: [[0,0],[10,0],[10,10],[0,10]]\n  small:\n    outline: [[2,2],[4,2],[4,4],[2,4]]\n"
        "bulbs:\n  - ieee: '0x0000000000000003'\n    at: [3, 3]\n"
    )
    plan, warnings = plan_import.parse("mieszkanie_yaml", text, {})
    assert plan_import.room_of((3, 3), plan.rooms) == "small"
    assert plan_import.bulb_room(plan.bulbs[0], plan.rooms) == "small"
    assert {"code": "room_without_bulb", "params": {"room": "big"}} in warnings


def test_import_warns_about_a_bulb_pinned_to_a_room_it_does_not_stand_in() -> None:
    text = (
        "rooms:\n  a:\n    outline: [[0,0],[4,0],[4,4],[0,4]]\n  b:\n    outline: [[4,0],[8,0],[8,4],[4,4]]\n"
        "bulbs:\n  - ieee: '0x0000000000000003'\n    at: [1, 1]\n    room: b\n"
        "  - ieee: '0x0000000000000004'\n    at: [5, 1]\n    room: b\n"
        "  - ieee: '0x0000000000000001'\n    at: [9, 9]\n    room: a\n"
    )
    plan, warnings = plan_import.parse("mieszkanie_yaml", text, {})
    pinned = [w for w in warnings if w["code"] == "bulb_pinned_elsewhere"]
    assert pinned == [
        {"code": "bulb_pinned_elsewhere", "params": {"ieee": "0x0000000000000003", "room": "b", "at": "a"}},
        {"code": "bulb_pinned_elsewhere", "params": {"ieee": "0x0000000000000001", "room": "a", "at": None}},
    ]
    assert plan_import.pinned_elsewhere(plan) == pinned


def test_effects_for_each_setting() -> None:
    devices = Z2MDevices()
    devices.update_devices(devices_payload(), 0.0)
    device = devices.get("0x0000000000000001")
    assert device is not None
    devices.update_state(device.ieee, bulb_state(device.ieee))

    def codes(setting: str, value: object) -> list[str]:
        typed, checked = check_value(setting, value)
        return [e["code"] for e in effects(devices, device, typed, checked)]

    assert codes("probes", 0) == ["stops_sensing"]
    assert codes("probes", 8) == ["more_radio_traffic"]
    assert codes("probes", 3) == []
    assert codes("sensing", True) == ["more_radio_traffic"]
    assert codes("auto_calibration", True) == ["overwrites_all_lines"]
    assert codes("auto_calibration", False) == []
    assert codes("self_tuning", True) == []
    assert codes("calibrate", "stop") == []
    assert devices.current(device, "calibrate") == "stop"
    assert devices.current(device, "auto_calibration") is False
    with pytest.raises(OutglowError):
        check_value("sensing", 1)
    with pytest.raises(OutglowError):
        check_value("calibrate", "go")


def test_learned_model_learns_from_session_labels() -> None:
    path = Path(__file__).resolve().parents[1] / "fixtures" / "recordings" / "flat3_v2.jsonl"
    records = list(recording.read(path.read_text().splitlines()))
    header = records[0]
    assert isinstance(header, Header)
    assert header.plan is not None
    raw = [r for r in records if isinstance(r, Observation | LightEvent | Context)]
    label = Label(t0=raw[0].t, t1=raw[-1].t, kind="room", room="living", activity="walk", source="wizard")
    learned = learned_model(header.plan, Settings(), None, raw, [label])
    assert learned is not None
    active = learned["active"]
    assert isinstance(active, dict)
    assert active["labels"] == {"wizard": 8}
    assert learned_model(header.plan, Settings(), None, [], [label]) is None
    matrix, accuracy = confusion(
        header.plan,
        Settings(),
        learned,
        raw,
        {"steps": [{"kind": "room", "room": "living", "activity": "walk", "t0": label.t0, "t1": label.t1}]},
    )
    assert sum(matrix[0]) == 20
    assert accuracy is not None


def _wizard_like(mode: str) -> tuple[Any, ...]:
    synth = importlib.import_module("tools.synth")
    records = list(recording.read(synth.recording.write(synth.simulate_physics("flat2", 3, 900.0))))
    header = records[0]
    assert isinstance(header, Header)
    assert header.plan is not None
    plan = replace(
        header.plan,
        rooms=(*header.plan.rooms, Room(id="store", name="Store", outline=((0, 4), (5, 4), (5, 6), (0, 6)))),
    )
    walks = [r for r in records if isinstance(r, Label) and r.t1 - r.t0 >= 20]
    labels = [replace(lb, source="wizard") for lb in walks]
    steps = [{"kind": "room", "room": lb.room, "activity": "walk", "t0": lb.t0, "t1": lb.t1} for lb in labels]
    raw = [r for r in records if isinstance(r, Observation | LightEvent | Context)]
    settings = Settings(global_=GlobalSettings(mode=mode))  # type: ignore[arg-type]
    return plan, settings, raw, {"steps": steps}, labels


def test_summary_in_rules_mode_scores_bayes_too() -> None:
    plan, settings, raw, session, labels = _wizard_like("rules")
    result = summarise(plan, settings, None, raw, session, labels)
    assert result["mode"] == "rules"
    assert result["matrix_after"] == result["matrix_before"]
    assert result["accuracy_after"] == result["accuracy_before"]
    bayes = result["bayes"]
    assert bayes is not None
    assert sum(map(sum, bayes["matrix_after"])) == sum(map(sum, bayes["matrix_before"])) > 0
    assert bayes["accuracy_after"] > result["accuracy_before"] + SUGGEST_MARGIN
    assert result["suggest_mode"] == "bayes"
    assert result["rooms_without_bulbs"] == ["store"]


def test_summary_in_bayes_mode_is_cross_validated() -> None:
    plan, settings, raw, session, labels = _wizard_like("bayes")
    result = summarise(plan, settings, None, raw, session, labels)
    assert result["mode"] == "bayes"
    assert result["bayes"] is None
    assert result["suggest_mode"] is None
    matrix, accuracy = cross_validated(plan, settings, None, raw, session, labels)
    assert (result["matrix_after"], result["accuracy_after"]) == (matrix, accuracy)
    assert sum(map(sum, matrix)) == sum(map(sum, result["matrix_before"]))
    learned = learned_model(plan, settings, None, raw, labels)
    _in_sample, fitted = confusion(plan, settings, learned, raw, session)
    assert accuracy is not None
    assert fitted is not None
    assert accuracy <= fitted


def test_summary_suggests_nothing_without_walks() -> None:
    plan, settings, raw, _session, _labels = _wizard_like("rules")
    result = summarise(plan, settings, None, raw, {"steps": []}, [])
    assert result["accuracy_before"] is None
    assert result["bayes"]["accuracy_after"] is None
    assert result["suggest_mode"] is None


def test_a_tie_between_rooms_recognises_no_room_whatever_their_order() -> None:
    both = {"a": 1.0, "b": 1.0}
    assert predicted(both, ["a", "b"]) == predicted(both, ["b", "a"]) == 2
    assert predicted({"a": 0.6, "b": 0.9}, ["a", "b"]) == 1
    assert predicted({"a": 0.4}, ["a", "b"]) == 2
    assert predicted({}, []) == 0


def test_summary_counts_the_empty_house_the_model_will_have_seen() -> None:
    plan, settings, raw, session, labels = _wizard_like("rules")
    assert summarise(plan, settings, None, raw, session, labels)["empty_house_hours"] == 0.0
    empty = Label(t0=0.0, t1=1806.0, kind="empty", source="wizard")
    still = Label(t0=0.0, t1=900.0, kind="empty", room="living", source="wizard")
    model: dict[str, Json] = {"active": {"empty_s": 1800.0}}
    result = summarise(plan, settings, model, raw, session, [*labels, empty, still])
    assert result["empty_house_hours"] == 1.0


def test_recommendation_repairs_name_the_room_and_mention_rules_only_for_rules() -> None:
    plan = Plan(rooms=(Room(id="room_4", name="Sypialnia", outline=((0, 0), (1, 0), (1, 1))),))
    recs = (
        Recommendation(id="no_bulbs:a", kind="no_bulbs", severity="warning", room="room_4", numbers={"crossing": 3.0}),
        Recommendation(id="no_bulbs:b", kind="no_bulbs", severity="warning", room="room_4", numbers={"crossing": 0.0}),
        Recommendation(id="weak_coverage:room_4", kind="weak_coverage", severity="warning", room="room_4"),
        Recommendation(id="more_empty_house", kind="more_empty_house", severity="warning"),
    )
    devices = SimpleNamespace(output="json", bridge_online=True, bulbs=list, devices_seen=None)
    c = SimpleNamespace(
        now=lambda: 0.0,
        devices=devices,
        panel_conflict=False,
        started=0.0,
        plan=plan,
        frame=None,
        last_quality=SimpleNamespace(recommendations=recs),
    )
    issues = repairs.wanted(cast(OutglowCoordinator, c))
    assert issues == {
        "recommendation_no_bulbs:a": ("recommendation_no_bulbs_rules", {"room": "Sypialnia"}),
        "recommendation_no_bulbs:b": ("recommendation_no_bulbs", {"room": "Sypialnia"}),
        "recommendation_weak_coverage:room_4": ("recommendation_weak_coverage", {"room": "Sypialnia"}),
        "recommendation_more_empty_house": ("recommendation_more_empty_house", {"room": "-"}),
    }
    root = Path(__file__).resolve().parents[2] / "custom_components" / "outglow"
    pl = json.loads((root / "translations" / "pl.json").read_text())["issues"]
    en = json.loads((root / "strings.json").read_text())["issues"]
    texts = {key: pl[key]["title"] + " " + pl[key]["description"] for key, _ in issues.values()}
    assert all(key in en for key in texts)
    assert (
        texts["recommendation_no_bulbs_rules"]
        .format(room="Sypialnia")
        .startswith("Pokój Sypialnia nie ma żarówek Ruch w pokoju Sypialnia widzą tylko linie")
    )
    assert "reguł" in texts["recommendation_no_bulbs_rules"]
    assert "reguł" not in texts["recommendation_no_bulbs"]
    assert pl["recommendation_weak_coverage"]["title"].format(room="Sypialnia") == "Pokój Sypialnia jest słabo pokryty"
