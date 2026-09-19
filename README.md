# GTA-style top-down shooter

A dependency-free top-down shooter web game built with plain HTML, CSS,
ECMAScript 2020 modules and the Canvas 2D API. There is no build step and no
third-party runtime dependency.

This repository is currently at **T9: wanted system and police escalation**. It
contains the project skeleton and the pure simulation core (constants, geometry,
seeded rng, the fixed-timestep loop, the city map with collision and clamping,
the player entity with a dead-zone camera follow), keyboard/mouse input in
`src/ui/input.js`, the camera-transform renderer and HUD in `src/ui/render.js`
and `src/ui/hud.js`, the weapon/projectile systems in `src/core/weapons.js` and
`src/core/bullet.js`, the vehicle system in `src/core/vehicle.js`, the enemy
archetypes and AI in `src/core/enemy.js` and `src/core/ai.js`, and the wanted
system with escalating police in `src/core/wanted.js`. Audio hooks in a later
task.

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
- T4: `src/core/player.js` - eight-direction movement with normalised
  diagonals, sprint, mouse aim and armour-before-health damage;
  `src/ui/input.js` - keyboard/mouse events reduced to a plain intent object;
  dead-zone + lerp camera follow in `src/core/game.js`.
- T5: `src/ui/render.js` - camera-transform world rendering with
  accumulator-driven interpolation for 120/144 Hz displays, a procedural
  player sprite and procedurally-generated entity sprites (no external assets);
  `src/ui/hud.js` - health, armour, ammo, weapon, wanted and cash placeholders;
  the canvas backing store is scaled by the device pixel ratio in
  `src/main.js`.
- T6: `src/core/weapons.js` - pistol/SMG/shotgun fire rate, spread
  cone, magazines, reserve ammo and reloads, plus `1`/`2`/`3` and wheel weapon
  switching; `src/core/bullet.js` - projectiles with swept (non-tunnelling)
  tile collision, ttl and damage; `muzzle`, `tracer`, `hit` and `bullet_wall`
  events in `src/core/game.js`.
- T8: `src/core/vehicle.js` - arcade throttle/steer/friction with
  building collision, health and explosions; `E` enters/exits the nearest
  vehicle (never onto a building tile), `Space` handbrakes while driving,
  run-over damage and blast damage to nearby entities; vehicle rendering with
  heading interpolation and a driving HUD in `src/ui/render.js` and
  `src/ui/hud.js`.
- T7: `src/core/enemy.js` - thug/shooter/brute archetypes with
  armour-before-health damage, death and seeded loot; `src/core/ai.js` -
  idle/patrol/chase/attack state machine with tile-aware line-of-sight,
  wall-sliding steering and per-archetype fire cadence; enemies spawn from
  `map.spawns.enemySpawns`, drop pickups on death and are collected on contact.
- T9 (this task): `src/core/wanted.js` - wanted points from documented crimes,
  the 0-5 star ladder (`WANTED_THRESHOLDS`), a crime-free decay cooldown and a
  police spawn director; `cop`/`swat`/`riot` police archetypes in
  `src/core/enemy.js` spawn by star level (more and tougher as it rises), level 0
  despawns them, 5 stars is the terminal `busted` state, and a `siren` event is
  emitted on level changes. The HUD shows the wanted stars and a blinking siren.
- Audio arrives in a later task and is never committed directly to `main`.

## Contributing

Open a branch named `agent/<task-slug>`, keep changes focused, run the tests,
and raise a pull request for review. See `AGENTS.md` for the full conventions.
