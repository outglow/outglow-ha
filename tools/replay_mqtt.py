import argparse
import importlib
import json
import sys
import time
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine import recording, to_json
from engine.types import Context, Header, LightEvent, LinkReading, Observation, Plan, Record
from tools import synth

DEFAULT_MODEL = "outglow-dimm"
DEFAULT_VERSION = "2.6.3"
COORDINATOR_IEEE = "0x00000000000000ff"
NWK_BASE = 0x1000
ONLINE = {"state": "online"}
OFFLINE = {"state": "offline"}
Timed = Observation | LightEvent | Context


@dataclass(frozen=True, slots=True)
class Message:
    topic: str
    payload: Any
    retain: bool = False

    def text(self) -> str:
        return json.dumps(self.payload, separators=(",", ":"))


def short_room_name(name: str) -> str:
    words = name.split()
    return words[0] if words else "Bulb"


def default_names(plan: Plan | None, extra: Iterable[str] = ()) -> dict[str, str]:
    names: dict[str, str] = {}
    counts: dict[str, int] = {}
    rooms = {room.id: room for room in plan.rooms} if plan is not None else {}
    for bulb in plan.bulbs if plan is not None else ():
        room_id = synth.room_of(plan, bulb) if plan is not None else None
        label = short_room_name(rooms[room_id].name) if room_id in rooms else "Bulb"
        counts[label] = counts.get(label, 0) + 1
        names[bulb.ieee] = f"{label} {counts[label]}"
    for ieee in sorted(set(extra) - set(names)):
        counts["Bulb"] = counts.get("Bulb", 0) + 1
        names[ieee] = f"Bulb {counts['Bulb']}"
    return names


def ieees_of(records: Iterable[Record]) -> set[str]:
    out: set[str] = set()
    for record in records:
        match record:
            case Observation():
                out.add(record.rx)
                out.update(link.tx for link in record.links)
            case LightEvent():
                out.add(record.ieee)
            case Context():
                out.update(record.offline)
            case _:
                pass
    return out


def recorded_names(lines: Iterable[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not isinstance(row, dict) or row.get("type") != "bulb":
            continue
        ieee, name = row.get("ieee"), row.get("name")
        if isinstance(ieee, str) and isinstance(name, str) and name and name != ieee:
            out[ieee.lower()] = name
    return out


def nwk_addresses(names: Mapping[str, str]) -> dict[str, str]:
    return {ieee: f"0x{NWK_BASE + i:04x}" for i, ieee in enumerate(sorted(names))}


def device_entry(ieee: str, name: str, model: str, nwk: str) -> dict[str, Any]:
    exposes: list[dict[str, Any]] = [
        {
            "type": "light",
            "features": [
                {"type": "binary", "name": "state", "property": "state", "value_on": "ON", "value_off": "OFF"},
                {"type": "numeric", "name": "brightness", "property": "brightness", "value_min": 0, "value_max": 254},
            ],
        },
        {"type": "binary", "name": "occupancy", "property": "occupancy", "value_on": True, "value_off": False},
        {
            "type": "binary",
            "name": "motion_sensing",
            "property": "motion_sensing",
            "value_on": "ON",
            "value_off": "OFF",
        },
        {"type": "numeric", "name": "motion_sensitivity", "property": "motion_sensitivity"},
        {"type": "numeric", "name": "motion_probes", "property": "motion_probes"},
        {"type": "list", "name": "motion_links", "property": "motion_links"},
    ]
    return {
        "ieee_address": ieee,
        "network_address": int(nwk, 16),
        "friendly_name": name,
        "type": "Router",
        "supported": True,
        "interview_completed": True,
        "manufacturer": "Outglow",
        "model_id": model,
        "power_source": "Mains (single phase)",
        "definition": {"model": model, "vendor": "Outglow", "description": "Outglow bulb", "exposes": exposes},
    }


def bridge_devices(names: Mapping[str, str], model: str) -> list[dict[str, Any]]:
    nwk = nwk_addresses(names)
    coordinator = {
        "ieee_address": COORDINATOR_IEEE,
        "network_address": 0,
        "friendly_name": "Coordinator",
        "type": "Coordinator",
        "supported": True,
        "interview_completed": True,
        "definition": None,
    }
    return [coordinator, *(device_entry(ieee, names[ieee], model, nwk[ieee]) for ieee in sorted(names))]


def bridge_info(names: Mapping[str, str], rate: float | None, version: str = DEFAULT_VERSION) -> dict[str, Any]:
    devices = {
        ieee: {"friendly_name": name, **({"motion_activity_rate": rate} if rate is not None else {})}
        for ieee, name in sorted(names.items())
    }
    return {
        "version": version,
        "commit": "replay",
        "coordinator": {"ieee_address": COORDINATOR_IEEE, "type": "EmberZNet"},
        "log_level": "info",
        "permit_join": False,
        "restart_required": False,
        "config": {"advanced": {"output": "json", "cache_state": True}, "devices": devices},
    }


def link_payload(link: LinkReading, slot: int, nwk: Mapping[str, str], model: str) -> dict[str, Any]:
    activity = link.raw_activity
    if activity is None:
        activity = link.level if link.level is not None else link.window_sum
    return {
        "address": nwk.get(link.tx, "0xffff"),
        "ieee_address": link.tx,
        "model": model,
        "signal": link.signal_dbm,
        "noise": link.noise_db,
        "activity": activity,
        "motion": link.motion,
        "slot": slot,
        "sensitivity": link.sensitivity,
        "calibrated_sensitivity": link.calibrated_sensitivity,
    }


def links_payload(links: Sequence[LinkReading], nwk: Mapping[str, str], model: str) -> list[dict[str, Any]]:
    items = [link_payload(link, slot, nwk, model) for slot, link in enumerate(links)]
    return sorted(items, key=lambda item: str(item["address"]))


def initial_state(sensitivity: int = 40, probes: int = 5) -> dict[str, Any]:
    return {
        "state": "ON",
        "brightness": 200,
        "linkquality": 120,
        "motion_sensing": "ON",
        "motion_probes": probes,
        "motion_sensitivity": sensitivity,
        "motion_auto_calibration": False,
        "motion_self_tuning": False,
        "motion_calibration_left": 0,
        "occupancy": False,
    }


class Replay:
    def __init__(
        self,
        base: str,
        names: Mapping[str, str],
        model: str = DEFAULT_MODEL,
        rate: float | None = 2.0,
        cache_state: bool = True,
    ) -> None:
        self.base = base
        self.names = dict(names)
        self.model = model
        self.rate = rate
        self.cache_state = cache_state
        self.nwk = nwk_addresses(self.names)
        self.state: dict[str, dict[str, Any]] = {ieee: initial_state() for ieee in self.names}
        self.offline: frozenset[str] = frozenset()

    def topic(self, ieee: str) -> str:
        return f"{self.base}/{self.names[ieee]}"

    def startup(self) -> list[Message]:
        out = [
            Message(f"{self.base}/bridge/state", ONLINE, retain=True),
            Message(f"{self.base}/bridge/info", bridge_info(self.names, self.rate), retain=True),
            Message(f"{self.base}/bridge/devices", bridge_devices(self.names, self.model), retain=True),
        ]
        out += [Message(f"{self.topic(ieee)}/availability", ONLINE, retain=True) for ieee in sorted(self.names)]
        out += [Message(self.topic(ieee), dict(self.state[ieee])) for ieee in sorted(self.names)]
        return out

    def shutdown(self) -> list[Message]:
        return [Message(f"{self.base}/bridge/state", OFFLINE, retain=True)]

    def _publish(self, ieee: str, change: dict[str, Any]) -> Message:
        self.state[ieee].update(change)
        return Message(self.topic(ieee), dict(self.state[ieee]) if self.cache_state else change)

    def messages(self, record: Record) -> list[Message]:
        match record:
            case Observation() if record.rx in self.names:
                change: dict[str, Any] = {"motion_links": links_payload(record.links, self.nwk, self.model)}
                if record.occupancy is not None:
                    change["occupancy"] = record.occupancy
                if record.light is not None:
                    change["state"] = "ON" if record.light.on else "OFF"
                    if record.light.brightness is not None:
                        change["brightness"] = record.light.brightness
                    if record.light.color_temp is not None:
                        change["color_temp"] = record.light.color_temp
                return [self._publish(record.rx, change)]
            case LightEvent() if record.ieee in self.names and record.on is not None:
                return [self._publish(record.ieee, {"state": "ON" if record.on else "OFF"})]
            case Context():
                offline = frozenset(i for i in record.offline if i in self.names)
                changed = sorted(offline ^ self.offline)
                self.offline = offline
                return [
                    Message(f"{self.topic(ieee)}/availability", OFFLINE if ieee in offline else ONLINE, retain=True)
                    for ieee in changed
                ]
            case _:
                return []


def timed(records: Iterable[Record]) -> list[Timed]:
    out: list[Timed] = [r for r in records if isinstance(r, Observation | LightEvent | Context)]
    return sorted(out, key=lambda r: r.t)


def schedule(records: Sequence[Timed], origin: float, offset: float, speed: float) -> Iterator[tuple[float, Timed]]:
    for record in records:
        yield (offset + record.t - origin) / speed, record


def plan_yaml(plan: Plan, names: Mapping[str, str]) -> str:
    lines = ["rooms:"]
    for room in plan.rooms:
        outline = ", ".join(f"[{_num(x)}, {_num(y)}]" for x, y in room.outline)
        lines += [f"  {room.id}:", f"    name: {json.dumps(room.name)}", f"    outline: [{outline}]"]
        lines.append(f"    colour: {json.dumps(room.colour)}")
        if room.entrance:
            lines.append("    entrance: true")
    lines.append("adjacent:")
    lines += [f"- [{a}, {b}]" for a, b in plan.adjacent]
    lines.append("bulbs:")
    for bulb in plan.bulbs:
        lines += [f"- z2m: {json.dumps(names.get(bulb.ieee, bulb.ieee))}", f"  at: [{_num(bulb.x)}, {_num(bulb.y)}]"]
        if bulb.room is not None:
            lines.append(f"  room: {bulb.room}")
        if bulb.height != "ceiling":
            lines.append(f"  height: {bulb.height}")
    return "\n".join(lines) + "\n"


def _num(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else repr(float(value))


def plan_json(plan: Plan) -> str:
    return json.dumps(to_json(plan), indent=2) + "\n"


@dataclass(slots=True)
class Input:
    plan: Plan | None
    names: dict[str, str]
    loader: Callable[[int], list[Timed]]
    span: float


def load_input(args: argparse.Namespace) -> Input:
    if args.recording is not None:
        lines = Path(args.recording).read_text().splitlines()
        records = list(recording.read(lines))
        header = next((r for r in records if isinstance(r, Header)), None)
        plan = header.plan if header is not None else None
        events = timed(records)
        names = {**default_names(plan, ieees_of(records)), **recorded_names(lines)}
        span = events[-1].t - events[0].t + 1.0 if events else 1.0
        return Input(plan=plan, names=names, loader=lambda _k: events, span=span)
    plan = (synth.TEMPLATES | synth.PHYSICS)[args.template]

    def generate(k: int) -> list[Timed]:
        seed = args.seed + k
        if args.template in synth.PHYSICS:
            return timed(
                synth.simulate_physics(args.template, seed, args.duration, args.empty, args.persons, args.rate)
            )
        return timed(synth.simulate(args.template, seed, args.duration, args.rate, False))

    return Input(plan=plan, names=default_names(plan), loader=generate, span=args.duration)


def _write(path: str, text: str) -> None:
    if path == "-":
        sys.stdout.write(text)
    else:
        Path(path).write_text(text)


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Replay a synthetic home to MQTT as Zigbee2MQTT with the Outglow converter")
    p.add_argument("recording", nargs="?", help="recording JSONL (format 1 or 2); default: generate with synth.py")
    p.add_argument("--template", choices=sorted(synth.TEMPLATES | synth.PHYSICS), default="flat3")
    p.add_argument("--duration", type=float, default=300.0, help="seconds of synthetic data per pass")
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--rate", type=float, default=2.0, help="activity reports per second (also motion_activity_rate)")
    p.add_argument("--persons", type=int, default=1, help="physics templates only")
    p.add_argument("--empty", type=float, default=0.0, help="physics templates only: empty house at the start, s")
    p.add_argument("--loop", action="store_true", help="repeat forever (synth: next seed each pass)")
    p.add_argument("--speed", type=float, default=1.0, help="time factor, 2 = twice as fast")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=1883)
    p.add_argument("--base", default="zigbee2mqtt", help="Zigbee2MQTT base topic")
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--names", help="JSON object {ieee: friendly_name} overriding the generated names")
    p.add_argument("--no-cache-state", action="store_true", help="publish only changed keys (cache_state: false)")
    p.add_argument("--print-plan", metavar="PATH", help="write the plan as Outglow JSON (panel import outglow_json)")
    p.add_argument("--print-yaml", metavar="PATH", help="write the plan as mieszkanie YAML with z2m names")
    p.add_argument("--plan-only", action="store_true", help="write --print-plan/--print-yaml and exit")
    p.add_argument("--quiet", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.speed <= 0:
        sys.stderr.write("--speed must be positive\n")
        return 2
    source = load_input(args)
    if args.names:
        overrides = json.loads(Path(args.names).read_text())
        source.names.update({str(k).lower(): str(v) for k, v in overrides.items()})
    if (args.print_plan or args.print_yaml) and source.plan is None:
        sys.stderr.write("the recording has no plan\n")
        return 1
    if args.print_plan and source.plan is not None:
        _write(args.print_plan, plan_json(source.plan))
    if args.print_yaml and source.plan is not None:
        _write(args.print_yaml, plan_yaml(source.plan, source.names))
    if args.plan_only:
        return 0
    replay = Replay(args.base, source.names, args.model, args.rate, cache_state=not args.no_cache_state)
    return publish(args, source, replay)


def load_mqtt() -> Any:
    return importlib.import_module("paho.mqtt.client")


def sleep(seconds: float) -> None:
    time.sleep(seconds)


def publish(args: argparse.Namespace, source: Input, replay: Replay) -> int:
    mqtt = load_mqtt()
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"outglow-replay-{int(time.time())}")
    for message in replay.shutdown():
        client.will_set(message.topic, message.text(), retain=message.retain)
    try:
        client.connect(args.host, args.port)
    except OSError as err:
        sys.stderr.write(f"cannot connect to {args.host}:{args.port}: {err}\n")
        return 1
    client.loop_start()
    sent = 0

    def send(messages: Iterable[Message]) -> None:
        nonlocal sent
        for message in messages:
            client.publish(message.topic, message.text(), retain=message.retain)
            sent += 1

    try:
        send(replay.startup())
        start = time.monotonic()
        offset = 0.0
        k = 0
        while True:
            events = source.loader(k)
            origin = events[0].t if events and args.recording is not None else synth.START
            for due, record in schedule(events, origin, offset, args.speed):
                delay = start + due - time.monotonic()
                if delay > 0:
                    sleep(delay)
                send(replay.messages(record))
            offset += source.span
            k += 1
            if not args.quiet:
                sys.stderr.write(f"pass {k}: {sent} messages\n")
            if not args.loop:
                break
            delay = start + offset / args.speed - time.monotonic()
            if delay > 0:
                sleep(delay)
    except KeyboardInterrupt:
        pass
    finally:
        info = None
        for message in replay.shutdown():
            info = client.publish(message.topic, message.text(), retain=message.retain)
        if info is not None:
            info.wait_for_publish(5)
        client.disconnect()
        client.loop_stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
