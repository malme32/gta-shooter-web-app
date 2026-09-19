# GTA-style top-down shooter

A dependency-free top-down shooter web game built with plain HTML, CSS,
ECMAScript 2020 modules and the Canvas 2D API. There is no build step and no
third-party runtime dependency.

This repository is currently at **T4: player movement, aim, health and camera
follow**. It contains the project skeleton and the pure simulation core
(constants, geometry, seeded rng, the fixed-timestep loop, the city map with
collision and clamping, and the player entity with a dead-zone camera follow),
plus keyboard/mouse input in `src/ui/input.js`. Audio hooks in a later task.

## Run

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000/>.

## Tests

```sh
node --test test/
# or
npm test
```

Node.js >= 18 is required (the tests use the built-in `node:test` runner).

## Layout

- `index.html` - page shell and `<canvas>` mount point.
- `styles.css` - presentation only.
- `src/core/` - pure, framework-free game logic (no DOM access).
- `src/ui/` - browser-coupled code: rendering, input, audio.
- `src/main.js` - bootstrap and animation loop.
- `test/` - Node unit tests (`node:test`) for the core and pure UI helpers.

## Status

- T1: repository scaffold, page shell, CI and PR template.
- T2: pure core foundations - `src/core/constants.js`, `src/core/geometry.js`,
  `src/core/rng.js` and `src/core/game.js` with the fixed-timestep `advance()`
  accumulator; `src/main.js` drives it from a `requestAnimationFrame` loop.
- T3: `src/core/map.js` - a deterministic ~100x100 tile grid
  (`ROAD`/`SIDEWALK`/`BUILDING`/`GRASS`), named spawn points, pure circle-vs-tile
  collision (`circleCollides`, `moveCircle`) and `clampCamera`.
- T4 (this task): `src/core/player.js` - eight-direction movement with
  normalised diagonals, sprint, mouse aim and armour-before-health damage;
  `src/ui/input.js` - keyboard/mouse events reduced to a plain intent object;
  dead-zone + lerp camera follow in `src/core/game.js`; `src/main.js` renders the
  camera view, aim indicator and a health/armour HUD.
- Audio arrives in a later task and is never committed directly to `main`.

## Contributing

Open a branch named `agent/<task-slug>`, keep changes focused, run the tests,
and raise a pull request for review. See `AGENTS.md` for the full conventions.
