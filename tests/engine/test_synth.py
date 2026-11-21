import json
from pathlib import Path

import pytest

from engine import recording
from engine.types import Label, Observation
from tools import synth

ROOT = Path(__file__).resolve().parents[2]


def test_fixture_is_reproducible(capsys: pytest.CaptureFixture[str]) -> None:
    assert synth.main(["--duration", "12"]) == 0
    assert capsys.readouterr().out == (ROOT / "tests/fixtures/recordings/flat3_v2.jsonl").read_text()


def test_mock_data_is_reproducible(capsys: pytest.CaptureFixture[str]) -> None:
    assert synth.main(["--duration", "30", "--mock"]) == 0
    assert capsys.readouterr().out == (ROOT / "frontend/mock/data/flat3.json").read_text()


def test_frames_follow_the_walker(capsys: pytest.CaptureFixture[str]) -> None:
    assert synth.main(["--duration", "10", "--frames", "--seed", "3"]) == 0
    rows = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    frames = [r["frame"] for r in rows if r["type"] == "frame"]
    assert frames
    moving = [f for f in frames if any(room["motion"] for room in f["rooms"].values())]
    assert moving
    assert all(sum(room["motion"] for room in f["rooms"].values()) <= 1 for f in frames)


def test_physics_synth_has_all_templates(capsys: pytest.CaptureFixture[str]) -> None:
    assert sorted(synth.PHYSICS) == ["flat2", "lshape", "studio", "wings"]
    assert synth.main(["--physics", "--template", "studio", "--duration", "60", "--empty", "30"]) == 0
    records = list(recording.read(capsys.readouterr().out.splitlines()))
    assert any(isinstance(r, Observation) and r.source == "activity" for r in records)
    assert any(isinstance(r, Label) and r.kind == "empty" for r in records)
    assert synth.main(["--physics", "--duration", "10"]) == 0
