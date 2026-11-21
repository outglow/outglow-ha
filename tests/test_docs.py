import json
import shutil
from pathlib import Path

import pytest

from tools import docs

ROOT = Path(__file__).resolve().parent.parent


def test_readme_is_up_to_date() -> None:
    assert docs.main(["--check"]) == 0


def test_every_entity_platform_is_documented() -> None:
    found = docs.entities()
    keys = {e.key for e in found}
    assert keys == set(docs.ENTITY_NOTES)
    occupancy = next(e for e in found if e.key == "occupancy")
    assert occupancy.per_room
    assert occupancy.entity_id == "binary_sensor.outglow_room_<room>_occupancy"
    assert "probability" in occupancy.attributes
    assert next(e for e in found if e.key == "sensing").entity_id == "switch.outglow_sensing"
    assert next(e for e in found if e.key == "hold_time").states == ("10-3600 s",)


def test_markers_must_match_the_sections() -> None:
    generated = {"one": lambda: "fresh\n"}
    text = "a\n<!-- generated:one -->\nold\n<!-- /generated:one -->\nb\n"
    assert docs.render(text, generated) == "a\n<!-- generated:one -->\nfresh\n<!-- /generated:one -->\nb\n"
    with pytest.raises(docs.DocsError, match="missing"):
        docs.render("nothing here", generated)
    with pytest.raises(docs.DocsError, match="unknown"):
        docs.render(text + "<!-- generated:two -->\n<!-- /generated:two -->\n", generated)


def test_a_new_entity_without_a_description_fails(tmp_path: Path) -> None:
    integration = tmp_path / "custom_components" / "outglow"
    shutil.copytree(ROOT / "custom_components" / "outglow", integration, ignore=shutil.ignore_patterns("frontend"))
    button = integration / "button.py"
    button.write_text(button.read_text().replace('"delete_motion_history"', '"something_new"'))
    strings = json.loads((integration / "strings.json").read_text())
    with pytest.raises(docs.DocsError, match="something_new"):
        docs.render_entities(docs.entities(integration), strings)


def test_settings_follow_the_schema() -> None:
    schema = json.loads((ROOT / "docs" / "schemas" / "settings.json").read_text())
    rows = {path: (values, default) for path, values, default, _ in docs.setting_rows(schema)}
    assert rows["rooms.<room>.hold_time_s"] == ("integer 10-3600", "`60`")
    assert rows["global.retention.raw_h"] == ("integer ≥ 1", "`48`")
    assert rows["global.persons"][1] == "`[]`"
    schema["$defs"]["GlobalSettings"]["properties"]["brand_new"] = {"type": "boolean"}
    with pytest.raises(docs.DocsError, match="brand_new"):
        docs.render_settings(schema)


def test_card_options_come_from_the_interface() -> None:
    source = (ROOT / "frontend" / "src" / "outglow-cards.ts").read_text()
    table = docs.render_card(source)
    assert "| `show_heat` | `boolean` | `true` |" in table
    assert "| `type` | `string` | required |" in table
    with pytest.raises(docs.DocsError, match="extra"):
        docs.render_card(source.replace("  height?: number;", "  height?: number;\n  extra?: string;"))
    with pytest.raises(docs.DocsError, match="CardConfig"):
        docs.render_card("")


def test_images_and_help_links_are_checked(tmp_path: Path) -> None:
    (tmp_path / "docs" / "images").mkdir(parents=True)
    (tmp_path / "docs" / "images" / "used.png").write_bytes(b"")
    (tmp_path / "docs" / "images" / "orphan.png").write_bytes(b"")
    (tmp_path / "frontend" / "src").mkdir(parents=True)
    (tmp_path / "frontend" / "src" / "help.ts").write_text(
        'export const HELP = { live: "#live", plan: "#plan-editor" };\n'
    )
    text = "## Live\n![a](docs/images/used.png) ![b](docs/images/missing.png)\n"
    assert docs.problems(text, tmp_path) == [
        "README points to a missing image: docs/images/missing.png",
        "image not used by the README: docs/images/orphan.png",
        "panel help points to a missing README section: #plan-editor",
    ]


def test_headings_become_github_anchors() -> None:
    assert docs.anchors("## Troubleshooting and FAQ\n### 1. Add the integration\n## Actions (services)\n") == {
        "troubleshooting-and-faq",
        "1-add-the-integration",
        "actions-services",
    }
