/**
 * Shared, immutable tuning values for the top-down shooter.
 *
 * Everything here is plain data so it can be imported by both the pure core
 * (`src/core/`) and the browser bootstrap (`src/main.js`) without touching the
 * DOM. Time-based values are expressed in simulation ticks wherever the value
 * affects gameplay, so behaviour is independent of the render rate.
 *
 * @module core/constants
 */

/** Simulation rate. One `update()` call advances the game by one tick. */
export const TICK_HZ = 60;

/** Wall-clock duration of a single simulation tick, in seconds. */
export const TICK_SECONDS = 1 / TICK_HZ;

/**
 * Upper bound on how many ticks a single frame may consume. Caps the work done
 * after the tab has been suspended so the loop cannot spiral.
 */
export const MAX_STEPS_PER_FRAME = 5;

/** Largest frame delta (seconds) fed into the accumulator. */
export const MAX_FRAME_SECONDS = 0.25;

/** Side length of a map tile, in world pixels. */
export const TILE_SIZE = 32;

/** Tile value meaning "walkable floor" (kept for backwards compatibility). */
export const EMPTY_TILE = 0;

/** Tile value meaning "solid wall" (kept for backwards compatibility). */
export const SOLID_TILE = 1;

/**
 * Tile palette used by the city map.
 *
 * `TILE_BUILDING` is the only solid tile; roads, sidewalks and grass are all
 * walkable. The numeric values deliberately keep `TILE_BUILDING === 1` so maps
 * authored before the palette existed (0 = empty, 1 = wall) keep working.
 */
export const TILE_ROAD = EMPTY_TILE;
export const TILE_BUILDING = SOLID_TILE;
export const TILE_SIDEWALK = 2;
export const TILE_GRASS = 3;

/** Every tile value that blocks movement. @type {ReadonlyArray<number>} */
export const SOLID_TILES = Object.freeze([TILE_BUILDING]);

/** Player collision radius, in world pixels. */
export const PLAYER_RADIUS = 12;

/** Vehicle collision radius, in world pixels. */
export const VEHICLE_RADIUS = 18;

/** Player walk speed, in pixels per second. */
export const PLAYER_BASE_SPEED = 160;

/** Speed multiplier applied while sprinting. */
export const PLAYER_SPRINT_MULTIPLIER = 1.6;

/** Player health ceiling. */
export const PLAYER_MAX_HEALTH = 100;

/** Player health on spawn. */
export const PLAYER_STARTING_HEALTH = 100;

/** Player armour ceiling. Damage is absorbed by armour before health. */
export const PLAYER_MAX_ARMOUR = 100;

/** Player armour on spawn. */
export const PLAYER_STARTING_ARMOUR = 0;

/** Default camera viewport width, in pixels (matches the canvas element). */
export const CAMERA_VIEW_WIDTH = 960;

/** Default camera viewport height, in pixels (matches the canvas element). */
export const CAMERA_VIEW_HEIGHT = 540;

/**
 * Half-width of the camera dead-zone. While the player stays within this many
 * pixels of the camera centre the camera does not move.
 */
export const CAMERA_DEADZONE_X = 72;

/** Half-height of the camera dead-zone, in pixels. */
export const CAMERA_DEADZONE_Y = 48;

/**
 * Fraction of the remaining distance the camera closes each tick. A value in
 * `[0,1]`; `1` snaps instantly. Applied per simulation tick so the follow
 * behaviour is independent of the render rate.
 */
export const CAMERA_LERP_PER_TICK = 0.18;

/** Distance (pixels) below which the camera is considered settled. */
export const CAMERA_SETTLE_EPSILON = 0.01;

/** Bullet collision radius, in world pixels. */
export const BULLET_RADIUS = 3;

/** Default weapon id assigned to a new player. */
export const DEFAULT_WEAPON = 'pistol';

/**
 * Weapon tuning table. `fireDelayTicks` and `reloadTicks` are tick counts so
 * they stay deterministic under the fixed timestep.
 *
 * @type {Readonly<Record<string, Readonly<object>>>}
 */
export const WEAPONS = Object.freeze({
  pistol: Object.freeze({
    id: 'pistol',
    name: 'Pistol',
    damage: 25,
    fireDelayTicks: 14,
    bulletSpeed: 720,
    bulletRange: 520,
    spreadRad: 0.02,
    pellets: 1,
    automatic: false,
    magazineSize: 12,
    reloadTicks: 90,
    reserveAmmo: 120,
  }),
  smg: Object.freeze({
    id: 'smg',
    name: 'SMG',
    damage: 12,
    fireDelayTicks: 6,
    bulletSpeed: 780,
    bulletRange: 460,
    spreadRad: 0.06,
    pellets: 1,
    automatic: true,
    magazineSize: 30,
    reloadTicks: 110,
    reserveAmmo: 240,
  }),
  shotgun: Object.freeze({
    id: 'shotgun',
    name: 'Shotgun',
    damage: 14,
    fireDelayTicks: 45,
    bulletSpeed: 640,
    bulletRange: 300,
    spreadRad: 0.18,
    pellets: 10,
    automatic: false,
    magazineSize: 6,
    reloadTicks: 140,
    reserveAmmo: 36,
  }),
  rifle: Object.freeze({
    id: 'rifle',
    name: 'Rifle',
    damage: 34,
    fireDelayTicks: 20,
    bulletSpeed: 900,
    bulletRange: 720,
    spreadRad: 0.01,
    pellets: 1,
    automatic: true,
    magazineSize: 20,
    reloadTicks: 120,
    reserveAmmo: 120,
  }),
});

/**
 * Weapon ids reachable from the number keys, in slot order: `1` selects
 * `WEAPON_SLOTS[0]`, `2` selects `WEAPON_SLOTS[1]`, and so on. The mouse wheel
 * cycles through this same list.
 *
 * @type {ReadonlyArray<string>}
 */
export const WEAPON_SLOTS = Object.freeze(['pistol', 'smg', 'shotgun']);

/** Vehicle health ceiling. */
export const VEHICLE_MAX_HEALTH = 200;

/** Acceleration applied while a throttle input is held, in pixels per second^2. */
export const VEHICLE_ACCELERATION = 420;

/** Braking deceleration applied when reversing while moving forward (px/s^2). */
export const VEHICLE_BRAKE = 900;

/** Top forward speed, in pixels per second. */
export const VEHICLE_MAX_SPEED = 320;

/** Top reverse speed, in pixels per second. */
export const VEHICLE_REVERSE_SPEED = 140;

/** Coasting deceleration applied with no throttle, in pixels per second^2. */
export const VEHICLE_FRICTION = 180;

/** Deceleration applied while the handbrake is held, in pixels per second^2. */
export const VEHICLE_HANDBRAKE_DECEL = 1200;

/** Turn rate at full speed, in radians per second. */
export const VEHICLE_STEER_RATE = 3;

/** Steering multiplier while the handbrake is held (arcade drift feel). */
export const VEHICLE_HANDBRAKE_STEER_MULTIPLIER = 1.5;

/** Fraction of speed kept after a collision with a building. */
export const VEHICLE_CRASH_SPEED_FACTOR = 0.25;

/** How close (centre to centre plus radii) a player must be to enter, in pixels. */
export const VEHICLE_ENTER_RANGE = 64;

/** Extra gap left between vehicle and player when choosing an exit spot. */
export const VEHICLE_EXIT_CLEARANCE = 4;

/** Minimum speed (px/s) at which a vehicle can run an entity over. */
export const VEHICLE_RUNOVER_MIN_SPEED = 80;

/** Base run-over damage; scaled between 50% and 100% by impact speed. */
export const VEHICLE_RUNOVER_DAMAGE = 40;

/** Radius of a vehicle explosion, in pixels. */
export const VEHICLE_EXPLOSION_RADIUS = 96;

/** Damage dealt to every entity inside the blast radius. */
export const VEHICLE_EXPLOSION_DAMAGE = 80;

/** Wanted heat added to the player when a vehicle they destroy explodes. */
export const VEHICLE_EXPLOSION_HEAT = 25;

/**
 * Heat needed to reach each wanted star. Index 0 is "clean" (zero stars), so
 * `WANTED_THRESHOLDS[n]` is the heat at which the player gains their nth star.
 *
 * @type {ReadonlyArray<number>}
 */
export const WANTED_THRESHOLDS = Object.freeze([0, 10, 40, 90, 160, 260]);

/** Highest reachable wanted level. */
export const WANTED_MAX_STARS = WANTED_THRESHOLDS.length - 1;

/** Heat shed per simulated tick while the player is not committing crimes. */
export const WANTED_HEAT_DECAY_PER_TICK = 0.5;

/** Heat ceiling (== the threshold of the top star). */
export const WANTED_MAX_HEAT = WANTED_THRESHOLDS[WANTED_MAX_STARS];
