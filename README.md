# GTA-style top-down shooter

A dependency-free top-down shooter web game built with plain HTML, CSS,
ECMAScript 2020 modules and the Canvas 2D API. There is no build step and no
third-party runtime dependency.

This repository is currently at **T1: scaffold**. It contains the project
skeleton, conventions and CI only; no game code has landed on `main` yet.

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

- T1 (this task): repository scaffold, page shell, CI and PR template.
- Game code arrives in later tasks and is never committed directly to `main`.

## Contributing

Open a branch named `agent/<task-slug>`, keep changes focused, run the tests,
and raise a pull request for review. See `AGENTS.md` for the full conventions.
