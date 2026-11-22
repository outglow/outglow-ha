# Outglow for Home Assistant: architecture

How the integration turns the motion reports of Outglow bulbs into room presence, and why it is built this way. The
section numbers are stable: the JSON schemas and the code refer to them (for example *architecture.md 4.1*). Decisions
are numbered D1, D2… in [section 14](#14-decisions). Numbers called *measured in a test home* come from recordings
in one home; they explain choices and are not promises.

## 0. In short

The `outglow` custom integration reads the reports of Outglow bulbs from Zigbee2MQTT and turns them into **presence per
room**, plus a sidebar panel: a floor plan, a live motion map, a guided learning session for a phone, a quality screen
with recommendations and a timeline. **The host decides, not the bulb.** The firmware is a sensitive *gate* and the
source of activity levels per radio line; the integration does what a bulb cannot: agreement of both directions, a veto
against interference that hits many lines at once, *explaining away* (a line through a wall lit by motion in the
living room does not light up the hall), and learning from labels and corrections.

The pipeline in one line: `motion_links` → normalisation (gate, blanking after light changes, frozen lines) →
**CFAR on the host** per direction (threshold from the distribution of quiet, learnt while the home is empty) →
pair observation {quiet, one-sided, two-sided} → **common veto** → **factorial room model with noisy-OR emission**
(explaining away) → per-room temporal filter with adjacency and hysteresis → a `binary_sensor` per room. Emission
parameters start from the plan's geometry and from radio physics, then learn from the wizard, empty-home periods and
corrections.

## 1. Goals and non-goals

**Goals**

1. Presence per room that by default gives **at most one false alarm per room per day** and detects ≥ 85 % of room
   entries with a median delay ≤ 2 s. These are targets checked on recordings (section 8).
2. Works in other homes: 2 to about 30 bulbs, 1 to about 12 rooms, any layout, any Zigbee2MQTT base topic, device
   names with `/`, with or without phones, with pets.
3. Comfortable learning from a phone (mobile-first wizard) and background learning from corrections.
4. Clear visualisations in the Home Assistant style, light and dark theme, on phones too.
5. No writes to bulbs without an explicit user action. Motion data stays local.

**Non-goals**

- Identifying people from radio. "Who is where" is "where is motion" plus context from phones (3.6).
- An exact position in metres. A position inside a room is only an illustration.
- Detecting a person who keeps still. RSSI sees motion, not presence; the hold time covers the rest.
- ZHA (D13). Changes to the firmware or the converter, which belong to the
  [Outglow repository](https://github.com/outglow/outglow) (section 12).

## 2. Facts the design rests on

| Fact | Consequence |
|---|---|
| Every Outglow bulb with motion sensing measures the signal of each other bulb it hears: N bulbs give N·(N−1) directions and N·(N−1)/2 pairs | At home sizes the room model is cheap in pure Python (3.10) |
| Activity reports (`lineActivity`, cluster `0xFC5E`, attribute `0xFF47`) are sent **only while the bulb's own detector sees motion on some line**, plus one at the end | The data are **cut off by the gate**: silence means "no line of this bulb crossed the firmware's threshold", not "level 0". The noise distribution seen by the host is biased (5.2) |
| The converter puts two different quantities into `motion_links[].activity`: the window sum of weights (`0x0002`, depends on the sensitivity) and the sum of absolute RSSI deviations over 16 probes in dB (`0xFF47`, does not) | Only `0xFF47` levels go into the model; a stream heuristic tells them apart (5.1, D2) |
| Weak lines (≤ −88 dBm) have a **frozen** level: most probes are lost and the 16-sample window stops changing | Frozen lines are detected and carry no weight (5.1) |
| Ceiling-to-ceiling lines inside one room barely react; lines through walls react to motion in both rooms (measured in a test home) | Consistent with the *fade level* model (Wilson and Patwari 2011): a line with a strong direct path above people's heads is stable, a non-line-of-sight line is sensitive widely around both ends. **Fresnel-ellipse geometry (RTI) is a poor prior**; the prior is by geometric class of the pair (5.5), learning does the rest |
| False motion in an empty home is almost always one-sided (A←B without B←A); real motion is two-sided much more often | The pair observation has three states with separate probabilities in silence and in motion (5.5), a soft version of "both directions" |
| Noise comes in waves (many lines at once) | Common and receiver vetoes (5.4) |
| Ground truth labels are scarce | The model works from priors and learns from few labels. The wizard (6.3) is essential; empty-home periods give large, cheap negative labels |
| Writing a sensitivity from Zigbee2MQTT overwrites every line of the bulb and clears its calibration | The integration never writes to bulbs by itself; every write is an action with a warning (section 9). Learning happens in the host's model |
| Each bulb message is the full device state, including `state`, `brightness`, `color_temp` | The same message gives light changes, used for blanking (a PWM change disturbs RSSI) and for labels from corrections |

## 3. Architecture

### 3.1 Overview

```
 Outglow bulbs ──802.15.4──▶ Zigbee2MQTT + outglow.mjs ──MQTT──▶ Home Assistant: `outglow` integration
                                                                   │
  ┌────────────────────────────────────────────────────────────────┴─────────────────────────┐
  │ custom_components/outglow                                                                │
  │  mqtt_source ──Observation──▶ ┌──────── engine (pure Python, no Home Assistant) ────────┐ │
  │  (<base>/#, bridge/devices)   │ ingest → cfar → pairs → veto → rooms → temporal         │ │
  │  context (person, light, ────▶ learn (labels) · calibrate (false alarm budget)          │ │
  │   context.user_id)            │ quality · recommendations                               │ │
  │                               └──────────────┬─────────────────────────┬────────────────┘ │
  │                                      Frame (every tick)          model state (JSON)       │
  │  coordinator ◀───────────────────────────────┘                         │                  │
  │   ├─ entities                                                     Store                   │
  │   ├─ history (SQLite in the executor)                             history.db              │
  │   ├─ WebSocket API (outglow/*) ◀──▶ panel (Lit, /outglow) + card outglow-map-card         │
  │   └─ actions (outglow.*)                                                                  │
  └───────────────────────────────────────────────────────────────────────────────────────────┘
```

- **The engine is a library without Home Assistant** (`custom_components/outglow/engine/`, standard library only).
  The same code runs in the integration, in the tests and in the offline evaluation (`tools/eval.py`). An
  architecture test fails on any `import homeassistant` in `engine/`.
- Everything is asynchronous on Home Assistant's loop. The engine is synchronous and short (≤ 10 ms per tick at
  9 bulbs). SQLite writes and the night calibration run in the executor.
- One instance per home (`single_config_entry`).

### 3.2 Packaging

One HACS repository of type *integration*. The frontend is built into `custom_components/outglow/frontend/` and served
by the integration. The card registers itself through `frontend.add_extra_js_url`, so no dashboard resource is needed.
A release (GitHub Actions on a tag) builds the frontend and attaches `outglow.zip` with the content of
`custom_components/outglow`; HACS downloads that zip (`zip_release` in `hacs.json`).

### 3.3 Data source: MQTT directly, not entities

The integration subscribes to MQTT itself instead of reading `sensor.*_motion_links` entities: an entity state is cut
at 255 characters, the line lists would bloat the recorder, it would depend on entity names and on discovery, and it
would lose the receive time of each message.

| Topic | What for |
|---|---|
| `<base>/bridge/devices` (retained) | IEEE ↔ friendly name, model (`outglow-*`, `open-eglo-*`), whether `motion_links` is exposed, device options (`motion_activity_rate`) |
| `<base>/bridge/info`, `<base>/bridge/state` | Zigbee2MQTT version, `output` (json or attribute), bridge availability |
| `<base>/#` | Device messages. Names may contain `/`, so `#` with an exact match against the device list. `/set`, `/get` and `/availability` are skipped (availability is read separately) |
| `<base>/<name>/availability` | An offline bulb's lines are "no data", not "quiet" |

Zigbee2MQTT's `output: attribute` (without JSON) is not supported: a repair explains how to change it. Bulbs are mapped
to their `light.*` entities and areas through the device registry; a room of the plan can be bound to an area.

### 3.4 Entities

Entities use `has_entity_name`. Devices: one *Outglow* hub and one per room of the plan (*Living room · Outglow*).
Entity IDs are `<domain>.outglow_<key>` and `<domain>.outglow_room_<room id>_<key>`, so they survive renaming a room.
The generated table in the README lists them; in short:

- `binary_sensor.outglow_room_<room>_occupancy` (`occupancy`): motion now or within the hold time. Attributes
  `motion` (without the hold), `probability`, `last_motion`, `top_pairs` (up to 3, bulb names), `coverage`
  (`good`/`weak`/`none`), `model_version`. With `coverage = none` the entity is unavailable rather than wrong.
- `binary_sensor.outglow_home_motion`, `sensor.outglow_motion_room` (with `rooms`, `trail` and, with exactly one
  person at home, `likely_person`), diagnostic `sensor.outglow_status` (`learning` / `ready` / `degraded` / `paused` /
  `plan_too_large`, the last while the stored plan is over the limits of 4.1), per-room
  `sensor.outglow_room_<room>_false_alarms_24h`, config switches `sensing` and `learning`, per-room
  `select` false alarm budget and reaction, `number` hold time, and a button to delete the motion history.

There are **no entities per line** (30 bulbs would make over 400). Lines are in the panel and in diagnostics.
Attributes that change every tick (`probability`, `top_pairs`, `rooms`, gate counts…) are written at most once per
60 s (status: 300 s) unless the state or a steady attribute changes, and the noisy ones are excluded from the
recorder. `home_motion` turns off 10 s after the last motion; `motion_room` moves to another room at once when the
current one stops being occupied or when the new one has motion and the current one had none for 10 s. A tie (in
`rules` every lit room has p = 1) goes to the room shown, then to the room whose motion started last, never to the
order or the ids of the rooms.

### 3.5 Actions

`outglow.feedback`, `outglow.label`, `outglow.start_session` / `stop_session`, `outglow.export_recording`,
`outglow.reset_learning`, `outglow.write_bulb_setting` (the only write to a bulb outside the panel; it needs
`confirm: true`). The README lists their fields.

### 3.6 Context: phones, people, lights

- **Empty home**: every chosen `person.*` is `not_home` for ≥ 600 s. It is learnt **online and once**: each tick of
  the absence goes to the CFAR and pair backgrounds 120 s late, and coming home ends the learning before the last
  120 s are reached, so no label is added afterwards for the same interval (the raw data minus the margins still go to
  the night calibration). Learning online matters because a label after the fact reaches only the 3 h tick buffer. Each
  tick remembers the weight it was taught with; a later empty label (a wizard step, a recording) adds only the
  difference, so overlapping sources never count twice. The run counts only while learning is on, and after learning
  is switched back on it waits for a fresh 2 × 120 s. "Others may be home (pets, guests)" turns it into a weak label:
  it does not force rooms off, counts no false alarms and teaches only CFAR, with weight 0.3. The empty time in the
  model fades with the background (half-life 7 days). Off by default (D6).
- **Who is home**: with exactly one person home, `sensor.outglow_motion_room` gets `likely_person`. No more
  identification than that.
- **Light changes**: `state_changed` of the bulbs' `light.*` entities, with their context: `context.user_id` means a
  person in Home Assistant, our own context means us, a change reported by Zigbee2MQTT without context means a remote
  or a switch. Used for blanking (5.1) and for labels from corrections (6.1).

### 3.7 WebSocket API (panel ↔ backend contract)

All commands start with `outglow/` and need an administrator (D11). The source of truth is the JSON Schema in
`docs/schemas/` (command registry `commands.json`); `docs/api.md` and `frontend/src/api/types.ts` are generated from
it, the `probatio` schemas in `websocket.py` mirror it, and shared examples in `tests/fixtures/ws/*.json` are checked
against both sides. `outglow/live/subscribe` sends a full frame, then deltas (≤ 4 Hz, only while the panel is open).
A write to a bulb is two steps: `outglow/bulb/write_preview` returns the effects and a one-time token valid for 60 s,
`outglow/bulb/write` uses it.

### 3.8 Storage

| What | Where | Format, retention |
|---|---|---|
| Plan | `Store("outglow.plan")` | JSON, versioned (`rev`), migrations |
| Settings | `Store("outglow.settings")` | JSON |
| Model | `Store("outglow.model")` | Background statistics per direction (histograms), Dirichlet counts of the emission, thresholds, version; daily snapshots |
| History | `config/outglow/history.db` (stdlib `sqlite3`, WAL, executor) | raw reports 48 h; raw reports from empty-home periods 7 days (calibration); room ticks with p > 0.05 14 days; events 365 days; labels without limit |
| Plan background | `config/outglow/plan-<hash>.<ext>` | served only over the WebSocket API |
| Exports | `config/outglow/exports/*.jsonl` | on request; deleted by the user |

### 3.9 Config flow and options

1. **Zigbee2MQTT**: the base topic. The flow waits a few seconds for `bridge/info` and `bridge/devices` and says how
   many Outglow bulbs it found, in how many motion sensing is on and in how many activity reports are on. Without
   the MQTT integration it aborts with an explanation.
2. It explains that without `motion_activity_rate` > 0 the host only sees motion bits, and that motion tracking shows
   who moves where. It does not change the option (D7).

Options: log level. The base topic is fixed per entry; everything else (tick, people, retention, learning) is in the
panel's settings (`Settings.global`, one source for the engine and the panel). Repairs: missing converter, `output:
attribute`, a sensing bulb without activity reports for a day, bridge offline, plan missing or incomplete, a room
without coverage, recommendations from 5.9, rates not restored after a session (or still waiting for Zigbee2MQTT to
confirm them), and two about the stored plan:

- **Plan too large** (`plan_too_large`): a plan stored before the current limits of 4.1. The integration keeps it but
  every engine (live, the replay of `history/frames`, the session summary) is built from an empty plan, learning and
  the night calibration wait (labels go to the history as rejected; the model, the proposal and the last calibration
  do not change), the home entities are unavailable and the status is `plan_too_large`. The repair names the limit
  until the plan is simplified.
- **Unreadable plan** (`plan_unreadable`): `outglow.plan` does not decode, or Home Assistant set it aside after a
  syntax error. Outglow runs with an empty plan, leaves the room entities and devices alone and keeps a copy as
  `outglow.plan.corrupt-<time>` (one per content, at most three, removed with the integration). The repair offers
  *Restore* (reads the fixed copy and saves it as the plan) and *Discard the old plan*. The recovery state survives
  restarts and ends only with a restore, a discard or the first saved plan with rooms (a save without rooms, such as
  only excluding a direction, does not end it). When it ends, the old rooms not in the new plan (known from the
  entity and device registries, settings, the model and the history) go to `retired_rooms` and are cleaned up; until
  then `plan/get` lists them in `reserved_rooms`, so the editor does not give their ids to a new room.

### 3.10 Performance

About 3–4 messages/s at 9 bulbs, up to about 15/s at 30. A tick of 0.5 s costs O(S·P) with S ≤ 299 states and
P ≤ 100 pairs, a few ms in CPython; budget p99 ≤ 10 ms at 9 bulbs and ≤ 50 ms at 30. The engine does not need numpy.

On Home Assistant's event loop, at 30 bulbs with a learnt model, a tick takes < 5 ms on average and no call on the
loop takes > 20 ms of CPU (`tests/integration/test_loop_time.py` measures the CPU time of the loop thread per call;
`OUTGLOW_LOOP_TIME_SCALE` multiplies both budgets on a slow or busy machine, 2 by default on CI). The median, MAD and threshold of each
direction are computed once per loaded model; the CFAR refresh every 60 s only picks thresholds for directions
without samples from their signal class's pool. Deriving the model (pair parameters, emission tables, CFAR thresholds)
at start, on a plan save, apply, rollback and reset runs in the executor on a copy; the engine takes the result if the
topology, the model and the weak lines did not change meanwhile, and derives again otherwise. While an apply derives,
the proposal's background learning (empty and quiet home) is held and goes to the model right after the apply. The
learnt model is serialised off the loop too.

## 4. Data model

### 4.1 Plan

Metres, x to the right, y down, one floor (`floor_id` reserved).

```jsonc
{
  "version": 1, "rev": 12, "floor_id": null, "north_deg": 0, "view_rotation_deg": 0,
  "background": {"file": "plan-0123456789abcdef.svg", "x": 0, "y": 0, "m_per_px": 0.02, "opacity": 0.35},
  "rooms": [{"id": "living", "name": "Living room", "area_id": null, "colour": "#4e9af1",
             "outline": [[0, 0], [5, 0], [5, 4], [0, 4]], "entrance": false}],
  "walls": [{"a": [5, 0], "b": [5, 4], "kind": "partition"}],   // partition|brick|concrete|glass|none
  "doors": [{"wall": 0, "at": 0.6, "width": 0.9, "kind": "door"}], // door|opening
  "adjacent": [["living", "hall"]],                                // from the doors
  "bulbs": [{"ieee": "0x0000000000000001", "x": 1.5, "y": 1.5, "height": "ceiling", "room": null}],
  "excluded_directions": [{"rx": "0x…", "tx": "0x…", "reason": "noisy at night"}],
  "retired_rooms": []
}
```

- Walls come from the room edges (a shared edge is a partition wall); the user sets their kind and the doors. The wall
  kind changes the prior and the recommendations. A room inside another (a pantry, an island) has its walls with the
  outer room along its own edges inside it, not on the shared outer outline; a piece of an outer wall it leans on is
  shared with the room behind that wall (the smallest room next to the wall decides each side). Doors go on these
  walls like on any other. Without `adjacent` in the plan, the engine counts a room directly inside another as its
  neighbour, like rooms whose walls touch.
- **Overlap and nesting.** Rooms that share only part of their floor (crossing edges, or a corner or the middle of an
  edge strictly inside the other room) get the warning `overlapping_rooms`. A room wholly inside another (touching its
  edge or equal to it too) is nested and allowed without a warning; a point then belongs to the smaller room. The
  editor, the plan import and the prototype import use the same geometry (`engine.topology.outlines_overlap`), with
  one tolerance of 1 mm from a line, so a corner snapped to a slanted wall lies on it. An L-shaped room does not
  overlap a room in its corner.
- A bulb's room follows from its position; the user may pin it to another room (a bulb above a door). The editor never
  pins by itself; a pinned bulb standing in another room is flagged (`bulb_pinned_elsewhere`). In nested rooms a bulb
  belongs to the smallest.
- A removed room's id goes to `retired_rooms` and is never given to a new room, so history and labels never attach to
  the wrong room.
- **Import** (`format: "auto"`): an exported Outglow plan, a Valetudo map (`ValetudoMap` from
  `GET /api/v2/robot/state/map` or from MQTT `…/MapData/map-data`, deflated JSON) and two layout formats of an
  earlier prototype. A Valetudo map: pixels × `pixelSize`; segments under 0.5 m² are dropped; segments grow 0.15 m
  into walls and void, keep their largest connected part, outlines are split per neighbour, simplified once
  (Douglas–Peucker) and straightened, so neighbouring rooms share identical edges; doors where two segments touch
  (≥ 0.4 m; ≥ 1.5 m is an opening); at most 200 corners per room; the floor becomes an SVG background (≤ 10 MB). The
  whole read has a 5 s CPU budget. With `current` (the editor's plan, *Keep the bulbs*), matched rooms keep their
  ids and settings and the bulbs move with a rigid transform fitted to the matched rooms' centres (a reflection only
  with ≥ 3 rooms not in a line and a clearly better fit). The bulbs move only from 3 matched rooms on: with 1–2 they
  stay where they are with `bulbs_not_aligned`, because two centres fix the rotation by the line between them alone,
  with a near-zero error whether the match is right or not.
- **Limits.** Only a Valetudo map may be up to 16 MiB of text (also as `deflated_base64`); an Outglow plan, YAML and
  the prototype layout at most 512 KiB; larger is `invalid_format` with the size. A plan (imported, or saved with
  `plan/save`) has at most 40 rooms, 2000 room corners, 2000 walls and doors and 100 bulbs, and the estimated cost of
  rebuilding the engine with the learnt model (`engine_cost`: pairs × room states, pairs × corners, pairs × rooms,
  pairs × walls and × hard walls, a constant per pair, corner pairs without an adjacency list) must stay within 2 s of
  CPU on a laptop (`ENGINE_BUDGET_US`); about 4× longer on a Raspberry Pi, in the executor. Over it the error says how
  many bulbs fit with these rooms (four corners each, with adjacency, no walls: 40 rooms 23, 30 rooms 33, 20 rooms 55,
  16 rooms 70, 12 rooms 89, 8 rooms and fewer 100). The `current` plan of an import, used only to keep bulbs, has
  the old wider limits (250 rooms, 50 000 corners, 50 000 walls, 500 bulbs), so a plan stored before the limits can be
  replaced by an import. The import's checks and bulb matching have a 2 s CPU budget (`CHECK_BUDGET_S`), after which
  the import is `invalid_format` ("too complex"). A deflate stream must be complete with nothing after it, for the
  background image and the map from MQTT or HTTP too.
- **Background**: `plan/save` with `background_image` stores the image as `plan-<sha256:16>.<ext>` (a temporary
  `.plan-*.part` file in the same folder, then a rename) and the plan points to it. A Valetudo import names its
  background the same way at once, so the panel caches images by file name. Background writes are serialised under
  one lock. The files of the current and the previous save are kept (one undo of an import); older ones are deleted.
  A plan pointing to a file that is gone saves without a background (`background: null`; the panel says the
  background of that version is lost). The panel never re-sends an image the server already has. The editor and
  *Live* draw the saved background under the rooms (position, scale, opacity; no rotation); in the dark theme only an
  SVG drawing (a Valetudo map) is inverted, not a photo.

### 4.2 Engine types

`engine/types.py` holds the frozen dataclasses mirrored by the schemas: `LinkReading` (one direction in one message:
`tx`, `level` from `0xFF47` or `None`, `window_sum`, `motion`, `signal_dbm`, `noise_db`, sensitivities,
`raw_activity`), `Observation` (receive time, `rx`, links, occupancy, light, `source`: `activity` / `lines` /
`unknown`), `Context`, `Label`, `Plan`, `Settings`, `Frame`, `QualityReport`. `Engine` has `observe`, `context`,
`label`, `light`, `tick`, `calibrate`, `quality`, `model_state`, `reconfigure` and `replay`. The engine is
**deterministic** (no randomness, no system clock; time only from arguments), so replaying a recording gives
byte-identical frames.

### 4.3 Frame

```jsonc
{"t": 1795215600.5,
 "directions": [{"rx": "…", "tx": "…", "level": 23, "z": 3.1, "state": "exceed", "flags": ["one_sided"]}],
 "pairs":   [{"a": "…", "b": "…", "obs": 2, "weight": 0.8}],     // 0 quiet, 1 one-sided, 2 two-sided, null no data
 "rooms":   {"hall": {"p": 0.93, "motion": true, "occupied": true, "since": 1795215590.0, "coverage": "good"}},
 "veto":    null,                                                // or {"kind": "common"|"receiver", "rx": "…"}
 "gates":   {"0x…": "open"},                                     // open|closed|offline
 "trail":   [["living", 1795215580.0], ["hall", 1795215588.5]],
 "status": "ready", "model_version": 7}
```

### 4.4 Recordings (JSONL, format 2)

The first line is `{"type": "header", "format": 2, "plan": {...}, "settings": {...}}`; then `bulb` (a bulb message
with `ieee`, `source` and `light`), `light` (a light change with its origin), `context`, `label` and optionally
`frame`. The reader also takes format 1 of an earlier recorder (`bulb`, `truth`, `layout`, `estimate`), where `truth`
becomes labels. `outglow.export_recording` writes format 2.

## 5. Algorithms

### 5.0 Why this pipeline

| Approach | Verdict | Why |
|---|---|---|
| RTI (Fresnel ellipse + regularisation) | Illustration only (the *heat* layer) | Assumes a line sees motion near its segment; here ceiling lines barely react and the sensitive lines go through walls |
| Particle filter on the map | Rejected | Inherits the RTI error, is random (not reproducible) and assumes one person |
| One HMM over rooms | Rejected | Two people in two rooms break it |
| Hand-written zone rules | Baseline B1 and the `rules` mode | Work, but are hand-made and do not transfer between homes |
| Deep learning on the line vector | Rejected | Minutes of labels; would not transfer |
| **CFAR per direction + three-state pair observation + veto + factorial noisy-OR room model + temporal filter + counting with priors** | **Chosen** | Few parameters per room, priors from geometry and physics, learns from few labels, explains away paths through walls, interpretable (the panel shows which pairs decided) |

### 5.1 Layer 0: intake and normalisation

Per direction d = (rx ← tx):

1. **Level source.** Only levels from `lineActivity` (`0xFF47`). Until the converter tells them apart (D2), a message
   is `activity` when it arrives in a stream (the previous one from this rx came at most `1.5 / rate` s before, or the
   next one comes within that), otherwise `unknown` (a single message after a refresh or an announcement), which
   updates signal and noise but not the level.
2. **Gate.** `open` from the first `activity` message; `closed` after 1.5 s (+ 1/rate) without one; `offline` from
   availability. A closed gate gives `quiet_censored`, offline gives no data.
3. **Blanking after a light change.** For 2.0 s after a change of state, brightness or colour of rx or tx the
   direction has no data, so our own light switching is not motion.
4. **Frozen lines.** Identical level in 8 reports while another direction of the same rx changed: `frozen`, no data.
   `signal_dbm` ≤ −88: `weak`, half weight in the priors.
5. **Excluded directions** from the plan give no data.
6. **A bulb with its own CFAR detector.** Firmware 1.0.6 can switch a bulb's detector to CFAR (`motion_detector` in
   Zigbee2MQTT). Its activity and noise then mean something else, so the integration drops them and the directions
   that bulb receives have no data: neither the host CFAR nor the model learns from them, not even as censored quiet.
   Motion bits and signal stay. The context carries the set of such bulbs, so recordings and replays keep it. A
   missing field keeps the rule behaviour of older firmware.
7. **Per tick** (0.5 s by default): the maximum level of the tick; without a report the last level holds for ≤ 1 s.

### 5.2 Layer 1: CFAR on the host

A threshold per direction at which quiet exceeds it with a set frequency, independent of the firmware's sensitivity.

- **Statistic**: level L (sum of |deviations| over 16 probes).
- **Background**: a histogram of L per direction, decaying with a half-life of 7 days. Background samples: an empty
  home (weight 1); the wizard's empty step (weight 1); optionally quiet periods with people at home far from the
  direction (weight 0.2; `quiet_background`, off by default because it can confirm itself, D4).
- **Gate bias.** Background samples exist only while the gate is open, so they are the tail of the quiet
  distribution and the threshold is conservative. Closed-gate time counts as mass below the firmware threshold
  (censoring).
- **Threshold**: `T = max(Q(0.99), median + 4 · 1.4826 · MAD, 6)`; exceeding lasts while L ≥ 0.8 · T.
- **Readiness**: after 600 background samples; before that a pooled prior by signal class (≥ −70, −70..−80,
  < −80 dBm), and in a new home fixed starting thresholds from `engine/defaults.py`.
- **Output**: `state ∈ {quiet, exceed, quiet_censored, none}` and a z-score for drawing.

### 5.3 Layer 2: pair observation

For a pair {A, B} in a tick: `2` both directions exceed within 2 s; `1` one exceeds and the other is quiet; `0` both
quiet; `null` no data. One direction missing and the other exceeding gives `1` with the flag `single_direction`,
learnt separately. A chronically one-sided direction (≥ 3× the reverse and ≥ 30/h in the background) is
`asymmetric_noisy`: it cannot make a `1` alone but still counts towards a `2`.

### 5.4 Layer 3: vetoes

- **Common veto**: when ≥ 40 % of the directions with data exceed and they touch ≥ 3 rooms that cannot be covered by
  ≤ 2 adjacent ones, the tick plus 3 s is no data for every pair. A person disturbs a local subset of lines; a wave of
  interference (Wi-Fi, a microwave, a busy channel) disturbs all. Off in homes with ≤ 2 rooms.
- **Receiver veto**: ≥ 75 % (and ≥ 4) of one receiver's directions exceed in the same tick while the reverse ones do
  not: a receiver artefact; its directions have no data for 3 s.

### 5.5 Layer 4: pair emission and priors from the plan

The state of a tick is the set S of rooms with moving people. Emission of pair p (noisy-OR with a leak):

```
a_p(S) = 1 − (1 − β_p) · Π_{r ∈ S} (1 − θ_{p,r})       # probability the pair is disturbed
P(o=2 | S) = a_p(S)·η_p        + (1 − a_p(S))·ε2_p
P(o=1 | S) = a_p(S)·(1 − η_p)  + (1 − a_p(S))·ε1_p
P(o=0 | S) = 1 − P(o=1|S) − P(o=2|S)
o = null → factor 1;  o = 0 with both gates closed → c·P(0|S) + (1 − c), c = 0.7
```

`θ_{p,r}` is the pair's sensitivity to motion in room r, `η_p` the share of two-sided disturbances, `ε1_p`, `ε2_p` the
one- and two-sided rates in quiet, `β_p` a leak (neighbours behind a wall). All have Beta/Dirichlet priors with
pseudo-counts. The prior of θ comes from the pair's **geometric class** relative to r:

| Pair relative to room r | Prior θ |
|---|---|
| both ends in r, no wall on the line | 0.15 |
| one end in r, the other in an adjacent room | 0.45 |
| the line crosses r, ends outside | 0.35 |
| an end in a room adjacent to r, r not on the line | 0.10 |
| otherwise | 0.02 |

Modifiers: ×0.5 for weak lines, ×1.2 through brick or concrete, 0.25 for "both ends in r" with pendants or lamps. The
firmware's own motion bit can be an extra binary observation (`firmware_channel`, off by default: it repeats the same
information).

### 5.6 Layer 5: inference over rooms (explaining away)

States are all sets S of at most 3 rooms (12 rooms: 299 states). The prior per tick comes from the temporal filter
(rooms independent, truncated to |S| ≤ 3 and normalised, Boyen–Koller). The posterior `P(S | o) ∝ π(S) · Π_p P(o_p | S)`
is computed in logs, and `p_r` is its marginal. Example: a pair from the hall into the living room lights up together
with pairs inside the living room. {living} explains all of them; {living, hall} only adds the cost of entering the
hall, so the hall stays dark. When the pairs inside the hall light up too, the hall wins.

### 5.7 Layer 6: time, adjacency, hysteresis, hold

Per room, a two-state chain "motion / no motion":

| Parameter | `fast` | `normal` | `calm` |
|---|---|---|---|
| Probability motion continues in the next tick | 0.80 | 0.90 | 0.95 |
| Ticks with p ≥ A_on to switch on | 1 | 2 | 4 |
| Reaction (tick 0.5 s, plus the firmware window) | ≈ 1 s | ≈ 1.5–2 s | ≈ 3 s |

Entering motion per tick: 0.002, 0.05 when an adjacent room had motion in the last 10 s, 0.02 for the entrance room.
Motion ends when p < 0.3; `occupied` is motion or less than the hold time since the last motion. A hard empty home
switches everything off and blocks switching on, except the entrance room, where motion ends the empty home. `A_on`
comes from the false alarm budget (5.8); 0.9 until calibration has data.

### 5.8 False alarm budget and night calibration

The user picks false alarms per day (0.1 / 0.3 / 1 / 3 / 10). Every night the engine replays the empty-home raw data
of the last ≤ 7 days with the current model and picks per room the smallest `A_on ∈ [0.5, 0.995]` whose switch-ons in
those data, per day, stay within the budget. With less than 2 h of empty home `A_on` stays and the status says the
calibration is uncertain. The predicted detection at that `A_on` (from wizard labels) is shown next to the budget.

### 5.9 Quality and recommendations

`QualityReport` (≤ 30 days): per direction the background exceed rate, asymmetry, frozen share, signal, gate duty and
learnt θ; per pair the information about each room, `I_{p,r} = KL(P(o | {r}) ‖ P(o | ∅))`; per room false alarms per
day, entry detection and delay from labels, **coverage** = Σ_p I_{p,r} (`good` ≥ 1.0, `weak` 0.3–1.0, `none` < 0.3
nat), vetoes. Recommendations, each with its numbers: skip a noisy direction (a change in the plan, not the bulb);
raise the sensitivity of a nearly deaf bulb (a confirmed write that clears its calibration: *a sensitive gate, the
decision on the host*); a weakly covered room, with candidate places for another bulb scored by the coverage it would
add; more empty-home time; a frozen line; a room without bulbs; and, in `rules` mode, **a room with one bulb** next to
a room with at least two (`one_bulb`): it lights while a neighbour has motion only when its full fan of lines moves
(8.3), so the recommendation marks up to three spots for a second bulb or node. Spots are grid points 0.5 m apart and
at least 0.5 m from the walls (as far as a narrow room allows), scored by 10 × the length of the new pair inside the
room plus the mean in-room length of its lines to the other bulbs with a predicted RSSI ≥ −80 dBm, at least 1 m apart.
The pair inside the room is what the room lacks, so it decides; the lines to neighbours only break ties.

### 5.10 Defaults

Collected in `engine/defaults.py`. They are a starting point; the evaluation may change them only on results from
**several** synthetic homes **and** recordings, never tuned to one home.

## 6. Learning

### 6.1 Label sources

| Source | Label | Weight |
|---|---|---|
| Wizard: walk in X | S = {X}, `walk` | 1.0 |
| Wizard: sit in X | S = ∅ only for pairs far from X (not touching X or its neighbours), `still` | 0.5 |
| Wizard: empty / empty home | S = ∅ in every room | 1.0 |
| `outglow.label` | as given | 0.8 |
| A manual switch-on while unoccupied | r ∈ S around that time | 0.3 |
| `outglow.feedback`, corrections in History | by kind | 0.7 |
| Soft empty home | CFAR background only | 0.3 |

Label edges are trimmed by 3 s (transitions, the 16-probe window).

### 6.2 Updating the model

From labels with S = {r}: category counts of `o ∈ {0,1,2}` per (pair, r), giving
`θ_{p,r} = (P̂(o≠0 | {r}) − P̂(o≠0 | ∅)) / (1 − P̂(o≠0 | ∅))` clipped to [0, 0.95], and `η_p`. Labels with S = ∅ teach
`ε1`, `ε2`, `β`. Partial labels (only "r ∉ S") are assigned softly through the posterior of the other rooms. Counts
decay with a 30-day half-life (wizard counts half as fast). **Safeguards**: what is learnt is a proposal applied only
with *Apply* (D4); a snapshot before every change; roll back from the panel; online learning can be switched off. The
model never writes to bulbs.

### 6.3 The learning wizard

0. **Check**: rooms and bulbs on the plan, sensing on, activity reports. Optional consent to raise reports to 4/s for
   the session (off by default, D7); the previous value is restored at the end, after 30 min, after a restart, and on
   unload or removal of the integration (retried while MQTT is unavailable; a repair lists bulbs left at the raised
   rate).
1. **Empty (5/10/15 min)**: everyone leaves; the countdown runs on the server, the phone vibrates when you may return.
   The interval minus 120 s at both ends is the label. *Can't now* moves the step to the end.
2. **Each room**, in an order that follows the doors from the entrance: walk along the walls and past the door (20 s,
   where rooms are confused most); walk freely (60 s; the screen shows how many pairs react, never a room guess, so
   the walker is not steered); sit where you usually sit (20 s; quiet for pairs far from the room); walk to the next
   room (`transition`).
3. **Summary**: how often the active mode recognised the room you were in, before and after this session. In `bayes`,
   "after" is cross-validated on the halves of each walk step (learn from one half, score the other; optimistic, same
   session). In `rules`, before equals after; the summary also scores `bayes` and offers *switch to bayes and apply*
   when it wins by ≥ 10 points, while warning when the model has under 2 h of empty home (false alarms unknown). A
   confusion matrix, weakly covered rooms, rooms without bulbs, recommendations. Labels enter the model only after
   *Apply*.

An abandoned session does not turn hours into labels: steps last at most 30 min (empty), 10 min (room) or 5 min
(transition), and a session without a new step for 30 min ends by itself. Phone: the screen stays on (Wake Lock), big
buttons, vibration and optional speech on a new step. Label time is the server's receive time.

## 7. UX

- The panel is `ha-panel-custom` with the Lit element `outglow-panel` (icon `mdi:motion-sensor`), tabs `/outglow/live`,
  `/plan`, `/learn`, `/quality`, `/settings`, `/history` (deep links work). Own light components styled with Home
  Assistant's theme variables, plus the stable `ha-card` and `ha-icon` (D12). Light and dark themes, a fixed palette
  of 8 room colours checked on both, `prefers-reduced-motion`, touch targets ≥ 44 px, no horizontal scrolling, text in
  English and Polish. SVG for structure and touch, Canvas underneath for the glow and the heat layer.
- **Live**: rooms filled by p, bulbs glowing while their gate is open, pairs as solid (two-sided) or dashed (one-sided)
  lines, a pulse along a line when it starts exceeding, the trail as arcs through doors (never invented
  coordinates), the heat layer labelled as an illustration.
- **Plan**: rectangle and polygon, snapping to the grid, corners and edges of other rooms and to 90°, resize handles,
  shared walls moving in both rooms (doors keep their width and do not run into one another), corners added by a
  double-click on a wall and removed with Delete or a double-click (a corner that must stay says why: three corners
  at least, no self-crossing outline, no overlap with another room), corners and walls picked from the keyboard,
  merging the two rooms of a wall into one (refused, with the reason, for rooms that overlap or nest; the panel says
  what goes with the removed room and what happens to the areas), nested rooms, doors on walls, bulbs dragged from the
  list, the saved background under the rooms with a toggle, import with a preview, live validation, undo/redo, a
  warning when leaving with unsaved changes, saving with `rev`. The editor never sends a plan that brings back a
  removed room's id.
- **Drafts**: each editor keeps its own draft in `localStorage` under `outglow.editor.draft.<entry>.<tab>.<editor>`
  (the tab id is in `sessionStorage`); a background from an import goes to IndexedDB. Home Assistant detaches a hidden
  panel after 5 minutes and rebuilds it with the plan from the server; the new editor (or a reloaded page) then offers
  *Restore* / *Discard* for the drafts of this tab and of closed tabs (an open tab refreshes
  `outglow.editor.alive.<tab>` every 30 s and counts as closed after 3 minutes of silence), noting when the server's
  plan changed meanwhile. A duplicated tab takes a tab id of its own. Drafts older than 7 days go. After a reconnect
  the panel fetches the plan again (retrying for a while after a Home Assistant restart): without unsaved edits it is
  replaced, with them they stay, and a changed plan on the server shows the conflict bar (*Load theirs* / *Keep
  mine*). A save whose reply was lost with the connection is recognised afterwards as one's own (the server's plan has
  `rev` one higher and is the plan that was sent), so it shows no conflict.
- **Learning**: section 6.3. **Quality**: section 5.9. **Settings**: per-room budget, reaction and hold; global
  switches, people, retention, snapshots, and the bulbs' motion settings, changed only through the confirmation dialog
  (section 9). **History**: room bands from the ticks, events, replay from raw data up to 48 h back, corrections.
- **Card** `custom:outglow-map-card`: the Live renderer without editing; options in the README.

## 8. Offline evaluation

### 8.1 Data

- **Recordings** of real homes are read only locally, from a path given on the command line; they never go into the
  repository (they show who was where and when).
- **Synthetic data** (`tools/synth.py`, deterministic from a seed): several home templates (a studio with a bathroom,
  two rooms and a hall, four rooms in an L, six rooms in two wings), 2–20 bulbs; background levels from a gamma
  distribution with AR(1) waves shared by many lines, direction asymmetry, frozen weak lines, the firmware gate with
  reports at 2/s, light changes with blanking, 1–2 people walking the adjacency graph, line sensitivity per room
  following "NLOS sensitive, LOS inside the room not". Used for property tests (the veto removes waves, agreement cuts
  one-sided false alarms, explaining away keeps the neighbour dark), **not** for tuning.
- Wizard sessions exported with `outglow.export_recording`.

### 8.2 Protocol and metrics

Replay through `Engine.replay`; leave-one-session-out cross-validation for anything learnt; calibration only from the
training fold; bootstrap confidence intervals. Metrics: false switch-ons per hour of empty home; cross-room errors
(adjacent and not); entry detection within 10 s; delay (median, p90); walking coverage; room accuracy of
`motion_room`; hold during stillness (report only); tick cost.

### 8.3 Baselines and ablations

B0: the bulbs' own occupancy. B1: the zone rule (`engine/rules.py`, the `rules` mode): a room with its own pair in
motion (both ends inside) switches on and takes its pairs shared with neighbours; a room without such a pair switches on
with pairs no such room took; a room without bulbs never switches on in this mode. A room with one bulb has no inner
pair, so it stays dark while a neighbour with its own pair explains all its lines, unless a **full fan** moves: all
(at least `FAN_MIN` = 3) of its lines into one neighbouring room that the rule uses and that deliver data, or all (at
least 3) of its lines into every neighbour lit by its own pair (a **joint fan**). A pair is in the fan when one of its
directions is used; skipped directions and directions without data do not block it. Looser variants (a single-bulb
room always keeping its lines, or 2 of 3 lines) gave clearly more false switch-ons and were rejected; the remedy is a
second bulb (the `one_bulb` recommendation, 5.9). B3: the full pipeline, with
ablations (no direction agreement, no veto, no explaining away, no learning, no CFAR, a flat prior). If B3 does not
beat B1 on false alarms and entry detection, `rules` stays the default (it is today) and `bayes` an option.

## 9. Safety, privacy, limits

**Writes.** The integration sends to Zigbee2MQTT only:

1. `<base>/<name>/set` with a motion setting (sensing, sensitivity, probes, automatic calibration, self-tuning,
   calibrate), only through `outglow/bulb/write` with a token from `outglow/bulb/write_preview`, or through
   `outglow.write_bulb_setting` with `confirm: true`. The dialog shows the effects first (a sensitivity overwrites
   every line of the bulb and clears its calibration); the token is single-use and valid for 60 s.
2. `<base>/bridge/request/device/options` with `motion_activity_rate`, only in the wizard after explicit consent, and
   the restore of the previous value.

Nothing else; an integration test collects every MQTT publish and fails on any other. Light control by the
integration (`auto_light`) is not implemented (D5).

**Radio.** Activity reports are Zigbee frames to the coordinator (2/s per bulb with an open gate); recommendations that
raise sensitivity increase them.

**Privacy.** Everything local, no cloud, no telemetry. The plan, background and history are served only over the
authenticated WebSocket API, never under `/local`. Diagnostics replace IEEE addresses with salted hashes and drop
names, plan coordinates (only the extent is kept) and people. Retention is configurable and the history can be deleted
at once. `person.*` is optional (D6); only home/not_home is used, never GPS. The config flow says that motion tracking
shows who moves where.

**Repository.** No data from real homes: fixtures are synthetic with IEEE `0x00000000000000NN`; tests fail on an IEEE
address with the Telink/AwoX OUI, on JSONL files over 100 KB, on private network addresses, local paths and words from
an optional local list.

**Limits.** Motion, not presence; pets trigger it; one bulb per room is usually not enough; quality depends on
placement, empty-home time and learning; "who is where" is not identification; motion sensing in the firmware is
experimental.

## 10. Testing

- **Engine** (`tests/engine`, plain pytest): unit tests per layer, property tests on synthetic homes, determinism,
  reading format 1, performance; **100 % line coverage** of `engine/` is enforced.
- **Integration** (`tests/integration`, `pytest-homeassistant-custom-component`): config flow, MQTT parsing (names with
  `/`, availability, attribute output), entities, actions, every WebSocket command against its schema fixture,
  admin-only access, the **no-writes** test (section 9), restoring raised report rates, store migrations, SQLite
  retention, diagnostics redaction, recorder load.
- **Frontend**: vitest for logic (editor geometry, snapping, import, frame deltas), Playwright on the demo panel
  (themes, 390/768/1440 px, wizard end to end, editor, corners, merging, drafts and reconnects, keyboard and touch in
  Chrome and WebKit), and the README pictures compared with a pixel tolerance.
- **Loop time** (`tests/integration/test_loop_time.py`): the event loop budgets of 3.10.
- `make quick` runs only the checks and tests the changes since a base reach; `make check` runs everything.

## 12. Requests to the firmware and the converter

1. Converter: separate the `0xFF47` level from the `0x0002` window sum (removes the stream heuristic, D2).
2. Firmware: an "always stream" mode, so the host gets an unbiased background (D3).
3. Firmware: the number of samples behind each window, so a frozen line is a fact, not a guess.
4. The firmware's own CFAR detector (firmware 1.0.6, `motion_detector`) exists; for now its line data are skipped
   (5.1). Later: its decisions as an extra observation.

## 14. Decisions

| # | Decision | Consequence |
|---|---|---|
| D2 | The converter is not changed for now; the `activity` source is recognised by the stream heuristic (5.1) | `LinkReading.raw_activity` carries the Zigbee2MQTT value uninterpreted, `level` only for `source = activity` |
| D3 | Keep the **gate in the bulb** (no always-stream mode) | CFAR with censoring (5.2) and the "sensitive gate" recommendation (5.9) are the main path |
| D4 | The model **learns in the background**, but changes reach the running model **only after Apply**, with a preview and roll-back | The engine keeps an active model and a proposal (`pending`); `outglow/model/apply` / `discard` / `rollback`; a snapshot before applying. The quiet-ish CFAR background group is off (`quiet_background = false`) |
| D5 | **No light control** in this version; entities and `outglow.feedback` instead | `auto_light` / `light_off_delay_s` stay in the settings contract (off) but are not acted on |
| D6 | `person.*` as the empty-home signal is **off by default** | `use_persons = false`; without it there are no empty-home labels from people; the wizard's empty step works |
| D7 | Activity report rates are not changed by setup; 4/s during the wizard **only after explicit consent** | `outglow/session/start` has `raise_rate` (default `false`); restore as in 6.3 |
| D8 | Retention: raw 48 h, empty-home raw 7 days, ticks 14 days, events 365 days | Defaults of `settings.global.retention` |
| D9 | Code in English, **no comments and no docstrings** (Python and TypeScript), **100 % line coverage of `engine/`** | Repository tests fail on comments and docstrings (tool pragmas excepted); descriptions live in the JSON schemas |
| D10 | No phone accelerometer in the wizard | — |
| D11 | Panel and every command **for administrators only** | Panel registered with `require_admin`; every WebSocket command requires an admin |
| D12 | Own Lit components on Home Assistant's theme variables; only `ha-card` and `ha-icon` from Home Assistant | No other `ha-*` |
| D13 | No ZHA | — |
