# GTA-style top-down shooter

A dependency-free top-down shooter web game built with plain HTML, CSS,
ECMAScript 2020 modules and the Canvas 2D API. There is no build step and no
third-party runtime dependency.

This repository is currently at **T2: core foundations**. It contains the
project skeleton and the pure simulation core (constants, geometry, seeded
rng, event bus and the fixed-timestep loop). Rendering, input and audio hook
in later tasks.

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
- T2 (this task): pure core foundations - `src/core/constants.js`,
  `src/core/geometry.js`, `src/core/rng.js` and `src/core/game.js` with the
  fixed-timestep `advance()` accumulator; `src/main.js` drives it from a
  `requestAnimationFrame` loop.
- Rendering, input and audio arrive in later tasks and are never committed
  directly to `main`.

## Contributing

Open a branch named `agent/<task-slug>`, keep changes focused, run the tests,
and raise a pull request for review. See `AGENTS.md` for the full conventions.
