import json
from pathlib import Path

import pytest

from engine import recording, to_json
from engine.types import Header, Label, Observation
from tools import convert_recording, import_prototype, synth
from tools import eval as evaluation

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "recordings"
YAML = """# plan
scale: 0.02
rooms:
  living:
    name: 'Living room'
    outline:
    - [0, 0]
    - [4, 0]
    - [4, 4]
    - [0, 4]
  hall:
    name: "Hall # one"
    outline: [[4, 0], [6, 0], [6, 4], [4, 4]]
adjacent:
- [living, hall]
bulbs:
- id: one
  z2m: Bulb 1
  ieee: '0x0000000000000001'
  room: living
  at: [1, 1]
- id: two
  z2m: Bulb 2
  ieee: '0x0000000000000002'
  at: [5.5, 2e0]
flags:
  - true
  - ~
  -
    nested: yes
"""
ZONES = """
SKIP = [
    "0x0000000000000001>0x0000000000000002",
]
ZONE_RULES = {"hall": {"areas": ["Living room", "Nowhere"], "weak": ["0x0000000000000002"]}, "attic": {}, "living": 3}
OTHER = foo()
"""


def test_convert_v1_to_v2(capsys: pytest.CaptureFixture[str]) -> None:
    assert convert_recording.main([str(FIXTURES / "small_v1.jsonl")]) == 0
    lines = capsys.readouterr().out.splitlines()
    records = list(recording.read(lines))
    assert isinstance(records[0], Header)
    assert records[0].format == 2
    assert sum(isinstance(r, Observation) for r in records) == 4
    assert sum(isinstance(r, Label) for r in records) == 4


def test_convert_keeps_v2_and_empty_input() -> None:
    lines = (FIXTURES / "flat3_v2.jsonl").read_text().splitlines()
    out = list(convert_recording.convert(lines))
    assert len(out) == len(lines)
    assert json.loads(out[0])["plan"] == json.loads(lines[0])["plan"]
    assert list(convert_recording.convert([])) == []


def test_yaml_subset_and_import(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    data = import_prototype.load_yaml(YAML)
    assert isinstance(data, dict)
    assert data["rooms"]["hall"]["name"] == "Hall # one"
    assert data["bulbs"][1]["at"] == [5.5, 2.0]
    assert data["flags"] == [True, None, {"nested": "yes"}]
    path = tmp_path / "mieszkanie.yaml"
    path.write_text(YAML)
    zones = tmp_path / "zones.py"
    zones.write_text(ZONES)
    assert import_prototype.main([str(path), "--zones", str(zones)]) == 0
    out = json.loads(capsys.readouterr().out)
    assert [r["id"] for r in out["plan"]["rooms"]] == ["living", "hall"]
    assert out["plan"]["excluded_directions"][0]["tx"] == "0x0000000000000002"
    assert out["names"] == {"Bulb 1": "0x0000000000000001", "Bulb 2": "0x0000000000000002"}
    imported = import_prototype.load(path)
    skip, rules = import_prototype.zones_config(ZONES, imported.plan)
    assert skip == ("0x0000000000000001>0x0000000000000002",)
    assert rules.rooms["hall"].areas == frozenset({"living"})
    assert rules.default.kind == "receiver"
    layout = tmp_path / "layout.json"
    layout.write_text(json.dumps({"bulbs": [{"z2m": "A", "ieee": "0x0000000000000001", "x": 1, "y": 1}]}))
    assert import_prototype.load(layout).plan.bulbs[0].x == 1.0
    with pytest.raises(import_prototype.YamlError):
        import_prototype.load_yaml("a: 1\n    b: 2\n")
    with pytest.raises(import_prototype.YamlError):
        import_prototype.load_yaml("just text\n")
    listing = tmp_path / "list.yaml"
    listing.write_text("- 1\n")
    with pytest.raises(import_prototype.YamlError):
        import_prototype.load(listing)
    assert import_prototype.load_yaml("") is None


def test_eval_on_synthetic_and_recordings(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps(to_json(synth.TEMPLATES["flat3"])))
    out = tmp_path / "report.json"
    md = tmp_path / "report.md"
    args = [str(FIXTURES / "flat3_v2.jsonl"), "--plan", str(plan), "--json", str(out), "--markdown", str(md)]
    assert evaluation.main([*args, "--models", "B0", "B1", "engine", "no-learning"]) == 0
    report = json.loads(out.read_text())["recordings"]
    assert set(report["models"]) == {"B0", "B1", "engine", "no-learning"}
    assert "roc" in report["models"]["engine"]
    assert "| B1 |" in md.read_text()
    assert "## recordings" in capsys.readouterr().out
    assert evaluation.main(["--synthetic", "--duration", "240", "--models", "B1", "engine"]) == 0
    assert "synthetic wings" in capsys.readouterr().out
    assert evaluation.main([]) == 0
    assert capsys.readouterr().out == "{}\n"
