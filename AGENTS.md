# AGENTS.md

Instructions for agents and contributors working in this repository.

## Stack

- Plain HTML, CSS and ES2020 JavaScript modules, plus the Canvas 2D API.
- No build step and no third-party dependencies; modules load directly in the
  browser.
- Node.js >= 18 for the test runner (`node:test`).

## Repository layout

- `index.html` - page shell; declares the `<canvas>` the game mounts into.
- `styles.css` - presentation only.
- `src/core/` - pure game logic (state, rules, maths). Must not touch the DOM,
  `window`, `document` or any other browser API, so it stays unit-testable under
  Node.
  - `constants.js` - all tuning values (tick rate, tiles, weapons, vehicles,
    wanted thresholds).
  - `geometry.js` - vector, angle and collision maths.
  - `rng.js` - seeded pseudo-random number generator.
  - `game.js` - game state, the fixed-timestep `update()`/`advance()` loop,
    events, missions wiring and terminal outcomes.
  - `map.js` - deterministic city map, tile collision and camera clamping.
  - `player.js` - player movement, aim, health and armour.
  - `weapons.js`, `bullet.js` - weapon handling and swept projectiles.
  - `enemy.js`, `ai.js` - enemy archetypes, loot, line-of-sight and AI.
  - `vehicle.js` - arcade driving, run-overs and explosions.
  - `mission.js` - objective state machine and rewards.
  - `pickup.js` - health/armour/ammo/cash collection rules.
  - `wanted.js` - crime points, wanted stars, decay and police escalation.
- `src/ui/` - browser-coupled code.
  - `input.js` - keyboard/mouse events reduced to a plain intent object.
  - `render.js` - camera-transform world rendering with procedural sprites (no
    external assets).
  - `hud.js` - health/armour/ammo/weapon/wanted/cash/objective HUD.
  - `storage.js` - best-score persistence with an in-memory fallback.
- `src/main.js` - bootstrap; wires `src/core` and `src/ui` together and owns the
  `requestAnimationFrame` loop.
- `test/` - Node unit tests using the built-in `node:test` runner.
- `.github/workflows/ci.yml` - CI; runs the test suite on every push and PR.
- `.github/pull_request_template.md` - pull request checklist.
- `README.md` - run/test instructions, controls, rules, data model and
  acceptance criteria.

## Conventions

- Keep pure logic in `src/core/` and browser-coupled code in `src/ui/`.
- Prefer small, pure functions with JSDoc type hints.
- Express gameplay timings in simulation ticks, not seconds, so behaviour is
  independent of the render rate.
- Tests live in `test/` and use the built-in `node:test` and `node:assert`
  modules; name files `*.test.js` and add a test for every new behaviour.
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

`npm start` runs the same static server.

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
- `README.md` and `AGENTS.md` are updated when layout or behaviour changes.
- A pull request is open and has been reviewed before merging to `main`.
