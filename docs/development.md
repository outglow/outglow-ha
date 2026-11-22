# Development

How the repository is laid out, what the contracts between its parts are, and the rules the tests enforce. The design
itself is in [architecture.md](architecture.md).

## Setup

```sh
python3.14 -m venv .venv
.venv/bin/pip install -e '.[test,lint,ha]'
npm --prefix frontend ci
make hooks            # git pre-commit hook in .githooks/

make quick            # only what the changes since main reach (BASE=<ref>, E2E=0 without Playwright)
make check            # everything below plus the frontend build
make test-engine      # tests/engine + contracts + repository rules + README, without Home Assistant, 100 % engine coverage
make test-ha          # tests/integration (pytest-homeassistant-custom-component)
make lint types contracts docs-check
make frontend-test    # tsc + vitest (happy-dom)
make frontend         # build into custom_components/outglow/frontend/
make e2e              # Playwright on the demo panel
npm --prefix frontend run dev   # the panel on made-up data: http://localhost:5173
```

`make quick` (`tools/quick.py`) runs ruff on the changed files, mypy, the pytest files that import a changed module
(directly or through other modules), vitest `--changed` and the Playwright specs whose view imports a changed file.
It is for the edit loop; run `make check`, with the 100 % engine coverage gate, before a merge or a release.

The engine tests run in plain Python 3.14 with `pytest`, `pytest-cov` and `jsonschema` (`pip install -e '.[test]'`);
`tests/integration` is skipped then.

## Three parts and their owners

| Part | Files |
|---|---|
| **Backend** (Home Assistant) | `custom_components/outglow/*` except `engine/` and `frontend/`; `tests/integration/` |
| **Frontend** | `frontend/` (sources, `mock/`, `tests/`, `e2e/`, `scripts/`); the build in `custom_components/outglow/frontend/` is only in the release zip |
| **Engine** | `custom_components/outglow/engine/`, `tools/` (except `contracts.py` and `docs.py`), `tests/engine/`, `tests/fixtures/recordings/` |
| **Shared (contract)** | `engine/types.py`, `docs/schemas/*.json`, `tests/fixtures/ws/*.json`, `tools/contracts.py`, the generated `frontend/src/api/types.ts` and `docs/api.md`, `tests/contract.py`, `tests/test_contracts.py`, `tests/test_repo.py`, `pyproject.toml`, `Makefile`, `.github/` |

## Contracts

| Boundary | Source of truth | Mirrors that must agree |
|---|---|---|
| Backend ↔ frontend (WebSocket) | `docs/schemas/*.json` and the command registry `docs/schemas/commands.json` | `frontend/src/api/types.ts` and `docs/api.md` (generated), fixtures `tests/fixtures/ws/<command>.json` |
| Backend ↔ engine | `engine/types.py` (dataclasses) and `engine/core.py` (`Engine`) | The schemas of the same types: `tests/test_contracts.py::test_dataclass_mirrors_schema` compares fields, requiredness and `Literal` values |
| Backend ↔ engine (recordings) | `docs/schemas/recording.json` (format 2) and `engine/recording.py` (reads 1 and 2, writes 2) | `tests/fixtures/recordings/` (synthetic) |

Rules:

- A command's `request` is the message without `id` and `type`; `response` is the `result` of a success; `event` is
  what a subscription sends after its `result: null`. Errors are `{code, message}` with `code` from `error.json`.
- Responses carry **every** field of an object (missing values are `null`). The engine's `from_json` is lenient and
  takes the dataclass defaults.
- Time is seconds since the epoch (the server's clock). IEEE is `0x` plus 16 lower-case hex digits. The plan is in
  metres.
- `outglow/live/subscribe` sends `{"kind": "full", "frame"}` first, then `{"kind": "delta", "delta"}`: lists carry only
  changed entries (directions by `rx`+`tx`, pairs by `a`+`b`), objects only changed keys; anything removed makes the
  backend send a full frame. Merging: `frontend/src/api/live.ts`; computing a delta: `frontend/mock/delta.ts`.
- User-facing texts (recommendations, import warnings, the effects of a write to a bulb) travel as `kind`/`code` plus
  numbers; the frontend translates them.
- Every command and the panel need an administrator.

### Changing a contract

One change (commit or pull request) contains at once:

1. the schema in `docs/schemas/` (and `commands.json` for a new command);
2. the dataclass in `engine/types.py` when the type has a mirror there (`DATACLASS_SCHEMAS` in
   `tests/test_contracts.py`);
3. the fixture `tests/fixtures/ws/<command>.json` (the command without `outglow/`, `/` → `_`); a new command fails the
   tests until it has one;
4. `make docs` (refreshes `types.ts`, `api.md` and the generated README sections; tests check they are current);
5. the demo backend in `frontend/mock/` if needed (`frontend/mock/hass.ts` answers from the fixtures by itself).

## Documentation that cannot go stale

- **README sections** between `<!-- generated:NAME -->` and `<!-- /generated:NAME -->` come from the code
  (`tools/docs.py`): entities from the platform modules and `strings.json`, actions from `services.yaml` and
  `strings.json`, settings from `docs/schemas/settings.json` with defaults from `engine/types.py`, card options from
  `CardConfig` in `frontend/src/outglow-cards.ts`, WebSocket commands from `commands.json`. A new entity, setting or
  card option without a description in `tools/docs.py` fails. `--check` also fails when the README points to a
  missing picture, when a picture in `docs/images/` is unused, and when the panel's help (`frontend/src/help.ts`) links
  to a README section that does not exist.
- **Pictures** in `docs/images/` come from the demo panel through `frontend/e2e/docs.spec.ts` with a frozen clock, a
  fixed time zone and locale, so they are reproducible. `make docs-images` writes them in the Playwright Docker image
  (`mcr.microsoft.com/playwright:v1.64.1-noble`, the same as CI) and assembles the GIFs with `ffmpeg` on the host;
  `npm --prefix frontend run shots -- --check` (CI, or `make docs-images-check` locally) compares the PNGs with a
  small pixel tolerance and fails when the panel looks different. Animations are regenerated, not compared.
- **Pre-commit hook** (`make hooks` sets `core.hooksPath` to `.githooks`): `tools/docs.py --check`,
  `tools/contracts.py --check`, ruff, the repository rules (no comments, no private data) and the TypeScript comment
  scan. It reminds you to refresh the pictures when `frontend/src` changes.
- **CI** (`.github/workflows/ci.yml`): contracts and README, lint, types, engine and integration tests, frontend tests
  and build, Playwright on the demo panel and the picture check in the Playwright container, `hassfest` and the HACS
  validation.

## Repository rules (enforced by tests)

- Code in English, **no comments and no docstrings** in Python and TypeScript. Only tool pragmas are allowed:
  `# type: ignore[...]`, `# noqa: ...`, `# pragma: no cover`. Field descriptions go into the schemas' `description`.
  `tests/test_repo.py` (Python) and `frontend/tests/no-comments.test.ts` (TypeScript and scripts).
- `engine/`: standard library only, no `homeassistant`, no clock and no randomness (time only from arguments),
  **100 % line coverage** (`make test-engine` fails below). `tests/engine/test_architecture.py`.
- **No data from real homes.** Fixtures are synthetic with IEEE `0x00000000000000NN`. `tests/test_repo.py` fails on an
  IEEE or MAC address with the Telink/AwoX prefix `a4c138`, on a JSONL file over 100 KB, on private network addresses
  (10/8, 172.16/12, 192.168/16; documentation examples are listed in the test), on absolute local paths (macOS user
  folders, temporary folders, home directories) and on any word from an optional list outside the repository
  (`$HOME/.config/outglow/private-words.txt` or `$OUTGLOW_PRIVATE_WORDS`: names, room names of a real home; one per line,
  `!glob` exempts a path in a private checkout). Real recordings are read only locally, from a path on the command
  line (`tools/eval.py <recordings>/*.jsonl`).
- Recording fixtures and the demo data are generated deterministically: `tools/synth.py --duration 12 >
  tests/fixtures/recordings/flat3_v2.jsonl`, `tools/synth.py --duration 30 --mock > frontend/mock/data/flat3.json`; a
  test checks they are current.

## Environment notes

- **Python** 3.14. `pytest-homeassistant-custom-component==0.13.375` pins `homeassistant==2026.10.4`. The `frontend`
  component needs `home-assistant-frontend` (in the `ha` extra), or the integration does not load in tests.
- **Home Assistant 2026.9+ uses `probatio`** instead of `voluptuous` for flow and WebSocket schemas; hence
  `"homeassistant": "2026.9.0"` in `hacs.json`.
- Integration tests: the MQTT thread leaves a timer, `tests/integration/conftest.py` sets `expected_lingering_timers`;
  the `mqtt_mock` fixture gives MQTT without a broker.
- **mypy runs twice** (`make types`): the engine and tools as the package `engine` (`MYPYPATH=custom_components/outglow`)
  and the integration as `custom_components.outglow`; one run over both reports "source file found twice". For the
  same reason tests and tools import the engine as `import engine` (the root `engine.py` loads the package) and the
  integration as `from .engine import …`; do not mix them in one test. `custom_components/outglow` is never put on
  `sys.path`: the platform `select.py` would shadow the standard library's `select`.
- **ruff** would format code blocks in Markdown; `*.md` is excluded in `pyproject.toml`.
- **Loop time**: `tests/integration/test_loop_time.py` measures the CPU time of the event loop thread per call
  (architecture 3.10). On a slow or busy machine `OUTGLOW_LOOP_TIME_SCALE=2` doubles its budgets, and those of the
  CPU-time checks of the plan import and the engine cost estimate (`tests/integration/test_valetudo.py`); with `CI`
  set (GitHub Actions) the default is 2, otherwise 1, the budget for users' hardware.
- **Node**: versions are pinned exactly; `npm ci` from the lockfile. The Playwright tests use Chrome by default
  (`PW_CHANNEL=chromium` in the Docker image) and WebKit for the focus tests; `PW_PORT` changes the demo server's port.

## Releasing

1. Set the version in `custom_components/outglow/manifest.json` (and `pyproject.toml`, `frontend/package.json`).
2. Commit, then tag: `git tag -a v0.1.0 -m "Outglow for Home Assistant 0.1.0" && git push origin v0.1.0`.
3. `.github/workflows/release.yml` checks that the tag matches `manifest.json`, builds the frontend, zips the content
   of `custom_components/outglow` into `outglow.zip` (as `hacs.json` expects) and publishes a GitHub release with
   generated notes. A tag with a suffix (`v0.1.0-rc.1`) makes a pre-release.
