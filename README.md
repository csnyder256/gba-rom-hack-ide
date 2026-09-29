# gba-rom-hack-ide

**Edit a Pokemon GBA decomp project visually or in plain English, then build and play the ROM in your browser.**

![Node](https://img.shields.io/badge/node-22%20LTS-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/typescript-5.4%20strict-3178C6?style=flat-square&logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/react-18%20%2B%20vite%205-61DAFB?style=flat-square&logo=react&logoColor=black)
![Python](https://img.shields.io/badge/python-3.12%20sidecar-3776AB?style=flat-square&logo=python&logoColor=white)
![MCP tools](https://img.shields.io/badge/MCP%20tools-71%20registered-8A63D2?style=flat-square)
![Tests](https://img.shields.io/badge/tests-328%20vitest%20files-brightgreen?style=flat-square)
![Status](https://img.shields.io/badge/status-work%20in%20progress-orange?style=flat-square)

A locally hosted web IDE for Pokemon GBA ROM hacking. You point it at a
decompilation project on disk. It classifies the project, scans it into one
typed manifest, and renders that manifest as a navigable game: maps, warps,
triggers, object events, dialogue, flags and variables, wild encounter tables,
trainers and their parties, species, moves, learnsets, abilities, items, and
the type chart. You edit through visual editors, or you type an instruction in
English and an agent proposes a diff you approve. Then one click runs
`make modern` through devkitARM and boots the resulting `.gba` in an embedded
mGBA WebAssembly build.

Everything runs on `127.0.0.1`. Nothing is uploaded anywhere.

---

## What is not in this repository

This repo is **tooling only**. It contains no ROMs, no ROM images, no
decompilation dumps, no extracted graphics, audio, text, or save data, and no
binary patches derived from a commercial game. The tool operates on **a
decompilation project and ROM files that you supply yourself**, and you are
responsible for supplying a legally obtained copy.

The `.gitignore` header states the rule in the repo's own words:

```
# HARD RULE: no commercial or derivative ROM images, no built
# patches, no decompilation dumps, no extracted game assets.
# You supply your own legally-obtained ROM / decomp project.
```

- `corpus/` is the drop-zone for your own ROMs. It is git-ignored; only
  `README.md` and `.gitkeep` are tracked. See [`corpus/README.md`](corpus/README.md).
- `.gitignore` blocks `*.gba`, `*.gbc`, `*.gb`, `*.nds`, `*.sav`, `*.srm`,
  `*.bps`, `*.ips`, `*.ups` and `*.xdelta` repo-wide, not only at the root.
- `signatures/gen3-vanilla.json` is a small identifier and fingerprint table.
  `symbols/` and the per-ROM-family databases under
  `app/frontend/src/lib/symbols/data/` ship empty by design; regenerate them
  with `node scripts/build-symbols.mjs` and
  `node scripts/build-vanilla-frlg-truth.mjs` against your own decomp
  checkout.

Pokemon and related names are trademarks of Nintendo, Creatures Inc., and
GAME FREAK Inc. This is an unaffiliated, non-commercial fan tool.

---

## The problem

There are two ways to change a Pokemon GBA game, and neither of them gives you
an editor.

The old way is binary patching. You open a `.gba` image in a hex-aware tool,
find the table you want, and write bytes. It works, it is fast, and it falls
apart as soon as you want to add something the original ROM has no room for.
Free space hunting, repointing, and one-off patches accumulate until nobody,
including you, can say what the ROM now contains.

The new way is a decompilation project: pret's `pokefirered` and friends, real
C source that compiles back to a byte-matching ROM. It removes every limit the
binary imposed. What it costs you is the editor. The game is now thousands of
files of C, headers, `.inc` scripts, `.json` map data and PNG tilesets. Editing
a trainer's party means finding the right block in the right file and not
breaking the build.

This project is the missing middle. It treats the decomp tree as the source of
truth, reads it into one typed manifest, renders that manifest as something you
can click through, and writes changes back into the real C source. Compiling
and playing are part of the inner loop rather than a separate step you leave
the tool to perform.

## The design constraints that shaped it

**Never own the data.** The decomp project stays exactly where you cloned it.
The tool writes only inside an `.editor/` directory it creates in your project
(the manifest, the op-log, annotations, save-states, cached scans and agent
scratch) and otherwise only edits files the project already had.

**Every write is surgical.** A field edit rewrites the value span of one named
field. Macros, `#if` guards, comments, and fields the tool does not model
survive verbatim, because the next `make` has to succeed.

**The AI never touches disk directly.** Agent tools produce proposals. A
proposal becomes a diff card you read and approve, and only then does a patch
applier write it.

**Prove it by building.** The definition of a working edit is a ROM that
compiles and boots, not a passing unit test.

> **Note on screenshots.** This README has none yet. The interface is the
> product, so that is a real gap, and it is called out here rather than papered
> over.

---

## Parts worth opening

**1. One generic C struct-block editor under eight data editors.**
`app/backend/src/scan/data/struct-block.ts` (159 lines) parses decomp files
shaped as `[ID] = { .field = value, ... }` arrays and rewrites only the value
span of named fields. Moves, abilities and items use that parser and rewriter
directly. Learnsets and encounters reuse its bracket matcher over a
`LEVEL_UP_MOVE(...)` macro list and over `wild_encounters.json`. Species, the
type chart and trainers have their own format-specific in-place writers built
to the same discipline. Every one of those writes goes through a
tmp-file-plus-rename, so a crash cannot leave the decomp half-written.

**2. An MCP server that turns a general coding agent into a game editor.**
`app/backend/src/agent/mcp-server.ts` (1,217 lines) registers 71 tools against
the open project. `agent/tools/` holds 71 tool modules (59 of them named
`propose-*`) alongside 21 colocated test files, so all 71 modules are
registered: trainer parties, species stats, encounter slots, script edits, map
creation, sprite and music import, story specs. Readers include
`get_workspace_summary`, `find_references_to`, `read_map` and
`read_decoded_script`. `spawner.ts` launches the `claude` CLI as a child
process wired to that MCP config and streams `stream-json` turn events over a
WebSocket. Proposals land in a patch store, surface as a reviewable diff, and
are applied only by `patch-applier.ts`.

**3. A build recipe that is genuinely fiddly, encoded once.**
`app/backend/src/build/decomp-build.ts` shells into devkitPro's MSYS2 login bash
and runs:

```
export PATH="$DEVKITARM/bin:$PATH"; cd <project>; make modern -jN CPP=/usr/local/bin/arm-none-eabi-cpp
```

Three facts are baked in with comments explaining why. The MSYS2 login shell
sets `DEVKITARM` but does not put `$DEVKITARM/bin` on `PATH`. `make modern`
picks the GCC path and skips agbcc. The `CPP` override points at a CR-stripping
wrapper, because devkitARM emits CRLF that chokes pret's `preproc` and
`trainerproc`. Builds run as polled async jobs with a 200,000-character
in-memory log cap and a 30 minute ceiling, and failures come back as a one-line
plain-English summary next to the raw log.

**4. Story-order navigation instead of alphabetical.**
`parseMapSectionOrder` in `app/backend/src/scan/decomp.ts` (line 34) reads
`include/constants/region_map_sections.h` into the game's own `MAPSEC_*`
ordering, so the navigator lists Pallet, Viridian, Pewter and onward rather
than Route1, Route10, Route2.

Beyond the app there is a standalone binary-ROM introspection engine
(`engine/`) with LZ77 encode and decode, pointer table discovery and
clustering, 4bpp tile and palette codecs with hand-rolled PNG encode and
decode, per-domain detectors, a cartridge coverage metric, and NDS
NARC/NitroFS readers. Read the status section before assuming it is on the main
path.

**Pinned versions:** react 18.3.1, vite 5.4.7, typescript 5.4.5, vitest 1.6.1,
zustand 4.5.5, pixi.js 8.4.1, reactflow 11.11.4, `@thenick775/mgba-wasm` ^2.4.1
(the one caret range in the list),
fastify 4.28.1, `@fastify/websocket` 10.0.1, postgres:16-alpine,
qdrant/qdrant:v1.11.3.

---

## How it works

```
  app/frontend (React 18 + Vite 5 + Zustand)
    navigator (MAPSEC order) | PixiJS map canvas | inspector registry
    data editors | agent panel (WebSocket) | EmulatorHost (mgba-wasm)
        |
        |  app/shared: one typed contract, imported by both sides
        v
  app/backend (Fastify 4, 127.0.0.1:8717)
    detect/  ->  scan/  ->  decomp/ writers  ->  events/ op-log
    agent/ (MCP server + spawner + patch store + patch applier)
    build/ (devkitARM job runner)    engine-client.ts    tile-intel/
        |                                  |                  |
        v                                  v                  v
  YOUR decomp project on disk        engine/ (legacy)   tile-intel-svc
  + .editor/manifest.json            binary ROM intro   FastAPI :58080
                                                        Postgres :15432
                                                        Qdrant   :16333
```

```
open project
  -> detect/          classify decomp | patch | hybrid
  -> scan/            parse into <projectRoot>/.editor/manifest.json
  -> frontend         render manifest as a navigable world

edit visually:   PATCH route -> domain writer -> tmp+rename into decomp source -> op-log
edit in English: WebSocket -> spawner -> claude CLI -> MCP propose_* -> patch store
                 -> diff card -> you approve -> patch-applier -> op-log

Build & Play:    make modern job -> .gba -> mGBA-wasm in the browser
```

Both edit paths land in the same op-log (`events/op-log.ts`), so undo, redo and
the project timeline behave identically whether a change came from a visual
editor or from an approved AI patch.

| Tier | Size | Role |
|---|---|---|
| `app/shared/src` | 19 files, 2,924 lines | Every type that crosses the wire, defined once, imported by both sides |
| `app/backend/src` | 254 files, 70,721 lines | Fastify server, detection, scanners, atomic decomp writers, op-log, MCP agent host, build runner |
| `app/frontend/src` | 254 files, 77,414 lines | Map editor, navigator, data editors, inspector registry, PixiJS tile compositor, Zustand stores |
| `engine/src` | 355 files, 62,412 lines (145 of them tests) | Standalone binary-ROM introspection engine, reached only through `engine-client.ts` |
| `tile-intel-svc/src` | 45 Python files, 9,382 lines, 5 Alembic migrations | Optional FastAPI sidecar for semantic and geometric tileset understanding |

Two invariants hold the tiers apart. The backend never re-implements ROM
detection: `app/backend/src/engine-client.ts` is the single sanctioned bridge to
`engine/`. And the Python sidecar never touches ROM bytes. Node mines tilesets
from the on-disk decomp into a canonical Tile-Intel IR JSON, and Python only
consumes that IR. The two schema definitions (Zod in
`app/backend/src/tile-intel/ir-schema.ts`, Pydantic in
`tile_intel/domain/ir.py`) are diffed against each other so they cannot drift
apart silently.

`app/backend/src/routes/projects.ts` is the widest surface: 2,508 lines, 58
route handlers.

---

## Quickstart

### Prerequisites

| Needed for | Requirement |
|---|---|
| Everything | Node.js 22 LTS (enforced via `engines: ">=22.0.0 <23"`) |
| Anything useful | A Pokemon decomp project you cloned yourself, for example [pret/pokefirered](https://github.com/pret/pokefirered) |
| Build & Play | devkitPro / devkitARM, plus its MSYS2 bash on Windows |
| The agent panel | The `claude` CLI on `PATH` |
| Tile intelligence (optional) | Docker Desktop, Python 3.12, `uv` |

### Run it

```powershell
git clone https://github.com/csnyder256/gba-rom-hack-ide
cd gba-rom-hack-ide

.\start.ps1                 # or: node scripts\start.mjs   (start.bat also works)
```

That is the whole first run: the Node stack reads no `.env` file. You choose
your decomp checkout in the app itself (step 1 below), and the backend derives
`ROM_EDITOR_PROJECT_ROOT` from it when it spawns the MCP server.

`.env` is consumed by exactly two things: `docker compose` (the optional
tile-intel tier) and the Python sidecar in `tile-intel-svc/`. If you run
either, `copy .env.example .env` first; `.env.example` documents every variable
with its default.

One gotcha if you run the Docker tier. `docker-compose.yml` reads
`${TILE_INTEL_PG_PASSWORD:?set TILE_INTEL_PG_PASSWORD in .env}`, so compose
fails fast unless you set that variable. Set it, or skip the tier entirely. The
editor degrades gracefully without it.

```powershell
$env:SKIP_TILE_INTEL = "1"; .\start.ps1
```

`scripts/start.mjs` verifies Node 22, runs `npm install` in `app/` if
`app/node_modules` is missing and again in `engine/` if `engine/node_modules`
is missing, builds `@rom-editor/shared` and then the engine package (the
backend resolves `@rom-introspection/engine` from its `dist`), brings up the
Docker tile-intel tier,
starts the backend, polls `http://127.0.0.1:8717/api/health` for up to 30
seconds, starts Vite on `http://localhost:5173`, opens your browser, and tears
both children down on Ctrl+C.

### Then, in the app

1. **Open game project** and point at your decomp directory.
2. It detects and scans. The manifest lands at `<projectRoot>/.editor/manifest.json`.
3. Browse Maps, Game Data, Events, Dialogue. Edit visually, or type an
   instruction in the agent panel and approve the diff it proposes.
4. **Build & Play** runs `make modern` and boots the `.gba` in the embedded
   emulator.

### Manual development flow

```powershell
cd app
npm install
npm run build            # shared -> backend -> frontend
npm run dev:backend      # tsx watch, PORT defaults to 8717
npm run dev:frontend     # vite on 5173
npm run typecheck
npm run lint

cd ..\engine
npm install; npm run build; npm test

cd ..\tile-intel-svc
uv sync --extra dev; uv run pytest
docker compose up -d     # from the repo root
```

---

## Project layout

```
app/
  shared/src/          typed contract shared by backend and frontend
  backend/src/
    detect/            decomp vs patch vs hybrid classification
    scan/              per-domain parsers -> manifest
      data/            struct-block.ts + 8 data-editor schemas
    decomp/            atomic writers (map, layout, tileset, trainer)
    build/             toolchain detection, runner, decomp-build.ts
    events/            op-log, undo, asset import, share package
    agent/             mcp-server.ts, spawner.ts, patch-store, patch-applier
      tools/           71 tool modules (59 propose-*), all 71 registered
    routes/            projects.ts (58 handlers), agent.ts, tile-intel.ts, health.ts
    engine-client.ts   the ONLY bridge to engine/
  frontend/src/
    components/        215 files (55 of them tests): map editor, navigator,
                       agent panel, EmulatorHost
    inspectorPanels/   20 entity kinds registered against 13 panel components,
                       behind a registry
    lib/               pure logic: tile compositing, cross-refs, emulator memory readers
    state/             Zustand stores
engine/src/            36 domain modules: rom, pointers, graphics, compression,
                       maps, battle, detection, emulator, save-data, nds, ...
tile-intel-svc/        FastAPI sidecar plus Alembic migrations
scripts/               start.mjs plus a regenerator for every excluded asset
symbols/, signatures/  identifier tables (symbols/ ships empty; regenerate)
corpus/                intentionally empty and git-ignored; you supply ROMs here
docs/                  MASTER_PLAN.md, COMPLETION_REPORT.md, BACKLOG.md,
                       DESIGN-PRINCIPLES.md (the `PD n` glossary the source
                       comments cite)
tests/smoke.mjs        631-line real-HTTP smoke script against the built backend
```

---

## Testing

Vitest throughout, with `*.test.ts(x)` colocated next to sources.

| Suite | Surface | How to run |
|---|---|---|
| All TypeScript workspaces | 328 test files, 3,632 `it`/`test` call sites | `cd app && npm test` |
| Engine | 145 of those files live under `engine/src` | `cd engine && npm test` |
| Backend integration smoke | 1 script, real HTTP on port 18717 | `node tests/smoke.mjs` |
| Python sidecar | 21 `test_*.py` files | `cd tile-intel-svc && uv run pytest` |

Those are surface counts, not pass rates. No suite was executed to produce the
numbers in this README; they come from counting files and call sites on disk.

Backend tests drive Fastify through `app.inject` and `injectWS`, with an
injectable `spawnFn` so the agent CLI is faked rather than launched. Frontend
tests use jsdom and Testing Library.

**Read this caveat.** `docs/MASTER_PLAN.md` records the project's own audit
finding that an earlier green suite was hiding broken features: tests ran
against synthetic `0xff` ROMs, `corpus/` was empty, agent-tool tests mocked the
apply step, and there was no end-to-end coverage. The rule adopted afterward
was "real cloned project, not fixtures; build-or-render to prove."
Post-pivot verification is therefore partly manual but documented: real
`make modern` builds with exit code and ROM size recorded, plus logged emulator
runtime drives. Treat the unit counts above as unit counts, not as proof the
product works.

---

## Status, honestly

This is a working single-operator tool, not a released product. Three things a
reader should know before opening the code.

**It pivoted, and the old path is still in the tree.** It began as a binary ROM
patcher. `docs/MASTER_PLAN.md` ("The Decomp Pivot") contains the owner's own
audit of why that failed: roughly 40% of tiles rendered grey, the emulator
threw on boot, and the Python sidecar was unused scaffolding. The project
re-founded itself on editing decomp source and compiling with `make`. The
binary path (`scan/binary-rom*.ts`, `engine/`, `events/patch-gen.ts`) is now
legacy and quarantined, but still present and still imported in places. It is
62,412 of the 213,471 first-party TypeScript lines here, about 29 percent, so
the headline line count is not the line count of the live product.

**`docs/COMPLETION_REPORT.md` is history, not status.** It declares
"v1-complete, 608/608 tests pass". That report predates the pivot and
`MASTER_PLAN.md` supersedes it: line 13 records that every prior "massive
overhaul" was "declared complete and wasn't". It is kept because the contradiction
is part of the record.

**What ran against a real cloned project.** `MASTER_PLAN.md` records these
figures from a real pokefirered-expansion checkout, not fixtures: 1,104
learnsets, 469 wild encounter tables, 664 trainers with editable parties,
33,585 decoded script steps across 8,821 labels, 882 flags and 167 variables.
Story order came out as Pallet, Viridian, Pewter, Cerulean and onward. The
eight data editors, trainer `.party` editing, readable script decoding, and
one-click Build & Play were all exercised against that project.

Map rendering is the honest soft spot. `scan/tileset-render.ts` composites
metatiles from the decomp's own tileset PNGs and the PixiJS canvas draws them,
but `MASTER_PLAN.md` line 143 says plainly "do not reinvent the tile renderer"
and proposes launching Porymap as a subprocess instead. Treat the in-app
renderer as present and improving, not as proven correct.

### What was removed from the public copy

The private working tree carried things that cannot ship. They are absent from
this repository:

- All built and base `.gba` images, `.sav` files, and `.bps`/`.ips` patches,
  because they are derivative works of a commercial game.
- The vendored pret decompilation checkout. Clone it yourself from upstream.
- The per-ROM-family symbol databases under
  `app/frontend/src/lib/symbols/data/` (`firered-vanilla.json`,
  `emerald-vanilla.json`, `firered-cfru.json`, `firered-cfru-dpe.json`,
  `emerald-expansion.json`). Those are bulk extractions of game content: map
  lists, wild encounter tables, and species / move / item / ability rosters.
  Regenerate them from your own decomp checkout with `build-symbols.mjs` and
  `build-vanilla-frlg-truth.mjs`. The two files that do ship in that directory
  are `gen3-universal.json` (the engine's own opcode / tile-behavior /
  weather vocabulary, hand-written here) and `npc-graphics.json` (display
  labels for sprite ids); see that directory's `README.md` for the reasoning.
- The built CFRU / CFRU+DPE `.bps` patches. `cfru.json` and `dpe.json` ship as
  placeholders with `"built": false`; build the real thing from your own CFRU
  and DPE clones with `scripts/build-cfru-bundle.mjs`.
- Bulk generated tile corpora derived from the decomp and from Pokemon
  Essentials.
- The prebuilt third-party `midi2agb` binary.
- Local agent-harness session state, `node_modules`, virtualenvs, build output,
  and run artifacts.

This repository contains no credentials. The local-development Postgres
password that used to be a literal is now required from the environment
(`docker-compose.yml` reads
`${TILE_INTEL_PG_PASSWORD:?set TILE_INTEL_PG_PASSWORD in .env}`).

`scripts/` keeps the regenerator for every excluded asset, so a reader can
rebuild them legally from their own sources: `build-symbols.mjs`,
`build-tile-intel-corpus.mjs`, `build-midi2agb.mjs`, `build-pret-behaviors.mjs`,
`build-vanilla-frlg-truth.mjs`, and the two CFRU bundle builders. Nothing
needed to run the editor was removed, but you do have to bring your own decomp
project and your own ROM.

The editor degrades honestly without them. With no symbol database generated,
every flag, var, song, species, move, ability and item shows a synthetic id
instead of its pret constant name, and the project panel says so and points at
the generator. With no CFRU bundle built, `cfru.json` and `dpe.json` carry
`"built": false` and the Modernize feature refuses with a message naming the
build script rather than failing halfway.

---

## License

MIT. See [LICENSE](LICENSE).

One caveat a permissive license does not override: the "Modernize" integration
path targets Complete Fire Red Upgrade, whose upstream terms are
non-commercial. Those terms still apply to that path.

Built by Cade (https://github.com/csnyder256)


## Release downloads and deployment

[Latest release](https://github.com/csnyder256/gba-rom-hack-ide/releases/latest) · [Install, deploy and upgrade](DEPLOYMENT.md)

Release assets include checksums and version-specific notes.
