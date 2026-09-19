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
  cash: '#4ade80',
  danger: '#ef4444',
});

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

/**
 * Compute every HUD rectangle for a physical canvas size. Pure: no drawing.
 *
 * @param {number} width Logical canvas width, in CSS pixels.
 * @param {number} height Logical canvas height, in CSS pixels.
 * @returns {object} Named rectangles `{ x, y, width, height }`.
 */
export function computeHudLayout(width, height) {
  const w = Number.isFinite(width) && width > 0 ? width : 960;
  const h = Number.isFinite(height) && height > 0 ? height : 540;
  const pad = 12;

  return {
    width: w,
    height: h,
    health: { x: pad, y: pad, width: 180, height: 12 },
    armour: { x: pad, y: pad + 18, width: 180, height: 10 },
    ammo: { x: pad, y: pad + 36, width: 120, height: 8 },
    weapon: { x: pad, y: h - pad - 14, width: 220, height: 16 },
    wanted: { x: w - pad - 130, y: pad, width: 130, height: 16 },
    cash: { x: w - pad - 160, y: h - pad - 18, width: 160, height: 20 },
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
 * Draw the wanted meter (five star outline placeholders).
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

  ctx.save();
  drawBar(ctx, layout.health, healthRatio, healthColor(healthRatio), `HP ${Math.round(health)}`);
  drawBar(ctx, layout.armour, armourRatio, HUD_COLORS.armour, `AP ${Math.round(armour)}`);
  drawBar(ctx, layout.ammo, barFillRatio(ammo, magazine), HUD_COLORS.ammo, `${ammo}/${magazine}  (${reserve})`);

  drawLabel(ctx, `${weaponLabel(weapon)}`, layout.weapon.x, layout.weapon.y + layout.weapon.height / 2, {
    color: HUD_COLORS.muted,
  });

  drawLabel(ctx, formatCash(cash), layout.cash.x + layout.cash.width, layout.cash.y + layout.cash.height / 2, {
    color: HUD_COLORS.cash,
    font: 15,
    align: 'right',
  });

  drawWanted(ctx, layout.wanted, wanted);
  ctx.restore();

  return layout;
}
