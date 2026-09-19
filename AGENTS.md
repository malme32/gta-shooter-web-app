# AGENTS.md

Instructions for agents working in this repository.

## Stack

- Plain HTML, CSS and ES2020 JavaScript modules, plus the Canvas 2D API.
- No build step and no third-party dependencies.
- Node.js >= 18 for the test runner (`node:test`).

## Repository layout

- `index.html` - page shell; declares the `<canvas>` the game mounts into.
- `styles.css` - presentation only.
- `src/core/` - pure game logic (state, rules, maths). Must not touch the DOM,
  `window`, `document` or browser APIs, so it stays unit-testable under Node.
- `src/ui/` - browser-coupled code: rendering, input handling and audio.
- `src/main.js` - bootstrap; wires `src/core` and `src/ui` together and owns the
  `requestAnimationFrame` loop.
- `test/` - Node unit tests using the built-in `node:test` runner.
- `.github/workflows/ci.yml` - CI; runs the test suite on every push and PR.
- `.github/pull_request_template.md` - pull request checklist.

## Conventions

- Keep pure logic in `src/core/` and browser-coupled code in `src/ui/`.
- Prefer small, pure functions with JSDoc type hints.
- Tests live in `test/` and use the built-in `node:test` and `node:assert`
  modules; name files `*.test.js`.
- Do not introduce third-party runtime dependencies. If a build step ever
  becomes necessary it must be agreed first.
- Never commit directly to `main`. Work on a branch named `agent/<task-slug>`
  and open a pull request.
- Never force-push.

## Commands

Run the game locally:

```sh
python3 -m http.server 8000
# open http://localhost:8000/
```

Run the tests:

```sh
node --test test/
# or
npm test
```

## Definition of done

- Changes are committed on a feature branch `agent/<task-slug>`.
- `node --test test/` exits 0.
- `python3 -m http.server 8000` serves `index.html` without errors.
- No third-party dependencies are introduced.
- A pull request is open and has been reviewed before merging to `main`.
