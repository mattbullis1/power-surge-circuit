/**
 * Canvas renderer for Power Surge Circuit.
 *
 * Design goals:
 *  - Everything procedural: circuit traces, glow, arcs, sparks and explosions
 *    are drawn with primitives. No image assets, no remote requests.
 *  - Cheap on modest hardware: static layers are pre-rendered once into
 *    offscreen canvases, glow is produced by a small number of additive passes,
 *    and particle counts are capped.
 *  - Reads engine state only. Never mutates the simulation.
 */
import { CONFIG, clamp } from './config.js';
import { getTheme } from './themes.js';
import { RNG } from './rng.js';

const MAX_PARTICLES = 320;
const CELL_TARGET_PX = 30;

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

export class Renderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.cell = CELL_TARGET_PX;
    this.originX = 0;
    this.originY = 0;
    this.boardWidth = CONFIG.game.cols * CELL_TARGET_PX;
    this.boardHeight = CONFIG.game.rows * CELL_TARGET_PX;
    this.theme = getTheme('cpu');
    this.background = document.createElement('canvas');
    this.backgroundCtx = this.background.getContext('2d');
    this.boardCache = document.createElement('canvas');
    this.boardCacheCtx = this.boardCache.getContext('2d');
    this.boardCacheKey = '';
    this.particles = [];
    this.sparks = [];
    this.fx = {
      shake: 0,
      flash: 0,
      hue: 0,
      explosion: 0,
      explosionCell: null,
      levelFade: 0,
    };
    this.settings = {
      reducedMotion: false,
      screenShake: 1,
      highContrast: false,
      colorblind: false,
    };
    this.time = 0;
    this.lastTheme = null;
    this.energyAnim = new Map();
    this.terminalAnim = new Map();
    this.arcSeed = 0;
    this.fpsSample = 0;
    this.quality = 1;
    this.rand = new RNG(0xc0ffee);
  }

  setSettings(settings) {
    this.settings = { ...this.settings, ...settings };
  }

  setTheme(themeKey) {
    const theme = getTheme(themeKey);
    if (this.lastTheme === theme.key) return;
    this.lastTheme = theme.key;
    this.theme = theme;
    this.boardCacheKey = '';
  }

  /** Sizes the canvas to its CSS box, accounting for device pixel ratio. */
  resize(cssWidth, cssHeight) {
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    const width = Math.max(120, Math.floor(cssWidth));
    const height = Math.max(120, Math.floor(cssHeight));
    if (this.width === width && this.height === height && this.dpr === dpr) return;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._layout();
  }

  _layout() {
    const padding = 12;
    const availableWidth = Math.max(80, this.width - padding * 2);
    const availableHeight = Math.max(80, this.height - padding * 2);
    const cell = Math.max(
      6,
      Math.min(availableWidth / CONFIG.game.cols, availableHeight / CONFIG.game.rows),
    );
    this.cell = cell;
    this.boardWidth = cell * CONFIG.game.cols;
    this.boardHeight = cell * CONFIG.game.rows;
    this.originX = Math.round((this.width - this.boardWidth) / 2);
    this.originY = Math.round((this.height - this.boardHeight) / 2);
    this._buildBackground();
  }

  /* ------------------------------------------------------------------ */
  /* Static layers                                                      */
  /* ------------------------------------------------------------------ */

  _buildBackground() {
    this.background.width = Math.max(1, this.width);
    this.background.height = Math.max(1, this.height);
    const ctx = this.backgroundCtx;
    const theme = this.theme;
    ctx.clearRect(0, 0, this.width, this.height);

    const gradient = ctx.createLinearGradient(0, 0, this.width, this.height);
    gradient.addColorStop(0, shade(theme.bg, 1.5));
    gradient.addColorStop(0.55, shade(theme.bg, 2.1));
    gradient.addColorStop(1, shade(theme.bg, 1.1));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);

    // Deep vignette glow behind the board.
    const glow = ctx.createRadialGradient(
      this.width / 2,
      this.height / 2,
      Math.min(this.width, this.height) * 0.05,
      this.width / 2,
      this.height / 2,
      Math.max(this.width, this.height) * 0.7,
    );
    glow.addColorStop(0, hexToRgba(theme.primary, this.settings.highContrast ? 0.3 : 0.2));
    glow.addColorStop(0.55, hexToRgba(theme.secondary, 0.1));
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, this.width, this.height);

    // Motherboard traces in the margin, generated deterministically.
    const rng = new RNG(0x51ce7a);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = hexToRgba(theme.primary, this.settings.highContrast ? 0.3 : 0.18);
    for (let i = 0; i < 26; i += 1) {
      const top = rng.chance(0.5);
      let y = top
        ? rng.float(0, Math.max(8, this.originY - 6))
        : rng.float(this.originY + this.boardHeight + 6, this.height);
      if (!Number.isFinite(y) || y <= 0 || y >= this.height) continue;
      ctx.beginPath();
      let x = rng.float(0, this.width);
      ctx.moveTo(x, y);
      const segments = rng.int(2, 5);
      for (let s = 0; s < segments; s += 1) {
        if (rng.chance(0.5)) {
          x += rng.float(-90, 90);
        } else {
          const step = rng.float(-18, 18);
          y += step;
        }
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  /**
   * The board plate, grid and permanent decorations are cached because they
   * only change when the level, theme or size changes.
   */
  _ensureBoardCache(engine) {
    const key = [
      this.lastTheme,
      Math.round(this.cell * 10),
      engine.mode,
      engine.levelNumber ?? 'endless',
      engine.seed,
      engine.hazards.length,
      engine.barriers.length,
      this.settings.highContrast ? 'hc' : 'std',
    ].join('|');
    if (key === this.boardCacheKey) return;
    this.boardCacheKey = key;

    const w = Math.max(1, Math.ceil(this.boardWidth));
    const h = Math.max(1, Math.ceil(this.boardHeight));
    this.boardCache.width = w;
    this.boardCache.height = h;
    const ctx = this.boardCacheCtx;
    const theme = this.theme;
    const cell = this.cell;
    const cols = CONFIG.game.cols;
    const rows = CONFIG.game.rows;
    ctx.clearRect(0, 0, w, h);

    // Substrate plate. The base fill is opaque so the board never reads as a
    // hole punched in the background.
    ctx.fillStyle = theme.panel;
    roundRect(ctx, 0, 0, w, h, Math.max(6, cell * 0.4));
    ctx.fill();
    const plate = ctx.createLinearGradient(0, 0, w, h);
    plate.addColorStop(0, hexToRgba(shade(theme.panel, 1.3), 0.85));
    plate.addColorStop(0.5, hexToRgba(shade(theme.panel, 1.05), 0.5));
    plate.addColorStop(1, hexToRgba(shade(theme.panel, 0.7), 0.9));
    ctx.fillStyle = plate;
    ctx.fill();

    const rng = new RNG(0x8f2a1 + (engine.levelNumber || 0) * 7919 + (engine.seed || 0));

    // Decorative copper traces under the grid.
    ctx.lineCap = 'round';
    const traceAlpha = this.settings.highContrast ? 0.4 : 0.26;
    for (let i = 0; i < 46; i += 1) {
      const startX = rng.int(0, cols - 1);
      const startY = rng.int(0, rows - 1);
      const length = rng.int(3, 11);
      const horizontal = rng.chance(0.5);
      ctx.strokeStyle = hexToRgba(
        rng.chance(0.35) ? theme.secondary : theme.primary,
        traceAlpha * rng.float(0.5, 1),
      );
      ctx.lineWidth = Math.max(1, cell * rng.float(0.05, 0.11));
      ctx.beginPath();
      let x = startX * cell + cell / 2;
      let y = startY * cell + cell / 2;
      ctx.moveTo(x, y);
      let travelled = 0;
      while (travelled < length) {
        const run = Math.min(length - travelled, rng.int(1, 4));
        if (horizontal) x += run * cell;
        else y += run * cell;
        travelled += run;
        ctx.lineTo(x, y);
        if (travelled < length) {
          // 45-degree jog keeps it looking like routed copper.
          x += horizontal ? cell * 0.5 : 0;
          y += horizontal ? 0 : cell * 0.5;
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    // Grid pads at every intersection.
    const padAlpha = this.settings.highContrast ? 0.45 : 0.3;
    ctx.fillStyle = hexToRgba(theme.accent, padAlpha);
    const padRadius = Math.max(0.9, cell * 0.06);
    for (let y = 0; y <= rows; y += 1) {
      for (let x = 0; x <= cols; x += 1) {
        const px = x * cell;
        const py = y * cell;
        ctx.beginPath();
        ctx.arc(px, py, padRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Grid lines.
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = Math.max(1, cell * 0.045);
    ctx.beginPath();
    for (let x = 1; x < cols; x += 1) {
      ctx.moveTo(Math.round(x * cell) + 0.5, 0);
      ctx.lineTo(Math.round(x * cell) + 0.5, h);
    }
    for (let y = 1; y < rows; y += 1) {
      ctx.moveTo(0, Math.round(y * cell) + 0.5);
      ctx.lineTo(w, Math.round(y * cell) + 0.5);
    }
    ctx.stroke();

    // Border rail with wrap arrows on all four edges.
    ctx.strokeStyle = hexToRgba(theme.primary, this.settings.highContrast ? 0.85 : 0.6);
    ctx.lineWidth = Math.max(1.5, cell * 0.09);
    roundRect(ctx, 1, 1, w - 2, h - 2, Math.max(6, cell * 0.4));
    ctx.stroke();

    // Hazard components.
    for (const cluster of engine.hazardClusters || []) {
      drawHazardCluster(ctx, cluster, cell, theme, this.settings, engine.seed);
    }
    for (const hazard of engine.hazards) {
      if (hazard.endless) {
        drawHazardCluster(
          ctx,
          { id: hazard.clusterId, cells: [{ x: hazard.x, y: hazard.y }], seed: hazard.seed },
          cell,
          theme,
          this.settings,
          engine.seed,
        );
      }
    }

    // Terminal pads (base plate only; the state ring is drawn live).
    for (const terminal of engine.terminals || []) {
      const px = terminal.x * cell + cell / 2;
      const py = terminal.y * cell + cell / 2;
      ctx.save();
      ctx.fillStyle = hexToRgba(theme.panel, 0.9);
      roundRect(ctx, px - cell * 0.42, py - cell * 0.42, cell * 0.84, cell * 0.84, cell * 0.16);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(theme.accent, 0.5);
      ctx.lineWidth = Math.max(1, cell * 0.06);
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Effects API                                                        */
  /* ------------------------------------------------------------------ */

  spawnBurst(x, y, options = {}) {
    if (this.settings.reducedMotion && !options.force) return;
    const count = Math.round((options.count ?? 10) * this.quality);
    for (let i = 0; i < count; i += 1) {
      if (this.particles.length >= MAX_PARTICLES) break;
      const angle = this.rand.float(0, Math.PI * 2);
      const speed = this.rand.float(options.minSpeed ?? 20, options.maxSpeed ?? 110);
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: this.rand.float(0.3, options.life ?? 0.7),
        maxLife: options.life ?? 0.7,
        size: this.rand.float(1.2, options.size ?? 3.2),
        color: options.color || this.theme.accent,
        additive: options.additive !== false,
        drag: options.drag ?? 2.4,
      });
    }
  }

  spawnSparks(cellX, cellY, options = {}) {
    if (this.settings.reducedMotion) return;
    const { x, y } = this.cellToPixel(cellX, cellY);
    this.spawnBurst(x, y, {
      count: options.count ?? 14,
      color: options.color || this.theme.warning,
      maxSpeed: options.maxSpeed ?? 190,
      life: options.life ?? 0.45,
      size: 2.2,
    });
  }

  addShake(amount) {
    if (this.settings.reducedMotion) return;
    this.fx.shake = clamp(this.fx.shake + amount * this.settings.screenShake, 0, 26);
  }

  addFlash(amount) {
    if (this.settings.reducedMotion) {
      this.fx.flash = Math.max(this.fx.flash, amount * 0.35);
      return;
    }
    this.fx.flash = Math.max(this.fx.flash, amount);
  }

  triggerExplosion(cellX, cellY) {
    const { x, y } = this.cellToPixel(cellX, cellY);
    this.fx.explosion = 1;
    this.fx.explosionCell = { x, y };
    this.spawnBurst(x, y, {
      count: this.settings.reducedMotion ? 24 : 90,
      color: this.theme.warning,
      maxSpeed: 420,
      life: 1.1,
      size: 3.6,
      drag: 1.3,
      force: true,
    });
    this.spawnBurst(x, y, {
      count: this.settings.reducedMotion ? 16 : 60,
      color: this.theme.primary,
      maxSpeed: 300,
      life: 0.9,
      size: 2.6,
      drag: 1.6,
      force: true,
    });
    this.addShake(20);
    this.addFlash(0.7);
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * @param {import('./engine.js').PowerEngine} engine
   * @param {number} dt seconds since the previous frame
   */
  render(engine, dt) {
    const delta = clamp(Number(dt) || 0, 0, 0.1);
    this.time += delta;
    const ctx = this.ctx;
    const theme = this.theme;

    this._ensureBoardCache(engine);
    this._updateEffects(delta, engine);

    // Every frame starts from a known-good transform and a full reset of
    // compositing state, so no previous pass can leak into this one.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.save();

    let shakeX = 0;
    let shakeY = 0;
    if (this.fx.shake > 0.05) {
      const magnitude = this.fx.shake;
      shakeX = Math.sin(this.time * 71) * magnitude * 0.6 + (this.rand.next() - 0.5) * magnitude;
      shakeY = Math.cos(this.time * 63) * magnitude * 0.6 + (this.rand.next() - 0.5) * magnitude;
    }

    // Background (already rendered offscreen).
    ctx.drawImage(this.background, 0, 0, this.width, this.height);
    this._drawBackgroundPulse(delta);

    ctx.translate(shakeX, shakeY);
    ctx.translate(this.originX, this.originY);

    // Board plate.
    ctx.drawImage(
      this.boardCache,
      0,
      0,
      this.boardCache.width,
      this.boardCache.height,
      0,
      0,
      this.boardWidth,
      this.boardHeight,
    );

    // Barriers sit above the plate but below the surge.
    this._drawBarriers(engine);
    // Exit pad.
    this._drawExit(engine);
    // Terminals.
    this._drawTerminals(engine);
    // Energy and power-ups.
    this._drawEnergy(engine);
    this._drawPowerUps(engine);
    // The surge itself.
    this._drawSurge(engine, theme);
    // Particles on top.
    this._drawParticles(delta);
    // Explosion bloom.
    this._drawExplosion(delta);

    ctx.restore();

    // Full-screen flash.
    if (this.fx.flash > 0.001) {
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = hexToRgba(theme.primary, this.fx.flash * 0.35);
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.restore();
    }

    // Board edge frame drawn last so it always reads clearly.
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.originX + shakeX, this.originY + shakeY);
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = hexToRgba(theme.accent, this.settings.highContrast ? 0.95 : 0.65);
    ctx.lineWidth = Math.max(1.5, this.cell * 0.08);
    roundRect(ctx, 0, 0, this.boardWidth, this.boardHeight, Math.max(6, this.cell * 0.4));
    ctx.stroke();
    ctx.restore();

    // Wrap indicators sit inside the board, on their own transform.
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.originX + shakeX, this.originY + shakeY);
    this._drawWrapHints(engine);
    ctx.restore();
  }

  _drawBackgroundPulse() {
    if (this.fx.flash <= 0.001) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = hexToRgba(this.theme.primary, this.fx.flash * 0.12);
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }

  _drawWrapHints(engine) {
    if (!engine.snake.length) return;
    const head = engine.snake[0];
    const cell = this.cell;
    const theme = this.theme;
    const ctx = this.ctx;
    const nearLeft = head.x <= 1;
    const nearRight = head.x >= CONFIG.game.cols - 2;
    const nearTop = head.y <= 1;
    const nearBottom = head.y >= CONFIG.game.rows - 2;
    if (!nearLeft && !nearRight && !nearTop && !nearBottom) return;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = hexToRgba(theme.accent, 0.16);
    const thickness = Math.max(2, this.cell * 0.3);
    if (nearLeft) ctx.fillRect(0, 0, thickness, this.boardHeight);
    if (nearRight) ctx.fillRect(this.boardWidth - thickness, 0, thickness, this.boardHeight);
    if (nearTop) ctx.fillRect(0, 0, this.boardWidth, thickness);
    if (nearBottom) ctx.fillRect(0, this.boardHeight - thickness, this.boardWidth, thickness);
    ctx.restore();
  }

  _updateEffects(delta, engine) {
    this.fx.shake = Math.max(0, this.fx.shake - delta * 42);
    this.fx.flash = Math.max(0, this.fx.flash - delta * 2.4);
    this.fx.explosion = Math.max(0, this.fx.explosion - delta * 1.1);
    this.arcSeed += delta;

    // Adaptive quality: drop particle multiplication if frames get expensive.
    if (delta > 0.034) {
      this.fpsSample = Math.min(60, this.fpsSample + 1);
      if (this.fpsSample > 24 && this.quality > 0.5) {
        this.quality = Math.max(0.5, this.quality - 0.25);
        this.fpsSample = 0;
      }
    } else if (delta < 0.02) {
      this.fpsSample = Math.max(0, this.fpsSample - 1);
    }
  }

  cellToPixel(cellX, cellY) {
    return {
      x: (cellX + 0.5) * this.cell,
      y: (cellY + 0.5) * this.cell,
    };
  }

  _drawBarriers(engine) {
    const ctx = this.ctx;
    const cell = this.cell;
    const theme = this.theme;
    for (const barrier of engine.barriers) {
      const active = engine.isBarrierActiveAt(barrier, engine.elapsed);
      const warning = engine.isBarrierWarningAt(barrier, engine.elapsed);
      const px = barrier.x * cell;
      const py = barrier.y * cell;
      ctx.save();
      if (warning && !active && !this.settings.reducedMotion) {
        // Pre-warning: a dim outline gives the player time to react.
        const pulse = 0.35 + Math.sin(this.time * 22) * 0.3;
        ctx.strokeStyle = hexToRgba(theme.warning, pulse);
        ctx.lineWidth = Math.max(1, cell * 0.1);
        ctx.setLineDash([cell * 0.25, cell * 0.2]);
        ctx.strokeRect(px + cell * 0.16, py + cell * 0.16, cell * 0.68, cell * 0.68);
        ctx.setLineDash([]);
      }
      if (active) {
        ctx.globalCompositeOperation = 'lighter';
        const flicker = this.settings.reducedMotion ? 0.85 : 0.7 + Math.sin(this.time * 34 + barrier.offset * 6) * 0.18;
        // Containment field.
        const gradient = ctx.createLinearGradient(px, py, px + cell, py + cell);
        gradient.addColorStop(0, hexToRgba(theme.danger, 0.3 * flicker));
        gradient.addColorStop(0.5, hexToRgba(theme.primary, 0.5 * flicker));
        gradient.addColorStop(1, hexToRgba(theme.danger, 0.3 * flicker));
        ctx.fillStyle = gradient;
        roundRect(ctx, px + cell * 0.06, py + cell * 0.06, cell * 0.88, cell * 0.88, cell * 0.14);
        ctx.fill();
        ctx.strokeStyle = hexToRgba(theme.primary, flicker);
        ctx.lineWidth = Math.max(1, cell * 0.09);
        ctx.stroke();
        // Lightning bolt through the field.
        ctx.beginPath();
        const bx = px + cell * 0.5;
        ctx.moveTo(bx - cell * 0.16, py + cell * 0.18);
        ctx.lineTo(bx + cell * 0.04, py + cell * 0.48);
        ctx.lineTo(bx - cell * 0.06, py + cell * 0.5);
        ctx.lineTo(bx + cell * 0.14, py + cell * 0.84);
        ctx.strokeStyle = hexToRgba('#ffffff', 0.85 * flicker);
        ctx.lineWidth = Math.max(1, cell * 0.07);
        ctx.stroke();
      } else {
        ctx.strokeStyle = hexToRgba(theme.secondary, 0.35);
        ctx.lineWidth = Math.max(1, cell * 0.06);
        roundRect(ctx, px + cell * 0.2, py + cell * 0.2, cell * 0.6, cell * 0.6, cell * 0.12);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  _drawEnergy(engine) {
    const ctx = this.ctx;
    const cell = this.cell;
    const theme = this.theme;
    for (const node of engine.energyNodes) {
      const px = node.x * cell + cell / 2;
      const py = node.y * cell + cell / 2;
      const born = clamp((engine.elapsed * 1000) / 300, 0, 1);
      const birth = clamp((engine.steps - node.spawnedAt) / 3, 0, 1);
      const scale = (this.settings.reducedMotion ? 1 : 0.85 + Math.sin(this.time * 6 + node.seed % 100) * 0.15) * birth;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      // Glow halo.
      const halo = ctx.createRadialGradient(px, py, 0, px, py, cell * 0.9);
      halo.addColorStop(0, hexToRgba(theme.accent, 0.55 * scale));
      halo.addColorStop(0.45, hexToRgba(theme.primary, 0.22 * scale));
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(px, py, cell * 0.9, 0, Math.PI * 2);
      ctx.fill();

      // Core diamond.
      const size = cell * 0.28 * scale;
      ctx.translate(px, py);
      ctx.rotate(this.settings.reducedMotion ? 0 : this.time * 1.6 + node.seed % 10);
      ctx.fillStyle = this.settings.highContrast ? '#ffffff' : theme.accent;
      ctx.beginPath();
      ctx.moveTo(0, -size);
      ctx.lineTo(size, 0);
      ctx.lineTo(0, size);
      ctx.lineTo(-size, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = hexToRgba(theme.primary, 0.9);
      ctx.lineWidth = Math.max(1, cell * 0.05);
      ctx.stroke();

      // Inner spark marker (readable without colour).
      ctx.fillStyle = hexToRgba(theme.bg, 0.75);
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.32, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      if (birth < 1 && !this.settings.reducedMotion) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = hexToRgba(theme.accent, (1 - birth) * 0.6);
        ctx.lineWidth = Math.max(1, cell * 0.06);
        ctx.beginPath();
        ctx.arc(px, py, cell * (0.3 + (1 - birth) * 0.5), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  _drawPowerUps(engine) {
    const ctx = this.ctx;
    const cell = this.cell;
    const theme = this.theme;
    for (const powerup of engine.powerUps) {
      const metaColor = POWERUP_COLORS[powerup.type] || theme.accent;
      const px = powerup.x * cell + cell / 2;
      const py = powerup.y * cell + cell / 2;
      const remaining = Math.max(
        0,
        Math.min(1, (powerup.expiresAtStep - engine.steps) / CONFIG.spawn.powerupLifetimeSteps),
      );
      const pulse = this.settings.reducedMotion ? 1 : 0.9 + Math.sin(this.time * 8 + powerup.seed % 50) * 0.1;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const halo = ctx.createRadialGradient(px, py, 0, px, py, cell * 1.05);
      halo.addColorStop(0, hexToRgba(metaColor, 0.5 * pulse));
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(px, py, cell * 1.05, 0, Math.PI * 2);
      ctx.fill();

      // Hexagonal chip body.
      ctx.translate(px, py);
      ctx.rotate(this.settings.reducedMotion ? 0 : this.time * 0.8);
      const radius = cell * 0.34 * pulse;
      ctx.beginPath();
      for (let i = 0; i < 6; i += 1) {
        const angle = (Math.PI / 3) * i - Math.PI / 6;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = hexToRgba(metaColor, 0.5);
      ctx.fill();
      ctx.strokeStyle = this.settings.highContrast ? '#ffffff' : metaColor;
      ctx.lineWidth = Math.max(1.2, cell * 0.07);
      ctx.stroke();
      ctx.rotate(this.settings.reducedMotion ? 0 : -this.time * 0.8);

      // Glyph.
      ctx.fillStyle = this.settings.highContrast ? '#ffffff' : theme.bg;
      ctx.font = `bold ${Math.round(cell * 0.4)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(POWERUP_GLYPHS[powerup.type] || '?', 0, cell * 0.02);
      ctx.restore();

      // Lifetime ring.
      ctx.save();
      ctx.strokeStyle = hexToRgba(metaColor, 0.75);
      ctx.lineWidth = Math.max(1, cell * 0.06);
      ctx.beginPath();
      ctx.arc(px, py, cell * 0.44, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * remaining);
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawTerminals(engine) {
    const ctx = this.ctx;
    const cell = this.cell;
    const theme = this.theme;
    for (const terminal of engine.terminals) {
      const px = terminal.x * cell + cell / 2;
      const py = terminal.y * cell + cell / 2;
      const isNext = engine.objective.type === 'terminals' && terminal.index === engine.nextTerminalIndex;
      const active = terminal.active;
      const pulse = this.settings.reducedMotion ? 1 : 0.85 + Math.sin(this.time * (isNext ? 9 : 4)) * 0.15;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      if (isNext || active) {
        const halo = ctx.createRadialGradient(px, py, 0, px, py, cell * 1.1);
        const color = active ? theme.warning : theme.accent;
        halo.addColorStop(0, hexToRgba(color, (active ? 0.45 : 0.55) * pulse));
        halo.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(px, py, cell * 1.1, 0, Math.PI * 2);
        ctx.fill();
      }

      // Body ring.
      ctx.strokeStyle = active
        ? hexToRgba(theme.warning, 0.95)
        : hexToRgba(isNext ? theme.accent : theme.secondary, isNext ? 0.95 : 0.5);
      ctx.lineWidth = Math.max(1.2, cell * (isNext ? 0.11 : 0.07));
      ctx.beginPath();
      ctx.arc(px, py, cell * 0.32 * pulse, 0, Math.PI * 2);
      ctx.stroke();

      // Middle marker: dot for sequence terminals, ring for link endpoints.
      ctx.fillStyle = active ? hexToRgba(theme.warning, 0.95) : hexToRgba(theme.accent, 0.9);
      if (engine.objective.type === 'connect') {
        ctx.beginPath();
        ctx.arc(px, py, cell * 0.15, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(px, py, cell * 0.07, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(px, py, cell * 0.11, 0, Math.PI * 2);
        ctx.fill();
        // Sequence number, drawn large enough to read on a phone.
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = this.settings.highContrast ? '#ffffff' : theme.accent;
        ctx.font = `bold ${Math.round(cell * 0.42)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String((terminal.index ?? 0) + 1), px, py - cell * 0.48);
      }
      ctx.restore();
    }
  }

  _drawExit(engine) {
    if (!engine.exit) return;
    const ctx = this.ctx;
    const cell = this.cell;
    const theme = this.theme;
    const px = engine.exit.x * cell + cell / 2;
    const py = engine.exit.y * cell + cell / 2;
    const ready = engine.getObjectiveStatus().exitReady;
    const pulse = this.settings.reducedMotion ? 1 : 0.85 + Math.sin(this.time * (ready ? 8 : 3)) * 0.15;
    const color = ready ? theme.warning : theme.danger;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const halo = ctx.createRadialGradient(px, py, 0, px, py, cell * 1.3);
    halo.addColorStop(0, hexToRgba(color, 0.5 * pulse));
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(px, py, cell * 1.3, 0, Math.PI * 2);
    ctx.fill();

    // Square portal frame.
    ctx.strokeStyle = hexToRgba(color, 0.95);
    ctx.lineWidth = Math.max(1.4, cell * 0.1);
    const half = cell * 0.34 * pulse;
    ctx.strokeRect(px - half, py - half, half * 2, half * 2);
    ctx.strokeStyle = hexToRgba(theme.accent, 0.7);
    ctx.lineWidth = Math.max(1, cell * 0.05);
    ctx.strokeRect(px - half * 0.55, py - half * 0.55, half * 1.1, half * 1.1);
    ctx.restore();

    // EXIT label above the pad.
    ctx.save();
    ctx.fillStyle = hexToRgba(ready ? theme.warning : theme.danger, 0.95);
    ctx.font = `bold ${Math.round(cell * 0.34)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(ready ? 'EXIT OPEN' : 'EXIT LOCKED', px, py - cell * 0.45);
    ctx.restore();
  }

  _drawSurge(engine, theme) {
    const ctx = this.ctx;
    const cell = this.cell;
    const alpha = engine.getInterpolationAlpha();
    const snake = engine.snake;
    if (!snake.length) return;

    const colorblind = this.settings.colorblind;
    const highContrast = this.settings.highContrast;
    const bodyColor = highContrast ? '#ffffff' : theme.primary;
    const headColor = highContrast ? '#ffffff' : theme.accent;
    // Colourblind mode adds a shape cue: the head gains a second inner core and
    // the tail is drawn with a chevron instead of a plain taper.
    const shieldActive = engine.effects.shield > 0;
    const graceActive = engine.graceSteps > 0;

    // Interpolated positions give smooth sub-cell motion.
    const points = snake.map((segment, index) => {
      const px = segment.x * cell + cell / 2 + (segment.prevX - segment.x) * cell * (1 - alpha);
      const py = segment.y * cell + cell / 2 + (segment.prevY - segment.y) * cell * (1 - alpha);
      return { x: px, y: py, index, segment };
    });

    // Wrapped segments would draw a long stretched line, so break the trail
    // into contiguous runs and render each separately.
    const runs = [];
    let current = [points[0]];
    for (let i = 1; i < points.length; i += 1) {
      const previous = snake[i - 1];
      const segment = snake[i];
      const distance = Math.abs(previous.x - segment.x) + Math.abs(previous.y - segment.y);
      if (distance <= 1) {
        current.push(points[i]);
      } else {
        runs.push(current);
        current = [points[i]];
      }
    }
    runs.push(current);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Glow pass.
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = hexToRgba(bodyColor, highContrast ? 0.5 : 0.32);
    ctx.lineWidth = cell * 0.95;
    for (const run of runs) this._strokeRun(run);

    // Electrical arcs between segments.
    if (!this.settings.reducedMotion) {
      ctx.strokeStyle = hexToRgba(headColor, 0.65);
      ctx.lineWidth = Math.max(1, cell * 0.07);
      for (const run of runs) {
        ctx.beginPath();
        for (let i = 0; i < run.length - 1; i += 1) {
          const a = run[i];
          const b = run[i + 1];
          const segments = 3;
          for (let s = 1; s <= segments; s += 1) {
            const t = s / segments;
            const jitter = s === segments ? 0 : (this.rand.next() - 0.5) * cell * 0.4;
            const perpendicularX = -(b.y - a.y);
            const perpendicularY = b.x - a.x;
            const length = Math.hypot(perpendicularX, perpendicularY) || 1;
            const nx = perpendicularX / length;
            const ny = perpendicularY / length;
            ctx.moveTo(a.x + (b.x - a.x) * (t - 1 / segments), a.y + (b.y - a.y) * (t - 1 / segments));
            ctx.lineTo(a.x + (b.x - a.x) * t + nx * jitter, a.y + (b.y - a.y) * t + ny * jitter);
          }
        }
        ctx.stroke();
      }
    }

    // Solid core.
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = hexToRgba(bodyColor, highContrast ? 1 : 0.92);
    ctx.lineWidth = cell * (colorblind ? 0.5 : 0.56);
    for (const run of runs) this._strokeRun(run);

    // Inner highlight.
    ctx.strokeStyle = hexToRgba(headColor, 0.75);
    ctx.lineWidth = cell * 0.2;
    for (const run of runs) this._strokeRun(run);

    // Head.
    const head = points[0];
    const headRadius = cell * (highContrast ? 0.42 : 0.4);
    ctx.globalCompositeOperation = 'lighter';
    const headGlow = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, cell * 1.25);
    headGlow.addColorStop(0, hexToRgba(headColor, 0.55));
    headGlow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = headGlow;
    ctx.beginPath();
    ctx.arc(head.x, head.y, cell * 1.25, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = highContrast ? '#ffffff' : theme.accent;
    ctx.beginPath();
    ctx.arc(head.x, head.y, headRadius, 0, Math.PI * 2);
    ctx.fill();
    if (colorblind) {
      // Distinct inner core shape marks the head without relying on colour.
      ctx.fillStyle = hexToRgba(theme.bg, 0.85);
      ctx.beginPath();
      ctx.arc(head.x, head.y, headRadius * 0.45, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = highContrast ? '#ffffff' : theme.accent;
      ctx.beginPath();
      ctx.moveTo(head.x, head.y - headRadius * 0.26);
      ctx.lineTo(head.x + headRadius * 0.26, head.y);
      ctx.lineTo(head.x, head.y + headRadius * 0.26);
      ctx.lineTo(head.x - headRadius * 0.26, head.y);
      ctx.closePath();
      ctx.fill();
    }

    // Direction pointer so the heading is legible at a glance.
    const direction = engine.direction;
    ctx.strokeStyle = hexToRgba(theme.bg, 0.9);
    ctx.lineWidth = Math.max(1.4, cell * 0.09);
    ctx.beginPath();
    ctx.moveTo(head.x, head.y);
    ctx.lineTo(head.x + direction.x * cell * 0.3, head.y + direction.y * cell * 0.3);
    ctx.stroke();

    // Shield bubble.
    if (shieldActive) {
      const bubbleRadius = cell * (0.75 + (this.settings.reducedMotion ? 0 : Math.sin(this.time * 7) * 0.06));
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = hexToRgba('#7dffb2', 0.9);
      ctx.lineWidth = Math.max(1.5, cell * 0.1);
      ctx.beginPath();
      ctx.arc(head.x, head.y, bubbleRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = hexToRgba('#7dffb2', 0.35);
      ctx.lineWidth = Math.max(1, cell * 0.24);
      ctx.stroke();
      // Hex facets read as a force field.
      ctx.strokeStyle = hexToRgba('#7dffb2', 0.5);
      ctx.lineWidth = 1;
      for (let i = 0; i < 6; i += 1) {
        const angle = (Math.PI / 3) * i + this.time * 0.6;
        ctx.beginPath();
        ctx.moveTo(head.x + Math.cos(angle) * bubbleRadius * 0.4, head.y + Math.sin(angle) * bubbleRadius * 0.4);
        ctx.lineTo(head.x + Math.cos(angle) * bubbleRadius, head.y + Math.sin(angle) * bubbleRadius);
        ctx.stroke();
      }
    }

    // Post-shield grace flicker.
    if (graceActive && !shieldActive) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = hexToRgba('#7dffb2', 0.5 + Math.sin(this.time * 30) * 0.3);
      ctx.lineWidth = Math.max(1, cell * 0.08);
      ctx.beginPath();
      ctx.arc(head.x, head.y, cell * 0.62, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Tail chevron improves readability in colourblind mode.
    if (colorblind && points.length > 2) {
      const tail = points[points.length - 1];
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = hexToRgba(bodyColor, 0.9);
      ctx.lineWidth = Math.max(1.2, cell * 0.08);
      ctx.beginPath();
      ctx.moveTo(tail.x - cell * 0.16, tail.y - cell * 0.16);
      ctx.lineTo(tail.x + cell * 0.16, tail.y + cell * 0.16);
      ctx.moveTo(tail.x + cell * 0.16, tail.y - cell * 0.16);
      ctx.lineTo(tail.x - cell * 0.16, tail.y + cell * 0.16);
      ctx.stroke();
    }

    ctx.restore();
  }

  _strokeRun(run) {
    const ctx = this.ctx;
    if (run.length === 1) {
      ctx.beginPath();
      ctx.arc(run[0].x, run[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(run[0].x, run[0].y);
    const smoothing = !this.settings.reducedMotion && run.length > 2;
    if (smoothing) {
      for (let i = 1; i < run.length; i += 1) {
        const previous = run[i - 1];
        const point = run[i];
        ctx.quadraticCurveTo(previous.x, previous.y, (previous.x + point.x) / 2, (previous.y + point.y) / 2);
      }
      const last = run[run.length - 1];
      ctx.lineTo(last.x, last.y);
    } else {
      for (let i = 1; i < run.length; i += 1) ctx.lineTo(run[i].x, run[i].y);
    }
    ctx.stroke();
  }

  _drawParticles(delta) {
    if (this.particles.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const particle = this.particles[i];
      particle.life -= delta;
      if (particle.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      const drag = Math.exp(-particle.drag * delta);
      particle.vx *= drag;
      particle.vy *= drag;
      particle.x += particle.vx * delta;
      particle.y += particle.vy * delta;
      const alpha = clamp(particle.life / particle.maxLife, 0, 1);
      ctx.fillStyle = hexToRgba(particle.color, alpha * 0.9);
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.size * (0.4 + alpha * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  _drawExplosion(delta) {
    if (this.fx.explosion <= 0.001 || !this.fx.explosionCell) return;
    const ctx = this.ctx;
    const { x, y } = this.fx.explosionCell;
    const progress = 1 - this.fx.explosion;
    const radius = this.cell * (1 + progress * 9);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, hexToRgba('#ffffff', this.fx.explosion * 0.6));
    gradient.addColorStop(0.35, hexToRgba(this.theme.warning, this.fx.explosion * 0.4));
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = hexToRgba(this.theme.danger, this.fx.explosion * 0.7);
    ctx.lineWidth = Math.max(1, this.cell * 0.08);
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.85, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  clearEffects() {
    this.particles.length = 0;
    this.fx.shake = 0;
    this.fx.flash = 0;
    this.fx.explosion = 0;
    this.fx.explosionCell = null;
  }
}

/* -------------------------------------------------------------------- */
/* Helpers                                                              */
/* -------------------------------------------------------------------- */

function drawHazardCluster(ctx, cluster, cell, theme, settings, seed) {
  const rng = new RNG((cluster.seed || 1) ^ (seed || 0));
  for (const cellPos of cluster.cells) {
    const px = cellPos.x * cell;
    const py = cellPos.y * cell;
    ctx.save();
    // Damaged component body.
    ctx.fillStyle = hexToRgba(shade(theme.danger, 0.55), 0.92);
    roundRect(ctx, px + cell * 0.08, py + cell * 0.08, cell * 0.84, cell * 0.84, cell * 0.16);
    ctx.fill();
    ctx.strokeStyle = hexToRgba(theme.danger, settings.highContrast ? 1 : 0.8);
    ctx.lineWidth = Math.max(1, cell * 0.07);
    ctx.stroke();

    // Scorch mark.
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.arc(
      px + cell * rng.float(0.35, 0.65),
      py + cell * rng.float(0.35, 0.65),
      cell * rng.float(0.1, 0.2),
      0,
      Math.PI * 2,
    );
    ctx.fill();

    // Cracked traces.
    ctx.strokeStyle = hexToRgba(theme.warning, 0.6);
    ctx.lineWidth = Math.max(1, cell * 0.05);
    ctx.beginPath();
    let x = px + cell * 0.2;
    let y = py + cell * 0.5;
    ctx.moveTo(x, y);
    for (let i = 0; i < 3; i += 1) {
      x += cell * 0.2;
      y += cell * rng.float(-0.2, 0.2);
      ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Warning chevron so hazards read without colour.
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = Math.max(1, cell * 0.06);
    ctx.beginPath();
    ctx.moveTo(px + cell * 0.32, py + cell * 0.62);
    ctx.lineTo(px + cell * 0.5, py + cell * 0.36);
    ctx.lineTo(px + cell * 0.68, py + cell * 0.62);
    ctx.stroke();
    ctx.restore();
  }
}

function shade(hex, factor) {
  const parsed = hexToRgb(hex);
  if (!parsed) return hex;
  const { r, g, b } = parsed;
  const clampChannel = (value) => clamp(Math.round(value * factor), 0, 255);
  return `rgb(${clampChannel(r)}, ${clampChannel(g)}, ${clampChannel(b)})`;
}

function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const value = hex.trim();
  if (value.startsWith('rgb')) {
    const match = value.match(/(\d+)[^\d]+(\d+)[^\d]+(\d+)/);
    if (!match) return null;
    return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
  }
  const normalized = value.replace('#', '');
  if (normalized.length !== 3 && normalized.length !== 6) return null;
  const full = normalized.length === 3
    ? normalized.split('').map((c) => c + c).join('')
    : normalized;
  const int = parseInt(full, 16);
  if (Number.isNaN(int)) return null;
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

export function hexToRgba(hex, alpha) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamp(alpha, 0, 1)})`;
}

const POWERUP_COLORS = {
  slow: '#6ee7ff',
  double: '#ffd166',
  magnet: '#b388ff',
  shield: '#7dffb2',
};

const POWERUP_GLYPHS = {
  slow: '◷',
  double: '×2',
  magnet: '⌁',
  shield: '⬡',
};

export { shade, drawHazardCluster, POWERUP_COLORS, POWERUP_GLYPHS };
