/**
 * Heads-up display for the top-down shooter.
 *
 * The HUD is drawn in **screen space** (after the world camera transform has
 * been popped), so it stays fixed while the world scrolls underneath. Every
 * metric is a placeholder fed by the core game state: health, armour, ammo,
 * weapon, wanted stars and cash. Later tasks (T6+) will fill in the remaining
 * values; until then sensible defaults are shown.
 *
 * The layout maths (`barFillRatio`, `starStates`, `formatCash`,
 * `computeHudLayout`) are pure and unit tested under Node; only the `draw*`
 * functions touch a `CanvasRenderingContext2D`.
 *
 * @module ui/hud
 */

import { WEAPONS } from '../core/constants.js';
import { clamp } from '../core/geometry.js';
import { missionLabel } from '../core/mission.js';

/** How long a player hit flash lingers, in seconds. */
export const HIT_FLASH_SECONDS = 0.35;

/** HUD palette. Kept local so the HUD theme is tweakable in one place. */
export const HUD_COLORS = Object.freeze({
  panel: 'rgba(2, 6, 23, 0.68)',
  border: 'rgba(148, 163, 184, 0.35)',
  track: 'rgba(15, 23, 42, 0.9)',
  health: '#22c55e',
  healthLow: '#ef4444',
  armour: '#38bdf8',
  ammo: '#fbbf24',
  ink: '#e2e8f0',
  muted: '#8b98a9',
  star: '#facc15',
  starEmpty: 'rgba(148, 163, 184, 0.35)',
  sirenRed: '#ef4444',
  sirenBlue: '#38bdf8',
  sirenOff: 'rgba(148, 163, 184, 0.25)',
  cash: '#4ade80',
  danger: '#ef4444',
  mission: '#facc15',
  outcomeWin: '#4ade80',
  outcomeLose: '#ef4444',
  flash: '#ef4444',
  overlay: 'rgba(2, 6, 23, 0.82)',
});

/** Terminal-outcome banner copy, keyed by the core outcome id. */
export const OUTCOME_LABELS = Object.freeze({
  wasted: 'WASTED',
  busted: 'BUSTED',
  missionComplete: 'MISSION PASSED',
  won: 'YOU WIN',
});

/**
 * Human-readable banner text for a terminal outcome (`''` when still live).
 *
 * @param {string|null} [outcome]
 * @returns {string}
 */
export function outcomeLabel(outcome) {
  return OUTCOME_LABELS[outcome] ?? '';
}

/**
 * Colour for a terminal-outcome banner.
 *
 * @param {string|null} [outcome]
 * @returns {string}
 */
export function outcomeColor(outcome) {
  return outcome === 'wasted' || outcome === 'busted' ? HUD_COLORS.outcomeLose : HUD_COLORS.outcomeWin;
}

/** Default HUD metrics shown until the corresponding systems exist. */
export const HUD_DEFAULTS = Object.freeze({
  cash: 0,
  wanted: 0,
  maxStars: 5,
  weapon: 'pistol',
  reserveAmmo: 0,
  font: 12,
});

/**
 * Clamp a `value / max` pair into a drawable `[0, 1]` bar ratio.
 *
 * @param {number} value
 * @param {number} max
 * @returns {number}
 */
export function barFillRatio(value, max) {
  const ceiling = Number.isFinite(max) && max > 0 ? max : 1;
  const current = Number.isFinite(value) ? value : 0;
  return clamp(current / ceiling, 0, 1);
}

/**
 * Colour for a health bar, switching to the danger colour below 25%.
 *
 * @param {number} ratio Bar fill ratio in `[0, 1]`.
 * @returns {string}
 */
export function healthColor(ratio) {
  return ratio < 0.25 ? HUD_COLORS.healthLow : HUD_COLORS.health;
}

/**
 * Per-star states for the wanted meter.
 *
 * @param {number} wanted How many stars are lit.
 * @param {number} [maxStars=HUD_DEFAULTS.maxStars]
 * @returns {boolean[]} `true` for a lit star.
 */
export function starStates(wanted, maxStars = HUD_DEFAULTS.maxStars) {
  const count = Number.isFinite(maxStars) && maxStars > 0 ? Math.floor(maxStars) : 0;
  const lit = Number.isFinite(wanted) ? Math.max(0, Math.min(Math.floor(wanted), count)) : 0;
  const stars = [];
  for (let i = 0; i < count; i += 1) stars.push(i < lit);
  return stars;
}

/**
 * Look up a weapon's display name, falling back to the id.
 *
 * @param {string} id
 * @returns {string}
 */
export function weaponLabel(id) {
  const spec = WEAPONS[id];
  return spec ? spec.name : String(id ?? HUD_DEFAULTS.weapon);
}

/**
 * Format a cash amount as a GTA-style `$1,234` string.
 *
 * @param {number} amount
 * @returns {string}
 */
export function formatCash(amount) {
  const value = Number.isFinite(amount) ? Math.trunc(amount) : 0;
  return `$${value.toLocaleString('en-US')}`;
}

/** Half-period of the HUD siren flash, in simulation ticks. */
export const SIREN_BLINK_TICKS = 20;

/**
 * Alternate the siren flash phase from the simulation tick, so the red/blue
 * lights blink deterministically instead of per-frame.
 *
 * @param {number} tick Simulation tick.
 * @param {number} [periodTicks=SIREN_BLINK_TICKS]
 * @returns {boolean} `true` on the red phase, `false` on the blue phase.
 */
export function sirenBlink(tick, periodTicks = SIREN_BLINK_TICKS) {
  const period = Number.isFinite(periodTicks) && periodTicks > 0 ? Math.floor(periodTicks) : SIREN_BLINK_TICKS;
  const value = Number.isFinite(tick) ? Math.floor(tick) : 0;
  return Math.floor(value / period) % 2 === 0;
}

/**
 * Is the siren currently sounding? Prefers the explicit `sirenActive` flag the
 * core sets, falling back to "any wanted level".
 *
 * @param {object} game Game state (or a partial HUD model).
 * @returns {boolean}
 */
export function sirenActive(game) {
  if (typeof game?.sirenActive === 'boolean') return game.sirenActive;
  return Number.isFinite(game?.wanted) && game.wanted >= 1;
}

/**
 * The vehicle the player is currently driving, or `null`.
 *
 * @param {object} game Game state (or a partial HUD model).
 * @returns {object|null}
 */
export function drivingVehicle(game) {
  const id = game?.player?.vehicleId;
  if (id === null || id === undefined || !Array.isArray(game?.vehicles)) return null;
  return game.vehicles.find((vehicle) => vehicle && vehicle.id === id) ?? null;
}

/**
 * Format a vehicle speed (pixels/second) as an arcade speed reading.
 *
 * @param {number} speed Signed speed, in pixels/second.
 * @param {number} [scale=0.35] Pixels/second to display-unit factor.
 * @returns {string} e.g. `112 km/h`.
 */
export function formatSpeed(speed, scale = 0.35) {
  const value = Number.isFinite(speed) ? Math.abs(speed) : 0;
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 0.35;
  return `${Math.round(value * factor)} km/h`;
}

/**
 * Compute every HUD rectangle for a physical canvas size. Pure: no drawing.
 *
 * Panel widths scale with the canvas so the left and right columns never
 * overlap on narrow viewports, and the right-hand panels are flagged hidden
 * (`wantedVisible`/`cashVisible`) once there is no room for them next to the
 * left column. `drivingVisible` is false on very short canvases where the
 * vehicle speed row would collide with the bottom weapon row.
 *
 * @param {number} width Logical canvas width, in CSS pixels.
 * @param {number} height Logical canvas height, in CSS pixels.
 * @returns {object} Named rectangles `{ x, y, width, height }` plus the
 *   `wantedVisible`/`cashVisible`/`drivingVisible` flags.
 */
export function computeHudLayout(width, height) {
  const w = Number.isFinite(width) && width > 0 ? width : 960;
  const h = Number.isFinite(height) && height > 0 ? height : 540;
  const pad = 12;
  const gap = 10;
  const bottomY = h - pad - 20;

  const healthWidth = clamp(w * 0.35, 72, 180);
  const health = { x: pad, y: pad, width: healthWidth, height: 12 };
  const armour = { x: pad, y: pad + 18, width: healthWidth, height: 10 };
  const ammo = { x: pad, y: pad + 36, width: clamp(healthWidth * 0.66, 56, 120), height: 8 };

  const wantedWidth = clamp(w * 0.22, 60, 130);
  const wanted = { x: w - pad - wantedWidth, y: pad, width: wantedWidth, height: 16 };

  const weaponWidth = clamp(w * 0.32, 90, 220);
  const weapon = { x: pad, y: bottomY, width: weaponWidth, height: 16 };

  const cashWidth = clamp(w * 0.26, 72, 160);
  const cash = { x: w - pad - cashWidth, y: bottomY, width: cashWidth, height: 20 };

  const sirenSize = 14;
  const siren = {
    x: wanted.x - sirenSize - 6,
    y: wanted.y + (wanted.height - sirenSize) / 2,
    width: sirenSize,
    height: sirenSize,
  };
  const wantedVisible = wanted.x >= health.x + health.width + gap;
  const cashVisible = cash.x >= weapon.x + weapon.width + gap;

  return {
    width: w,
    height: h,
    health,
    armour,
    ammo,
    vehicle: { x: pad, y: ammo.y + ammo.height + 10, width: healthWidth, height: 10 },
    speed: { x: pad, y: ammo.y + ammo.height + 26, width: healthWidth, height: 16 },
    weapon,
    wanted,
    siren,
    cash,
    wantedVisible,
    sirenVisible: wantedVisible && siren.x >= health.x + health.width + gap,
    cashVisible,
    drivingVisible: ammo.y + ammo.height + 26 + 16 + gap <= weapon.y,
  };
}

/**
 * Draw a labelled progress bar.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @param {number} ratio Fill ratio in `[0, 1]`.
 * @param {string} color
 * @param {string} [label]
 * @param {number} [font=HUD_DEFAULTS.font]
 */
export function drawBar(ctx, rect, ratio, color, label, font = HUD_DEFAULTS.font) {
  ctx.fillStyle = HUD_COLORS.track;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeStyle = HUD_COLORS.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
  ctx.fillStyle = color;
  ctx.fillRect(rect.x, rect.y, rect.width * clamp(ratio, 0, 1), rect.height);

  if (label) {
    ctx.fillStyle = HUD_COLORS.ink;
    ctx.font = `${font}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, rect.x + rect.width + 8, rect.y + rect.height / 2);
  }
}

function drawStar(ctx, cx, cy, outer, lit) {
  ctx.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const radius = i % 2 === 0 ? outer : outer * 0.45;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = lit ? HUD_COLORS.star : HUD_COLORS.starEmpty;
  ctx.fill();
}

/**
 * Draw the wanted meter (five star placeholders).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @param {number} wanted
 * @param {number} [maxStars=HUD_DEFAULTS.maxStars]
 */
export function drawWanted(ctx, rect, wanted, maxStars = HUD_DEFAULTS.maxStars) {
  const states = starStates(wanted, maxStars);
  const step = rect.width / Math.max(1, states.length);
  const radius = Math.min(rect.height, step) / 2;
  const cy = rect.y + rect.height / 2;
  for (let i = 0; i < states.length; i += 1) {
    drawStar(ctx, rect.x + step * (i + 0.5), cy, radius, states[i]);
  }
}

function drawLamp(ctx, cx, cy, radius, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Draw the police siren indicator: a red and a blue lamp that alternate.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @param {boolean} active Whether the siren is sounding.
 * @param {boolean} [blink=true] Red phase when true, blue phase when false.
 */
export function drawSiren(ctx, rect, active, blink = true) {
  const radius = Math.max(2, Math.min(rect.width, rect.height) / 2 - 1);
  const cy = rect.y + rect.height / 2;
  const redLit = active && blink;
  const blueLit = active && !blink;
  drawLamp(ctx, rect.x + radius + 1, cy, radius, redLit ? HUD_COLORS.sirenRed : HUD_COLORS.sirenOff);
  drawLamp(ctx, rect.x + rect.width - radius - 1, cy, radius, blueLit ? HUD_COLORS.sirenBlue : HUD_COLORS.sirenOff);
}

/**
 * Draw a text label using the HUD font.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {object} [options]
 * @param {string} [options.color=HUD_COLORS.ink]
 * @param {number} [options.font=HUD_DEFAULTS.font]
 * @param {CanvasTextAlign} [options.align='left']
 * @param {CanvasTextBaseline} [options.baseline='middle']
 */
export function drawLabel(ctx, text, x, y, { color = HUD_COLORS.ink, font = HUD_DEFAULTS.font, align = 'left', baseline = 'middle' } = {}) {
  ctx.fillStyle = color;
  ctx.font = `${font}px system-ui, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(text, x, y);
}

/**
 * Draw the full HUD for a game state.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} game Game state (or a partial HUD model during tests).
 * @param {{ width: number, height: number }} [size] Logical canvas size; falls
 *   back to `game.viewport` and then to the defaults.
 * @returns {object} The layout that was drawn.
 */
export function renderHud(ctx, game, size) {
  const width = size?.width ?? game?.viewport?.width;
  const height = size?.height ?? game?.viewport?.height;
  const layout = computeHudLayout(width, height);
  if (!ctx || !game) return layout;

  const player = game.player ?? {};
  const maxHealth = Number.isFinite(player.maxHealth) ? player.maxHealth : 100;
  const maxArmour = Number.isFinite(player.maxArmour) ? player.maxArmour : 100;
  const health = Number.isFinite(player.health) ? player.health : 0;
  const armour = Number.isFinite(player.armour) ? player.armour : 0;

  const healthRatio = barFillRatio(health, maxHealth);
  const armourRatio = barFillRatio(armour, maxArmour);
  const ammo = Number.isFinite(player.ammo) ? player.ammo : 0;
  const weapon = player.weapon ?? game.weapon ?? HUD_DEFAULTS.weapon;
  const spec = WEAPONS[weapon];
  const magazine = Number.isFinite(spec?.magazineSize) ? spec.magazineSize : Math.max(1, ammo);
  const reserve = Number.isFinite(player.reserve)
    ? player.reserve
    : Number.isFinite(game.reserveAmmo)
      ? game.reserveAmmo
      : HUD_DEFAULTS.reserveAmmo;
  const wanted = Number.isFinite(game.wanted) ? game.wanted : HUD_DEFAULTS.wanted;
  const cash = Number.isFinite(game.cash) ? game.cash : HUD_DEFAULTS.cash;
  const vehicle = drivingVehicle(game);

  ctx.save();
  drawBar(ctx, layout.health, healthRatio, healthColor(healthRatio), `HP ${Math.round(health)}`);
  drawBar(ctx, layout.armour, armourRatio, HUD_COLORS.armour, `AP ${Math.round(armour)}`);

  if (vehicle && layout.drivingVisible) {
    const vehicleRatio = barFillRatio(vehicle.health, vehicle.maxHealth);
    drawBar(ctx, layout.vehicle, vehicleRatio, healthColor(vehicleRatio), `CAR ${Math.round(vehicle.health)}`);
    drawLabel(ctx, formatSpeed(vehicle.speed), layout.speed.x, layout.speed.y + layout.speed.height / 2, {
      color: HUD_COLORS.ink,
    });
  } else {
    drawBar(ctx, layout.ammo, barFillRatio(ammo, magazine), HUD_COLORS.ammo, `${ammo}/${magazine}  (${reserve})`);
    drawLabel(ctx, `${weaponLabel(weapon)}`, layout.weapon.x, layout.weapon.y + layout.weapon.height / 2, {
      color: HUD_COLORS.muted,
    });
  }

  if (layout.cashVisible) {
    drawLabel(ctx, formatCash(cash), layout.cash.x + layout.cash.width, layout.cash.y + layout.cash.height / 2, {
      color: HUD_COLORS.cash,
      font: 15,
      align: 'right',
    });
  }

  if (layout.sirenVisible && sirenActive(game)) {
    drawSiren(ctx, layout.siren, true, sirenBlink(game.tick));
  }

  if (layout.wantedVisible) {
    drawWanted(ctx, layout.wanted, wanted);
    drawLabel(ctx, `WANTED ${wanted}`, layout.wanted.x, layout.wanted.y - 2, {
      color: HUD_COLORS.star,
      font: 10,
      align: 'left',
      baseline: 'bottom',
    });
  }

  const objective = missionLabel(game.mission);
  if (objective) {
    drawMissionPrompt(ctx, layout, objective);
  }

  const best = game.best;
  if (best && (best.cash > 0 || best.score > 0)) {
    drawLabel(
      ctx,
      `BEST ${formatCash(best.cash)} · ${Math.round(best.score)}`,
      layout.cash.x + layout.cash.width,
      layout.cash.y - 4,
      { color: HUD_COLORS.muted, font: 11, align: 'right', baseline: 'bottom' },
    );
  }

  ctx.restore();

  return layout;
}

/**
 * Draw the mission objective on a translucent pill so it stays legible over
 * busy tiles. The HUD's only "prompt" surface, so it lives next to the other
 * draw routines rather than in `renderHud` inline.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} layout Result of {@link computeHudLayout}.
 * @param {string} text
 */
export function drawMissionPrompt(ctx, layout, text) {
  if (!ctx || !layout || !text) return;
  ctx.font = '14px system-ui, sans-serif';
  const metrics = typeof ctx.measureText === 'function' ? ctx.measureText(text) : null;
  const width = (metrics?.width ?? text.length * 7) + 24;
  const height = 22;
  const x = layout.width / 2 - width / 2;
  const y = layout.health.y + layout.health.height / 2 - height / 2;

  ctx.fillStyle = HUD_COLORS.panel;
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = HUD_COLORS.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
  drawLabel(ctx, text, layout.width / 2, y + height / 2, {
    color: HUD_COLORS.mission,
    font: 14,
    align: 'center',
  });
}

/**
 * Fade a hit flash out over its lifetime.
 *
 * @param {number} remaining Seconds left on the flash.
 * @param {number} [duration=HIT_FLASH_SECONDS]
 * @returns {number} Opacity in `[0, 1]`.
 */
export function hitFlashAlpha(remaining, duration = HIT_FLASH_SECONDS) {
  const span = Number.isFinite(duration) && duration > 0 ? duration : HIT_FLASH_SECONDS;
  const left = Number.isFinite(remaining) && remaining > 0 ? remaining : 0;
  return clamp(left / span, 0, 1);
}

/**
 * Draw a red damage vignette over the whole canvas. No-op when fully faded.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} layout Result of {@link computeHudLayout}.
 * @param {number} alpha Opacity in `[0, 1]`.
 */
export function drawHitFlash(ctx, layout, alpha) {
  if (!ctx || !layout) return;
  const a = clamp(Number.isFinite(alpha) ? alpha : 0, 0, 1);
  if (a <= 0) return;

  const cx = layout.width / 2;
  const cy = layout.height / 2;
  const inner = Math.min(layout.width, layout.height) * 0.25;
  const outer = Math.max(layout.width, layout.height) * 0.75;
  const gradient =
    typeof ctx.createRadialGradient === 'function'
      ? ctx.createRadialGradient(cx, cy, inner, cx, cy, outer)
      : null;

  if (gradient) {
    gradient.addColorStop(0, 'rgba(239, 68, 68, 0)');
    gradient.addColorStop(1, `rgba(239, 68, 68, ${(0.5 * a).toFixed(3)})`);
    ctx.fillStyle = gradient;
  } else {
    ctx.fillStyle = `rgba(239, 68, 68, ${(0.3 * a).toFixed(3)})`;
  }
  ctx.fillRect(0, 0, layout.width, layout.height);
}

function drawOverlayPanel(ctx, layout) {
  ctx.fillStyle = HUD_COLORS.overlay;
  ctx.fillRect(0, 0, layout.width, layout.height);
}

/**
 * Title screen: game name, start prompt and a short control legend.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} layout Result of {@link computeHudLayout}.
 */
export function drawTitleOverlay(ctx, layout) {
  if (!ctx || !layout) return;
  drawOverlayPanel(ctx, layout);
  const cx = layout.width / 2;
  const top = layout.height / 2 - 56;

  drawLabel(ctx, 'TOP-DOWN SHOOTER', cx, top, { color: HUD_COLORS.ink, font: 34, align: 'center' });
  drawLabel(ctx, 'Press Enter or Space to start', cx, top + 42, {
    color: HUD_COLORS.mission,
    font: 16,
    align: 'center',
  });
  drawLabel(ctx, 'WASD/arrows move · mouse aims · click fires · E vehicle · Space handbrake', cx, top + 74, {
    color: HUD_COLORS.muted,
    font: 12,
    align: 'center',
  });
  drawLabel(ctx, 'P pause · M mute · Enter/Space restart', cx, top + 94, {
    color: HUD_COLORS.muted,
    font: 12,
    align: 'center',
  });
}

/**
 * Pause screen.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} layout Result of {@link computeHudLayout}.
 */
export function drawPauseOverlay(ctx, layout) {
  if (!ctx || !layout) return;
  drawOverlayPanel(ctx, layout);
  const cx = layout.width / 2;
  const cy = layout.height / 2;
  drawLabel(ctx, 'PAUSED', cx, cy - 12, { color: HUD_COLORS.ink, font: 30, align: 'center' });
  drawLabel(ctx, 'Press P to resume', cx, cy + 24, {
    color: HUD_COLORS.muted,
    font: 14,
    align: 'center',
  });
}

/**
 * Game-over screen: the terminal outcome, the run's score and a restart prompt.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} layout Result of {@link computeHudLayout}.
 * @param {object} [model]
 * @param {string|null} [model.outcome]
 * @param {number} [model.score=0]
 * @param {number} [model.cash=0]
 * @param {{ score: number, cash: number }|null} [model.best]
 */
export function drawGameOverOverlay(ctx, layout, { outcome = null, score = 0, cash = 0, best = null } = {}) {
  if (!ctx || !layout) return;
  drawOverlayPanel(ctx, layout);
  const cx = layout.width / 2;
  const cy = layout.height / 2;

  drawLabel(ctx, outcomeLabel(outcome) || 'GAME OVER', cx, cy - 44, {
    color: outcomeColor(outcome),
    font: 38,
    align: 'center',
  });
  drawLabel(ctx, `Score ${Math.round(score)} · ${formatCash(cash)}`, cx, cy + 2, {
    color: HUD_COLORS.ink,
    font: 16,
    align: 'center',
  });
  if (best && (best.cash > 0 || best.score > 0)) {
    drawLabel(ctx, `BEST ${formatCash(best.cash)} · ${Math.round(best.score)}`, cx, cy + 28, {
      color: HUD_COLORS.muted,
      font: 13,
      align: 'center',
    });
  }
  drawLabel(ctx, 'Press Enter or Space to restart', cx, cy + 66, {
    color: HUD_COLORS.mission,
    font: 16,
    align: 'center',
  });
}

/**
 * Small bottom-centre "muted" badge. Nothing is drawn when sound is on.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} layout Result of {@link computeHudLayout}.
 * @param {boolean} muted
 */
export function drawMuteBadge(ctx, layout, muted) {
  if (!ctx || !layout || !muted) return;
  drawLabel(ctx, 'MUTED (M)', layout.width / 2, layout.weapon.y - 10, {
    color: HUD_COLORS.danger,
    font: 11,
    align: 'center',
    baseline: 'bottom',
  });
}

/** Screen phases the overlay layer understands. */
export const OVERLAY_PHASES = Object.freeze({
  TITLE: 'title',
  PLAYING: 'playing',
  PAUSED: 'paused',
  GAMEOVER: 'gameover',
});

/**
 * Draw the overlay layer on top of the HUD: the damage vignette, the mute
 * badge and the title/pause/game-over screens. Kept as one entry point so
 * `src/main.js` does not need to know the individual pieces.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ width: number, height: number }|object} size Logical canvas size, or
 *   a layout returned by {@link computeHudLayout}.
 * @param {object} [model]
 * @param {string} [model.phase=OVERLAY_PHASES.PLAYING]
 * @param {string|null} [model.outcome]
 * @param {number} [model.hitFlash=0] Seconds of hit flash left.
 * @param {boolean} [model.muted=false]
 * @param {number} [model.score=0]
 * @param {number} [model.cash=0]
 * @param {{ score: number, cash: number }|null} [model.best]
 * @returns {object} The layout that was used.
 */
export function renderOverlays(ctx, size, model = {}) {
  const layout = size && size.health ? size : computeHudLayout(size?.width, size?.height);
  if (!ctx) return layout;

  const {
    phase = OVERLAY_PHASES.PLAYING,
    outcome = null,
    hitFlash = 0,
    muted = false,
    score = 0,
    cash = 0,
    best = null,
  } = model;

  ctx.save();
  drawHitFlash(ctx, layout, hitFlashAlpha(hitFlash));
  if (phase === OVERLAY_PHASES.TITLE) drawTitleOverlay(ctx, layout);
  else if (phase === OVERLAY_PHASES.PAUSED) drawPauseOverlay(ctx, layout);
  else if (phase === OVERLAY_PHASES.GAMEOVER) {
    drawGameOverOverlay(ctx, layout, { outcome, score, cash, best });
  }
  drawMuteBadge(ctx, layout, muted);
  ctx.restore();

  return layout;
}
