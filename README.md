# GTA-style top-down shooter

A dependency-free top-down shooter web game built with plain HTML, CSS,
ES2020 modules and the Canvas 2D API. There is **no build step, no bundler and
no third-party runtime dependency** — the browser loads the ES modules directly.
The game runs entirely client side; there is no server, database or network
access at runtime.

This document is written so a new contributor can clone the repository, run the
game, run the tests and understand the rules without reading the source first.
Every tuning number quoted below lives in `src/core/constants.js` or the module
that owns the rule, so the constants are the single source of truth.

## Run it

Requires Node.js >= 18 (only for the tests) and any static file server. Python 3
is the simplest:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000/> in a modern browser. You must use a server:
opening `index.html` directly from the filesystem breaks ES module loading.

`npm start` is an alias for the same command:

```sh
npm start
```

## Test it

The tests use the built-in `node:test` runner and `node:assert` — no test
framework to install.

```sh
node --test test/
# or
npm test
```

The suite must exit 0. It covers the pure core and the pure helpers in
`src/ui/`; the `draw*` functions are not unit tested because they need a real
canvas.

## Controls

| Action | Input |
| --- | --- |
| Move (8-directional, diagonals normalised) | `W` `A` `S` `D` or the arrow keys |
| Sprint | hold `Shift` |
| Aim | move the mouse (aims at the pointer in world space) |
| Fire | hold the left mouse button, or `Space` while on foot |
| Reload | `R` |
| Select weapon | `1` (pistol), `2` (SMG), `3` (shotgun) |
| Cycle weapon | mouse wheel |
| Enter / exit the nearest vehicle | `E` |
| Handbrake (while driving) | hold `Space` |
| Restart after a terminal outcome | `Enter` (`NumpadEnter` also works) |

`Space` is context sensitive: it fires while on foot and is the handbrake while
driving. Arrow keys, `Space` and `Enter` have their browser default suppressed.

## Gameplay rules

### Simulation loop

The simulation runs at a fixed 60 Hz (`TICK_HZ`). `src/main.js` feeds the real
frame delta into a fixed-timestep accumulator (`advance()`), which runs whole
ticks and clamps both the delta and the number of catch-up steps so a
backgrounded tab cannot spiral. The renderer interpolates between the previous
and current tick, so movement is smooth on 120/144 Hz displays without changing
gameplay. All timings that affect gameplay are expressed in **ticks**, never in
seconds, so behaviour is independent of the render rate.

### Map and collision

- The map is a 100 x 100 tile grid (`TILE_SIZE` 32 px, so 3200 x 3200 world
  pixels) generated deterministically from a seed (`1337` in `src/main.js`).
- Tile palette: `ROAD`, `SIDEWALK` and `GRASS` are walkable; only `BUILDING`
  blocks movement. Out-of-bounds tiles count as buildings, so the map edge is an
  impenetrable wall.
- Circles (player, enemies, vehicles, bullets) collide against tiles. Movement
  is resolved one axis at a time and sub-stepped, so entities slide along walls
  instead of sticking and cannot tunnel through a building.
- Named spawn points are generated with the map (`spawns.playerStart`,
  `vehicleSpawns`, `enemySpawns`, `pickupSpawns`, `missionSpawns`).

### Player

- 100 health and 0 starting armour, both capped at 100. Damage drains **armour
  first**, then health; a player at 0 health is dead.
- Base walk speed 160 px/s; sprint multiplies it by 1.6 (256 px/s).
- The camera follows with a dead-zone and per-tick interpolation, clamped so the
  viewport never shows outside the map.

### Weapons

Weapon tuning is the `WEAPONS` table. `fireDelayTicks`, `reloadTicks` and
`spread` are all tick-based. Player-selectable slots are `1`/`2`/`3`
(`WEAPON_SLOTS`); a `rifle` is defined in the table for reuse but has no number
key.

| Weapon | Damage | Fire delay | Magazine | Reserve | Pellets | Automatic |
| --- | --- | --- | --- | --- | --- | --- |
| Pistol | 25 | 14 ticks | 12 | 120 | 1 | no |
| SMG | 12 | 6 ticks | 30 | 240 | 1 | yes |
| Shotgun | 14 per pellet | 45 ticks | 6 | 36 | 10 | no |
| Rifle | 34 | 20 ticks | 20 | 120 | 1 | yes |

Each weapon keeps its own magazine, reserve and cooldown, so switching preserves
ammo and cannot grant a free shot. `spreadRad` is the **half-angle** of the
firing cone; all pellet offsets satisfy `|offset| <= spreadRad` (multi-pellet
weapons fan evenly, single-pellet weapons draw one offset from the rng).
Reloading moves rounds from reserve to magazine when the countdown reaches zero.

### Bullets

Projectiles sweep their whole movement each tick and stop at the first solid
tile, so a fast round can never skip a one-tile wall. Target collision uses the
same swept segment, so a target between two ticks cannot be missed. A round
never hits its owner, and its lifetime is derived from range and muzzle
velocity.

### Vehicles

- Health 200. Arcade throttle/steer/friction; steering scales with signed speed,
  so a stationary car cannot pivot and reverse mirrors the steering. The
  handbrake brakes hard (1200 px/s^2) and multiplies steering for a drift feel.
- Top speed 320 px/s forward, 140 px/s reverse; hitting a building scrubs 75% of
  the speed. `E` enters the nearest vehicle within 64 px and exits to a spot
  where the player circle fits (exiting is blocked rather than placing the player
  in a wall).
- Run-over damage applies once per contact to entities the car touches at
  >= 80 px/s, scaled from 50% to 100% of 40 damage by impact speed. Slowing
  below the threshold mid-contact does not re-arm the hit.
- A destroyed vehicle explodes: 80 damage to everything in a 96 px radius, and
  it adds **25 wanted points**. A blast that writes off another vehicle
  chain-detonates it.

### Enemies and AI

| Archetype | Health | Armour | Weapon | Sight |
| --- | --- | --- | --- | --- |
| Thug | 60 | 0 | pistol | 340 px |
| Shooter | 80 | 0 | SMG | 460 px |
| Brute | 220 | 50 | shotgun | 300 px |

The AI is an `idle -> patrol -> chase -> attack` state machine. Enemies acquire
the player with a tile-aware line of sight (an exact ray test, so it cannot see
through walls), chase and steer with wall sliding, and fire on their archetype's
cadence when in attack range. They give up after losing sight for a per-archetype
number of ticks. Death reaps the enemy, adds a kill to the score, records the
elimination against the active mission, and rolls a seeded weighted loot drop.

### Wanted level and police

Committing crimes adds **wanted points**, which map onto 0-5 stars through
`WANTED_THRESHOLDS`:

```text
points:   0   10   40   90   160   260
stars:    0    1    2    3     4     5
```

Points are held for a 300-tick (5 s) crime-free cooldown, then decay at 0.5
points per tick (30/s); any fresh crime resets the cooldown. The documented
`WANTED_CRIMES` table is:

| Crime | Points |
| --- | --- |
| gunfire | 5 |
| assault | 12 |
| vehicle_theft | 15 |
| hit_and_run | 20 |
| vehicle_destroyed | 25 |
| police_assault | 30 |
| murder | 45 |

> In the current build only **vehicle explosions** (25 points) add heat
> automatically. `registerCrime()` / `addHeat()` are the public API for wiring
> the remaining crimes.

Each star level maintains a police roster (`POLICE_COMPOSITION`), weakest first:
level 1 `cop`; level 2 two `cop`s; level 3 two `cop`s + `swat`; level 4
`cop` + three `swat`; level 5 `cop` + two `swat` + two `riot`. Police spawn on a
walkable ring 8-14 tiles from the player at most once per 90 ticks, and the
excess despawns when the level falls (level 0 clears the force). A `siren` event
fires on every level change and the HUD siren blinks red/blue. Reaching five
stars starts the chase but does **not** end the run: a responding officer must
come within `POLICE_CAPTURE_RANGE` (26 px plus both radii) to bust the player.

| Police | Health | Armour | Weapon |
| --- | --- | --- | --- |
| Cop | 90 | 10 | pistol |
| SWAT | 140 | 50 | SMG |
| Riot | 260 | 90 | shotgun |

### Missions

A mission is a small pure state machine over `inactive -> active -> complete`:

- **eliminate** — destroy `targetCount` hostiles. Police kills do not count
  unless the mission explicitly filters on a police archetype. The reward is paid
  exactly once.
- **reach** — stand within `radius` (default 48 px) of the marker.

The default campaign is built from the map: an `eliminate` mission sized to the
enemy squad (capped at 12), followed by one `reach` mission per
`spawns.missionSpawns` checkpoint. The default reward is 250 cash. Completing a
non-final mission ends the run in `missionComplete` so `Enter` resumes the
campaign at the next mission; completing the final mission wins the run.

### Pickups and loot

Pickups are `health`, `armour`, `ammo` or `cash` with defaults 25 / 25 / 60 / 50
and a 10 px collection radius. Health, armour and ammo are clamped to their
ceilings; cash is banked on the game state. Map pickup spawns cycle through the
types, and dead enemies roll their archetype's weighted loot table (chance plus
a weighted type table with amount ranges), so a seeded run always drops the same
loot. Unknown pickup types fall back to cash.

### Score, outcomes and restart

- Score is `cash + 10 * kills` (`SCORE_PER_KILL`), and the best score and cash
  are persisted in `localStorage` under `gta-shooter:best` (with an in-memory
  fallback when storage is unavailable).
- A run ends in exactly one terminal outcome: `wasted` (player died), `busted`
  (arrested at five stars), `missionComplete` (a non-final mission passed) or
  `won` (the final mission passed). The first terminal state wins, so a kill and
  a death on the same tick cannot both claim the run.
- `Enter` calls `restart()`, which rebuilds the world, wanted level and mission
  list. A win restarts at mission 0; a passed mission resumes at the next one;
  a death or arrest replays the mission the run was on.

## Data model

### Map

```js
{ width, height, tiles, blockSize, tileSize, spawns }
```

`tiles` is a flat row-major array of `width * height` tile values.
`createGame()` also accepts a plain `{ width, height, tiles }` grid and validates
it, so hand-authored test maps are valid. Tile values are frozen in
`src/core/constants.js` (`TILE_ROAD`, `TILE_SIDEWALK`, `TILE_BUILDING`,
`TILE_GRASS`).

### Game state

`createGame()` returns the mutable `GameState` consumed by `update()`. The
important fields:

- `map`, `grid` — the source map and its normalised row-major grid.
- `rng`, `seed` — the random source; a numeric seed rewinds on `restart()` for
  reproducibility.
- `tick`, `accumulator` — elapsed ticks and leftover frame time.
- `input` — the `GameInput` intent object, mutated in place across restarts so
  the bound listeners stay valid.
- `player` — the `Player` record (position, aim, health, armour, weapon ammo).
- `bullets`, `nextBulletId`, `targets` — projectiles and extra shootables.
- `enemies`, `nextEnemyId` — live AI actors (police included).
- `pickups`, `nextPickupId`, `cash` — ground loot and banked money.
- `vehicles`, `nextVehicleId` — drivable vehicles.
- `camera`, `cameraDeadZone`, `viewport` — rendering/follow state.
- `heat`, `wanted`, `wantedCooldown`, `policeSpawnTimer`, `busted`, `sirenLevel`,
  `sirenActive` — wanted system.
- `missions`, `missionIndex`, `mission`, `kills` — campaign and score input.
- `outcome`, `gameOver`, `paused` — run lifecycle.
- `events` — a queue drained by `drainEvents()`.

Actor records all carry a stable `id` and a `kind` (`player`, `enemy`,
`vehicle`, `bullet`, `pickup`), because the renderer matches entities across
frames by `id` and picks procedural sprites by `kind`.

### Events

The core emits plain `{ type, tick, ... }` records into `state.events`; the
browser layer drains them each frame. Event types include `muzzle`, `tracer`,
`hit`, `bullet_wall`, `enemy_alert`, `enemy_lost_player`, `enemy_fire`,
`enemy_death`, `loot_drop`, `pickup`, `player_death`, `wasted`, `busted`,
`mission_start`, `mission_complete`, `police_spawn`, `police_despawn`, `siren`,
`vehicle_enter`, `vehicle_enter_failed`, `vehicle_exit`, `vehicle_exit_blocked`,
`vehicle_crash`, `vehicle_explosion` and `run_over`.

## Acceptance criteria

A change is done when all of the following hold. These mirror the project's
definition of done in `AGENTS.md`.

- [ ] A new contributor can run and test the game from this README alone.
- [ ] The controls and rules documented above match the implemented behaviour.
- [ ] Every command in `AGENTS.md` runs as written.
- [ ] `node --test test/` exits 0 (all tests pass), and new behaviour has tests.
- [ ] The game loads over `python3 -m http.server 8000` with no console errors.
- [ ] No build step and no third-party runtime dependency is introduced.
- [ ] The work is committed on a branch `agent/<task-slug>` and opened as a pull
      request against `main`; `main` is never committed to or force-pushed.

## Project layout

- `index.html` — page shell; declares the `<canvas>` the game mounts into.
- `styles.css` — presentation only.
- `src/core/` — pure, DOM-free game logic; unit-testable under Node.
  - `constants.js` — all tuning values; `geometry.js` — vector/geometry maths;
    `rng.js` — seeded PRNG.
  - `game.js` — state, fixed-timestep `update()`/`advance()`, events, outcomes.
  - `map.js` — tile grid, collision and camera clamping.
  - `player.js`, `weapons.js`, `bullet.js` — player, weapons and projectiles.
  - `enemy.js`, `ai.js` — archetypes, loot, line-of-sight and enemy state machine.
  - `vehicle.js` — driving, run-overs and explosions.
  - `mission.js`, `pickup.js`, `wanted.js` — missions, loot pickups and police.
- `src/ui/` — browser-coupled code.
  - `input.js` — keyboard/mouse events reduced to a plain intent object.
  - `render.js` — camera-transform world rendering with procedural sprites.
  - `hud.js` — health/armour/ammo/weapon/wanted/cash/objective HUD.
  - `storage.js` — best-score persistence with an in-memory fallback.
- `src/main.js` — bootstrap; wires core and UI together and owns the frame loop.
- `test/` — Node unit tests (`node:test`), one file per module.
- `.github/workflows/ci.yml` — CI; runs `node --test test/` on every push and PR.
- `.github/pull_request_template.md` — pull request checklist.

## Contributing

Open a branch named `agent/<task-slug>`, keep changes focused, keep pure logic
in `src/core/` and browser code in `src/ui/`, run the tests, and raise a pull
request for review. Never commit directly to `main` and never force-push. See
`AGENTS.md` for the full conventions.
