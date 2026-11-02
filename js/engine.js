/**
 * POWER SURGE CIRCUIT — deterministic game simulation.
 *
 * The engine has no DOM, canvas, audio or localStorage dependencies. It is
 * driven by update(dt) for real-time runs or step() for exact tests. Rendering
 * only ever reads engine state and drains transient events.
 */
import {
  CONFIG,
  DIFFICULTIES,
  POWERUP_META,
  POWERUP_ORDER,
  clamp,
  getDifficulty,
} from './config.js';
import { RNG, hashSeed } from './rng.js';
import { getSpawnSegments, generateLevel } from './levels.js';

const ORTHO_DIRECTIONS = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

const ENDLESS_THEME_ORDER = ['cpu', 'memory', 'power', 'gpu', 'nexus', 'reactor'];

const FAIL_CAUSE = Object.freeze({
  SELF: 'self',
  HAZARD: 'hazard',
  BARRIER: 'barrier',
});

function keyOf(x, y) {
  return `${x},${y}`;
}

function distanceEuclidean(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Deep copies plain data. structuredClone() is preferred, but some JS hosts
 * instrument Array.prototype and make it return an empty object for array
 * roots, so only trust it when the copy is structurally sound.
 */
function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') {
    try {
      const copy = structuredClone(value);
      const sourceIsArray = Array.isArray(value);
      if (Array.isArray(copy) === sourceIsArray && !(sourceIsArray && copy.length !== value.length)) {
        return copy;
      }
    } catch {
      // fall through to the JSON path
    }
  }
  return JSON.parse(JSON.stringify(value));
}

export class PowerEngine {
  constructor(options = {}) {
    this.mode = options.mode === 'campaign' ? 'campaign' : 'endless';
    this.difficultyKey = getDifficulty(options.difficulty).key;
    this.difficulty = DIFFICULTIES[this.difficultyKey];
    this.userSpeed = clamp(
      Number.isFinite(options.userSpeed) ? options.userSpeed : CONFIG.speed.userDefault,
      CONFIG.speed.userMin,
      CONFIG.speed.userMax,
    );
    this.seed = Number.isFinite(options.seed) ? options.seed >>> 0 : hashSeed(`run:${Date.now()}`);
    this.rng = new RNG(this.seed);
    this.cols = CONFIG.game.cols;
    this.rows = CONFIG.game.rows;

    this.level =
      this.mode === 'campaign'
        ? options.level ||
          generateLevel(
            clamp(Math.floor(options.levelNumber || 1), 1, CONFIG.campaign.totalLevels),
          )
        : null;
    this.levelNumber = this.level ? this.level.level : null;
    this.objective = this.level ? clone(this.level.objective) : { type: 'endless' };
    this.themeKey = this.level ? this.level.theme : NON_LEVEL_THEME;

    this.status = 'ready'; // ready | running | paused | over | complete
    this.steps = 0;
    this.elapsed = 0;
    this.accumulator = 0;
    this.startedAt = null;
    this.completedAt = null;

    this.snake = getSpawnSegments().map((cell) => ({
      x: cell.x,
      y: cell.y,
      prevX: cell.x,
      prevY: cell.y,
    }));
    this.direction = { ...CONFIG.game.startDirection };
    this.queuedDirection = null;
    this.occupancy = new Map();
    this.growthDebt = 0;
    this.graceSteps = 0;
    this.shieldUsedThisStep = false;

    this.score = 0;
    this.collected = 0;
    this.streak = 0;
    this.comboMultiplier = 1;
    this.maxCombo = 0;
    this.lastCollectStep = -Infinity;

    this.energyNodes = [];
    this.energyCounter = 0;
    this.powerUps = [];
    this.powerUpCounter = 0;
    this.effects = { slow: 0, double: 0, magnet: 0, shield: 0 };
    this.stats = {
      nodes: 0,
      powerupsUsed: 0,
      shieldSaves: 0,
      terminals: 0,
      pairs: 0,
    };
    this.usedPowerupTypes = new Set();
    this.maxEnergyOnBoard = CONFIG.spawn.energyCount;

    this.hazards = this.level ? clone(this.level.hazards || []) : [];
    this.barriers = this.level ? clone(this.level.barriers || []) : [];
    this.terminals = this.level
      ? clone(this.level.terminals || []).map((terminal) => ({
          ...terminal,
          active: false,
          pairComplete: false,
        }))
      : [];
    this.exit = this.level?.exit ? { ...this.level.exit, reached: false } : null;
    this.hazardClusters = this.level ? clone(this.level.hazardClusters || []) : [];
    this.barrierGroups = this.level ? clone(this.level.barrierGroups || []) : [];

    this.nextTerminalIndex = 0;
    this.completedPairs = new Set();
    this.speedTier = this.mode === 'campaign' ? this.level?.speedTier || 0 : 0;
    this.lastHazardTier = 0;

    this.events = [];
    this.finalCause = null;
    this.finalCell = null;
    this.exitLockedMessageStep = -10;

    this._rebuildOccupancy();
    this._fillInitialEnergy();

    const spawnConfig =
      this.mode === 'endless' ? CONFIG.powerups.endlessSpawn : CONFIG.powerups.campaignSpawn;
    this.nextPowerUpAt =
      this.steps + this.rng.int(spawnConfig.firstMinSteps, spawnConfig.firstMaxSteps);

    if (this.level) {
      this.maxEnergyOnBoard = this.level.optionalEnergy
        ? CONFIG.spawn.terminalLevelEnergyCount
        : CONFIG.spawn.energyCount;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  start() {
    if (this.status === 'ready' || this.status === 'paused') {
      this.status = 'running';
      if (this.startedAt == null) this.startedAt = Date.now();
    }
    return this.status;
  }

  pause() {
    if (this.status === 'running') this.status = 'paused';
    return this.status;
  }

  resume() {
    return this.start();
  }

  togglePause() {
    if (this.status === 'running') this.pause();
    else if (this.status === 'paused') this.resume();
    return this.status;
  }

  /* ------------------------------------------------------------------ */
  /* Input                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Queues exactly one upcoming turn. Direct reversal of the committed
   * direction is rejected; a newer valid turn replaces the queued turn.
   */
  queueDirection(dx, dy) {
    if (this.status !== 'running') return false;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    if (Math.abs(dx) + Math.abs(dy) !== 1) return false;
    if (dx === -this.direction.x && dy === -this.direction.y) return false;
    if (dx === this.direction.x && dy === this.direction.y) {
      // Pressing the current heading clears a queued turn, which lets a
      // player cancel a mistimed swipe without creating a reversal.
      this.queuedDirection = null;
      return true;
    }
    this.queuedDirection = { x: dx, y: dy };
    return true;
  }

  setUserSpeed(value) {
    this.userSpeed = clamp(
      Number.isFinite(value) ? value : CONFIG.speed.userDefault,
      CONFIG.speed.userMin,
      CONFIG.speed.userMax,
    );
  }

  /* ------------------------------------------------------------------ */
  /* Time and movement                                                  */
  /* ------------------------------------------------------------------ */

  baseTickMs() {
    let ms = this.difficulty.baseTickMs;
    if (this.mode === 'campaign') {
      ms *= Math.pow(CONFIG.speed.campaign.tierFactor, this.level?.speedTier || 0);
    } else {
      ms *= Math.pow(CONFIG.speed.endless.tierFactor, this.speedTier);
    }
    return Math.max(ms, this.difficulty.minTickMs);
  }

  currentTickMs() {
    let ms = this.baseTickMs();
    if (this.effects.slow > 0) ms /= CONFIG.powerups.slowSpeedFactor;
    ms /= this.userSpeed;
    return Math.max(42, ms);
  }

  getSpeedInfo() {
    const tickMs = this.currentTickMs();
    return {
      tickMs,
      cellsPerSecond: 1000 / tickMs,
      tier: this.speedTier,
      slow: this.effects.slow > 0,
      userSpeed: this.userSpeed,
    };
  }

  /**
   * Fraction of the way through the next grid step. The renderer uses this to
   * draw sub-cell motion so movement looks smooth at any tick rate.
   */
  getInterpolationAlpha() {
    if (this.status !== 'running') return 0;
    return clamp((this.accumulator * 1000) / this.currentTickMs(), 0, 1);
  }

  updateTimers(dt) {
    if (this.status !== 'running') return;
    const delta = clamp(Number(dt) || 0, 0, CONFIG.game.maxDeltaSeconds);
    this.elapsed += delta;
    for (const effect of ['slow', 'double', 'magnet']) {
      if (this.effects[effect] <= 0) continue;
      this.effects[effect] = Math.max(0, this.effects[effect] - delta);
      if (this.effects[effect] === 0) {
        this.events.push({ type: 'powerupExpired', powerup: effect });
      }
    }
  }

  /**
   * Advances the simulation by a wall-clock delta.
   *
   * Determinism contract: the time until the next step is stored in
   * this.accumulator, set by this.step() itself. update() only decides how
   * many steps to take, so a given sequence of (queued input, dt) pairs always
   * produces the same step count on every platform.
   */
  update(dt) {
    if (this.status !== 'running') return 0;
    const delta = clamp(Number(dt) || 0, 0, CONFIG.game.maxDeltaSeconds);
    if (delta <= 0) return 0;
    this.updateTimers(delta);
    return this.advance(delta);
  }

  /**
   * Consumes accumulated time and performs whole grid steps. Kept separate
   * from update() so tests and tools can advance the sim without touching the
   * power-up clocks or elapsed time.
   * @returns {number} number of grid steps performed
   */
  advance(deltaSeconds) {
    if (this.status !== 'running') return 0;
    const delta = Number(deltaSeconds);
    if (!Number.isFinite(delta) || delta <= 0) return 0;
    let remaining = delta + (Number.isFinite(this.accumulator) ? this.accumulator : 0);
    let steps = 0;
    while (this.status === 'running' && steps < CONFIG.speed.maxStepsPerFrame) {
      const tickMs = this.currentTickMs();
      if (remaining * 1000 < tickMs) break;
      remaining -= tickMs / 1000;
      this.step();
      steps += 1;
    }
    this.accumulator = Math.max(0, remaining);
    return steps;
  }

  /**
   * Advances exactly one grid step. Public for deterministic tests and tools.
   */
  step() {
    if (this.status !== 'running') return;
    this.steps += 1;
    this.shieldUsedThisStep = false;

    if (this.streak > 0 && this.steps - this.lastCollectStep > CONFIG.scoring.comboWindowSteps) {
      this.streak = 0;
      this.comboMultiplier = 1;
    }

    // Commit the queued turn BEFORE resolving the target cell. Collision
    // checks must always be evaluated against the direction actually being
    // travelled this step, otherwise a player steering into their own trail
    // would get a free pass for one cell.
    if (this.queuedDirection) {
      const nextDirection = this.queuedDirection;
      this.queuedDirection = null;
      const isReversal =
        nextDirection.x === -this.direction.x && nextDirection.y === -this.direction.y;
      if (!isReversal) {
        this.direction = nextDirection;
      }
    }

    const head = this.snake[0];
    const next = this._wrap(head.x + this.direction.x, head.y + this.direction.y);
    const nextKey = keyOf(next.x, next.y);
    const allowTailMove = this.growthDebt <= 0;

    let bodyIndex = this.occupancy.has(nextKey) ? this.occupancy.get(nextKey) : -1;
    if (bodyIndex === this.snake.length - 1 && allowTailMove) bodyIndex = -1;

    const hazardCell = this.hazards.find((hazard) => hazard.x === next.x && hazard.y === next.y);
    const barrierCell = this.barriers.find(
      (barrier) =>
        barrier.x === next.x && barrier.y === next.y && this.isBarrierActiveAt(barrier, this.elapsed),
    );

    let collisionType = null;
    if (bodyIndex >= 0) collisionType = FAIL_CAUSE.SELF;
    else if (hazardCell) collisionType = FAIL_CAUSE.HAZARD;
    else if (barrierCell) collisionType = FAIL_CAUSE.BARRIER;

    let phaseCut = false;
    if (collisionType) {
      if (this.effects.shield > 0) {
        this.effects.shield = 0;
        this.stats.shieldSaves += 1;
        this.shieldUsedThisStep = true;
        this.graceSteps = CONFIG.shield.graceSteps;
        if (bodyIndex >= 0) {
          this._cutTrailAt(bodyIndex);
          phaseCut = true;
        }
        this.events.push({
          type: 'shield',
          collision: collisionType,
          cell: { x: next.x, y: next.y },
        });
      } else if (this.graceSteps > 0) {
        this.graceSteps -= 1;
        if (bodyIndex >= 0) {
          this._cutTrailAt(bodyIndex);
          phaseCut = true;
        }
        this.events.push({
          type: 'phase',
          collision: collisionType,
          cell: { x: next.x, y: next.y },
        });
      } else {
        this._die(next, collisionType);
        return;
      }
    }

    this._moveSnake(next, { phaseCut });
    if (!this.shieldUsedThisStep && this.graceSteps > 0) this.graceSteps -= 1;

    // Energy collection at the new head, then magnet sweep.
    const directNode = this._energyAt(next.x, next.y);
    if (directNode) this._collectNode(directNode, 'direct');
    if (this.effects.magnet > 0) this._collectMagnetNodes();

    this._replenishEnergy();

    const picked = this.powerUps.find((powerup) => powerup.x === next.x && powerup.y === next.y);
    if (picked) this._activatePowerUp(picked);

    this._resolveTerminalAt(next.x, next.y);
    this._resolveExitAt(next.x, next.y);

    if (this.status === 'running') this._evaluateObjective();

    this._expireBoardPowerUps();
    if (this.status === 'running') this._maybeSpawnPowerUp();
    if (this.mode === 'endless' && this.status === 'running') this._maybeAddEndlessHazard();
  }

  _moveSnake(next, { phaseCut = false } = {}) {
    for (const segment of this.snake) {
      segment.prevX = segment.x;
      segment.prevY = segment.y;
    }
    const oldHead = this.snake[0];
    const newHead = {
      x: next.x,
      y: next.y,
      prevX: oldHead.x,
      prevY: oldHead.y,
    };

    if (phaseCut) {
      // Trail was already shortened to remove the overlapping section.
      this.snake.unshift(newHead);
    } else {
      this.snake.unshift(newHead);
      if (this.growthDebt > 0) {
        this.growthDebt -= 1;
      } else {
        this.snake.pop();
      }
    }
    this._rebuildOccupancy();
  }

  _cutTrailAt(index) {
    if (index <= 0) return;
    this.snake = this.snake.slice(0, index);
    this._rebuildOccupancy();
  }

  _die(cell, cause) {
    this.status = 'over';
    this.completedAt = Date.now();
    this.finalCause = cause;
    this.finalCell = { x: cell.x, y: cell.y };
    this.events.push({
      type: 'gameover',
      cause,
      cell: { x: cell.x, y: cell.y },
      score: this.score,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Board lookups                                                      */
  /* ------------------------------------------------------------------ */

  _wrap(x, y) {
    return {
      x: ((x % this.cols) + this.cols) % this.cols,
      y: ((y % this.rows) + this.rows) % this.rows,
    };
  }

  _rebuildOccupancy() {
    this.occupancy = new Map();
    this.snake.forEach((segment, index) => {
      this.occupancy.set(keyOf(segment.x, segment.y), index);
    });
  }

  _energyAt(x, y) {
    return this.energyNodes.find((node) => node.x === x && node.y === y) || null;
  }

  _cellBlockedForPlacement(x, y) {
    if (this.occupancy.has(keyOf(x, y))) return true;
    if (this.hazards.some((hazard) => hazard.x === x && hazard.y === y)) return true;
    if (this.barriers.some((barrier) => barrier.x === x && barrier.y === y)) return true;
    if (this.terminals.some((terminal) => terminal.x === x && terminal.y === y)) return true;
    if (this.exit && this.exit.x === x && this.exit.y === y) return true;
    if (this.energyNodes.some((node) => node.x === x && node.y === y)) return true;
    if (this.powerUps.some((powerup) => powerup.x === x && powerup.y === y)) return true;
    return false;
  }

  /**
   * Flood-fills the board from the surge head, wrapping at the edges.
   *
   * Only permanent structures (hazards and barriers) block the fill. The surge
   * body is deliberately treated as passable: it vacates each cell as it
   * travels, so a body cell is always a valid future destination. Treating the
   * body as a wall would also make the head's own cell unreachable and collapse
   * the whole search to nothing.
   *
   * @returns {Set<string>} reachable "x,y" keys, including the head cell
   */
  _reachableCells() {
    const blocked = new Set();
    for (const hazard of this.hazards) blocked.add(keyOf(hazard.x, hazard.y));
    for (const barrier of this.barriers) blocked.add(keyOf(barrier.x, barrier.y));
    const start = this.snake[0];
    const seen = new Set();
    const startKey = keyOf(start.x, start.y);
    if (blocked.has(startKey)) return seen;
    const queue = [{ x: start.x, y: start.y }];
    seen.add(startKey);
    let cursor = 0;
    while (cursor < queue.length) {
      const current = queue[cursor];
      cursor += 1;
      for (const direction of ORTHO_DIRECTIONS) {
        const next = this._wrap(current.x + direction.x, current.y + direction.y);
        const nextKey = keyOf(next.x, next.y);
        if (seen.has(nextKey) || blocked.has(nextKey)) continue;
        seen.add(nextKey);
        queue.push(next);
      }
    }
    return seen;
  }

  /* ------------------------------------------------------------------ */
  /* Energy nodes                                                       */
  /* ------------------------------------------------------------------ */

  _desiredEnergyCount() {
    if (this.mode === 'endless') return CONFIG.spawn.energyCount;
    if (this.objective.type === 'collect') {
      return this.collected < this.objective.target ? CONFIG.spawn.energyCount : 0;
    }
    if (this.objective.type === 'escape') {
      return this.collected < this.objective.target ? CONFIG.spawn.energyCount : 0;
    }
    return this.level?.optionalEnergy ? CONFIG.spawn.terminalLevelEnergyCount : 0;
  }

  _fillInitialEnergy() {
    this._replenishEnergy();
  }

  _replenishEnergy() {
    if (this.status === 'over' || this.status === 'complete') return;
    let desired = this._desiredEnergyCount();
    let guard = 0;
    while (this.energyNodes.length < desired && guard < 30) {
      guard += 1;
      if (!this._spawnEnergyNode()) break;
    }
  }

  _spawnEnergyNode() {
    const head = this.snake[0];
    const reachable = this._reachableCells();
    const candidates = [];
    for (const cellKey of reachable) {
      const [x, y] = cellKey.split(',').map(Number);
      if (this._cellBlockedForPlacement(x, y)) continue;
      if (Math.abs(x - head.x) + Math.abs(y - head.y) < CONFIG.spawn.energyMinHeadDistance) continue;
      const tooClose = this.energyNodes.some(
        (node) => Math.max(Math.abs(node.x - x), Math.abs(node.y - y)) < CONFIG.spawn.energyMinSpacing,
      );
      if (tooClose) continue;
      candidates.push({ x, y });
    }

    let cell = this.rng.pick(candidates);
    if (!cell) {
      // Fall back to any reachable non-occupied cell, then any open cell.
      for (const cellKey of reachable) {
        const [x, y] = cellKey.split(',').map(Number);
        if (!this._cellBlockedForPlacement(x, y)) {
          cell = { x, y };
          break;
        }
      }
    }
    if (!cell) {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const x = this.rng.int(0, this.cols - 1);
        const y = this.rng.int(0, this.rows - 1);
        if (!this._cellBlockedForPlacement(x, y)) {
          cell = { x, y };
          break;
        }
      }
    }
    if (!cell) return false;

    this.energyCounter += 1;
    const node = {
      id: this.energyCounter,
      x: cell.x,
      y: cell.y,
      spawnedAt: this.steps,
      seed: this.rng.int(0, 0xffffffff),
    };
    this.energyNodes.push(node);
    this.events.push({ type: 'energySpawn', cell: { x: node.x, y: node.y }, id: node.id });
    return true;
  }

  _collectNode(node, source = 'direct') {
    if (!node) return;
    const index = this.energyNodes.findIndex((entry) => entry.id === node.id);
    if (index < 0) return;
    this.energyNodes.splice(index, 1);

    this.collected += 1;
    this.stats.nodes += 1;
    this.growthDebt += CONFIG.game.growthPerNode;
    if (this.steps - this.lastCollectStep <= CONFIG.scoring.comboWindowSteps) {
      this.streak += 1;
    } else {
      this.streak = 1;
    }
    this.lastCollectStep = this.steps;
    this.comboMultiplier = Math.min(
      CONFIG.scoring.comboMaxMultiplier,
      1 +
        Math.floor(
          Math.max(0, this.streak - (CONFIG.scoring.comboBaseStreak - 1)) /
            CONFIG.scoring.comboStep,
        ) * CONFIG.scoring.comboMultiplierStep,
    );
    this.maxCombo = Math.max(this.maxCombo, this.streak);

    const speedBonus = this.speedTier * CONFIG.scoring.speedBonusPerTier;
    const base = CONFIG.scoring.nodeBase + speedBonus;
    const multiplier = this.comboMultiplier;
    const double = this.effects.double > 0 ? 2 : 1;
    const points = Math.round(base * multiplier) * double;
    this.score += points;

    this.events.push({
      type: 'collect',
      cell: { x: node.x, y: node.y },
      points,
      streak: this.streak,
      multiplier,
      double: double > 1,
      source,
      totalCollected: this.collected,
    });
    this._afterCollection();
  }

  _afterCollection() {
    if (this.mode !== 'endless') return;
    const newTier = Math.min(
      CONFIG.speed.endless.maxTier,
      Math.floor(this.collected / CONFIG.speed.endless.tierEveryCollections),
    );
    if (newTier > this.speedTier) {
      this.speedTier = newTier;
      const themeIndex = Math.min(
        ENDLESS_THEME_ORDER.length - 1,
        Math.floor(newTier / 2),
      );
      this.themeKey = ENDLESS_THEME_ORDER[themeIndex];
      this.events.push({
        type: 'speedRamp',
        tier: newTier,
        cellsPerSecond: 1000 / this.currentTickMs(),
      });
    }
  }

  _collectMagnetNodes() {
    if (this.effects.magnet <= 0) return;
    const head = this.snake[0];
    const nearby = this.energyNodes
      .filter((node) => distanceEuclidean(head, node) <= CONFIG.powerups.magnetRadius + 0.001)
      .sort((a, b) => {
        const distanceDiff = distanceEuclidean(head, a) - distanceEuclidean(head, b);
        if (distanceDiff !== 0) return distanceDiff;
        if (a.y !== b.y) return a.y - b.y;
        return a.x - b.x;
      });
    for (const node of nearby) {
      if (!this.energyNodes.some((entry) => entry.id === node.id)) continue;
      this._collectNode(node, 'magnet');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Power-ups                                                          */
  /* ------------------------------------------------------------------ */

  _activatePowerUp(powerup) {
    const index = this.powerUps.findIndex((entry) => entry.id === powerup.id);
    if (index < 0) return;
    this.powerUps.splice(index, 1);
    const type = powerup.type;
    const duration = CONFIG.powerups.durations[type] ?? 0;
    if (type === 'shield') {
      this.effects.shield = 1;
    } else if (type in this.effects) {
      this.effects[type] = duration;
    }
    this.stats.powerupsUsed += 1;
    this.usedPowerupTypes.add(type);
    this.events.push({
      type: 'powerup',
      powerup: type,
      duration,
      cell: { x: powerup.x, y: powerup.y },
      score: this.score,
    });
    if (type === 'magnet') {
      this._collectMagnetNodes();
      this._replenishEnergy();
    }
  }

  _maybeSpawnPowerUp() {
    if (this.steps < this.nextPowerUpAt) return;
    if (this.powerUps.length >= CONFIG.powerups.maxOnBoard) {
      this.nextPowerUpAt = this.steps + 8;
      return;
    }

    const reachable = this._reachableCells();
    const head = this.snake[0];
    const candidates = [];
    for (const cellKey of reachable) {
      const [x, y] = cellKey.split(',').map(Number);
      if (this._cellBlockedForPlacement(x, y)) continue;
      if (Math.abs(x - head.x) + Math.abs(y - head.y) < 4) continue;
      candidates.push({ x, y });
    }
    const cell = this.rng.pick(candidates);
    const spawnConfig =
      this.mode === 'endless' ? CONFIG.powerups.endlessSpawn : CONFIG.powerups.campaignSpawn;

    if (!cell) {
      this.nextPowerUpAt = this.steps + 10;
      return;
    }

    this.powerUpCounter += 1;
    const type = this.rng.pick(POWERUP_ORDER);
    this.powerUps.push({
      id: this.powerUpCounter,
      type,
      x: cell.x,
      y: cell.y,
      expiresAtStep: this.steps + CONFIG.spawn.powerupLifetimeSteps,
      seed: this.rng.int(0, 0xffffffff),
    });
    this.events.push({
      type: 'powerupSpawn',
      powerup: type,
      cell: { x: cell.x, y: cell.y },
      id: this.powerUpCounter,
    });
    this.nextPowerUpAt = this.steps + this.rng.int(spawnConfig.minSteps, spawnConfig.maxSteps);
  }

  _expireBoardPowerUps() {
    for (let i = this.powerUps.length - 1; i >= 0; i -= 1) {
      if (this.powerUps[i].expiresAtStep <= this.steps) {
        const [removed] = this.powerUps.splice(i, 1);
        this.events.push({ type: 'powerupExpire', powerup: removed.type, cell: { x: removed.x, y: removed.y } });
      }
    }
  }

  getActivePowerups() {
    const active = [];
    for (const type of POWERUP_ORDER) {
      const meta = POWERUP_META[type];
      if (type === 'shield') {
        if (this.effects.shield > 0) {
          active.push({
            type,
            label: meta.short,
            name: meta.label,
            glyph: meta.glyph,
            remaining: null,
            duration: null,
            ratio: 1,
            charges: this.effects.shield,
            color: meta.color,
          });
        }
        continue;
      }
      if (this.effects[type] > 0) {
        const duration = CONFIG.powerups.durations[type];
        active.push({
          type,
          label: meta.short,
          name: meta.label,
          glyph: meta.glyph,
          remaining: this.effects[type],
          duration,
          ratio: duration > 0 ? clamp(this.effects[type] / duration, 0, 1) : 0,
          charges: 0,
          color: meta.color,
        });
      }
    }
    return active;
  }

  /* ------------------------------------------------------------------ */
  /* Terminals, exit and objectives                                     */
  /* ------------------------------------------------------------------ */

  _terminalAt(x, y) {
    return this.terminals.find((terminal) => terminal.x === x && terminal.y === y) || null;
  }

  _resolveTerminalAt(x, y) {
    const terminal = this._terminalAt(x, y);
    if (!terminal) return;
    if (terminal.active) return;

    if (this.objective.type === 'terminals') {
      if (terminal.index === this.nextTerminalIndex) {
        terminal.active = true;
        this.nextTerminalIndex += 1;
        this.stats.terminals += 1;
        const points =
          (CONFIG.scoring.terminalBase + this.speedTier * CONFIG.scoring.speedBonusPerTier) *
          (this.effects.double > 0 ? 2 : 1);
        this.score += points;
        this.events.push({
          type: 'terminal',
          cell: { x, y },
          index: terminal.index,
          points,
          remaining: this.terminals.filter((entry) => !entry.active).length,
        });
      } else {
        this.events.push({
          type: 'terminalLocked',
          cell: { x, y },
          expected: this.nextTerminalIndex,
        });
      }
      return;
    }

    if (this.objective.type === 'connect') {
      terminal.active = true;
      this.stats.terminals += 1;
      const partner = this.terminals.find(
        (entry) => entry.pairId === terminal.pairId && entry.index !== terminal.index,
      );
      if (partner?.active) {
        terminal.pairComplete = true;
        if (partner) partner.pairComplete = true;
        this.completedPairs.add(terminal.pairId);
        this.stats.pairs += 1;
        const points =
          (CONFIG.scoring.pairBase + this.speedTier * CONFIG.scoring.speedBonusPerTier) *
          (this.effects.double > 0 ? 2 : 1);
        this.score += points;
        this.events.push({
          type: 'connected',
          cell: { x, y },
          pairId: terminal.pairId,
          points,
          remaining: (this.objective.pairs || 0) - this.completedPairs.size,
          endpoints: [
            { x: terminal.x, y: terminal.y },
            partner ? { x: partner.x, y: partner.y } : null,
          ].filter(Boolean),
        });
      } else {
        this.events.push({
          type: 'terminal',
          cell: { x, y },
          index: terminal.index,
          pairId: terminal.pairId,
          awaitingLink: true,
        });
      }
    }
  }

  _resolveExitAt(x, y) {
    if (!this.exit || this.exit.x !== x || this.exit.y !== y) return;
    if (this.objective.type !== 'escape') return;
    if (this.collected >= (this.objective.target || 0)) {
      this.exit.reached = true;
      this.events.push({ type: 'exit', cell: { x, y } });
      this._completeObjective('escape');
    } else if (this.steps - this.exitLockedMessageStep > 4) {
      this.exitLockedMessageStep = this.steps;
      this.events.push({
        type: 'exitLocked',
        cell: { x, y },
        remaining: this.objective.target - this.collected,
      });
    }
  }

  _evaluateObjective() {
    if (this.mode !== 'campaign') return;
    if (this.objective.type === 'collect' && this.collected >= this.objective.target) {
      this._completeObjective('collect');
    } else if (this.objective.type === 'terminals') {
      if (this.terminals.every((terminal) => terminal.active)) this._completeObjective('terminals');
    } else if (this.objective.type === 'connect') {
      if (this.completedPairs.size >= this.objective.pairs) this._completeObjective('connect');
    }
  }

  _completeObjective(type) {
    if (this.status === 'complete' || this.status === 'over') return;
    this.status = 'complete';
    this.completedAt = Date.now();
    let bonus = CONFIG.scoring.levelClearBase;
    if (type === 'escape') bonus += CONFIG.scoring.escapeBase;
    bonus += this.speedTier * CONFIG.scoring.speedBonusPerTier;
    this.score += bonus;
    this.events.push({
      type: 'complete',
      objective: type,
      bonus,
      score: this.score,
      stars: this.calculateStars(),
      seconds: this.elapsed,
    });
  }

  calculateStars() {
    if (this.mode !== 'campaign' || !this.level || this.status !== 'complete') return 0;
    const par = this.level.parTime;
    let stars = 1;
    if (this.elapsed <= par) stars = 2;
    const pristine = this.stats.shieldSaves === 0 && this.effects.shield === 0;
    if (this.elapsed <= par * CONFIG.campaign.starThreeEfficiency && pristine) {
      stars = 3;
    }
    return stars;
  }

  getObjectiveStatus() {
    if (this.mode === 'endless') {
      return {
        type: 'endless',
        label: 'SURVIVE',
        current: Math.floor(this.elapsed),
        target: null,
        detail: `${Math.floor(this.elapsed)}s`,
        complete: this.status === 'over',
      };
    }
    if (this.objective.type === 'collect') {
      return {
        type: 'collect',
        label: 'ENERGY',
        current: this.collected,
        target: this.objective.target,
        detail: `${this.collected} / ${this.objective.target}`,
        complete: this.collected >= this.objective.target,
      };
    }
    if (this.objective.type === 'terminals') {
      const active = this.terminals.filter((terminal) => terminal.active).length;
      return {
        type: 'terminals',
        label: 'TERMINALS',
        current: active,
        target: this.terminals.length,
        detail: `${active} / ${this.terminals.length}`,
        nextIndex: this.nextTerminalIndex,
        complete: active >= this.terminals.length,
      };
    }
    if (this.objective.type === 'connect') {
      return {
        type: 'connect',
        label: 'LINKS',
        current: this.completedPairs.size,
        target: this.objective.pairs,
        detail: `${this.completedPairs.size} / ${this.objective.pairs}`,
        complete: this.completedPairs.size >= this.objective.pairs,
      };
    }
    if (this.objective.type === 'escape') {
      const ready = this.collected >= this.objective.target;
      return {
        type: 'escape',
        label: ready ? 'REACH EXIT' : 'CHARGE EXIT',
        current: this.collected,
        target: this.objective.target,
        detail: ready ? 'EXIT ONLINE' : `${this.collected} / ${this.objective.target}`,
        exitReady: ready,
        complete: false,
      };
    }
    return { type: 'unknown', label: 'OBJECTIVE', current: 0, target: 0, detail: '', complete: false };
  }

  getObjectiveText() {
    if (this.mode === 'endless') return 'Survive the circuit.';
    switch (this.objective.type) {
      case 'collect':
        return `Collect ${this.objective.target} energy nodes.`;
      case 'terminals':
        return `Activate ${this.terminals.length} terminals in sequence.`;
      case 'connect':
        return `Link ${this.objective.pairs} terminal pairs.`;
      case 'escape':
        return `Collect ${this.objective.target} energy, then reach the exit.`;
      default:
        return 'Stabilise the circuit.';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Barriers, hazards, endless difficulty                              */
  /* ------------------------------------------------------------------ */

  isBarrierActiveAt(barrier, atTime = this.elapsed) {
    const { period, activeRatio } = CONFIG.barriers;
    const shifted = atTime + (barrier.offset || 0);
    const phase = ((shifted % period) + period) % period;
    return phase / period < activeRatio;
  }

  isBarrierWarningAt(barrier, atTime = this.elapsed) {
    const { period, activeRatio, warningFraction } = CONFIG.barriers;
    const shifted = atTime + (barrier.offset || 0);
    const phase = ((shifted % period) + period) % period;
    const normalized = phase / period;
    return normalized < activeRatio && normalized > activeRatio - warningFraction;
  }

  getBarrierState(barrier) {
    return {
      active: this.isBarrierActiveAt(barrier),
      warning: this.isBarrierWarningAt(barrier),
    };
  }

  _maybeAddEndlessHazard() {
    const tier = this.speedTier;
    if (tier === 0) return;
    const threshold = Math.floor(tier / CONFIG.speed.endless.hazardEveryTiers) *
      CONFIG.speed.endless.hazardEveryTiers;
    if (threshold <= this.lastHazardTier) return;
    this.lastHazardTier = threshold;
    if (this.hazards.length >= CONFIG.speed.endless.maxHazards) return;

    const head = this.snake[0];
    const reachable = this._reachableCells();
    const candidates = [];
    for (const cellKey of reachable) {
      const [x, y] = cellKey.split(',').map(Number);
      if (this._cellBlockedForPlacement(x, y)) continue;
      if (Math.abs(x - head.x) + Math.abs(y - head.y) < 5) continue;
      // Never materialise directly in the current heading corridor.
      const ahead = this._wrap(
        head.x + this.direction.x * 3,
        head.y + this.direction.y * 3,
      );
      if (x === ahead.x && y === ahead.y) continue;
      candidates.push({ x, y });
    }
    const cell = this.rng.pick(candidates);
    if (!cell) return;
    const hazard = {
      x: cell.x,
      y: cell.y,
      clusterId: 9000 + this.hazards.length,
      seed: this.rng.int(0, 0xffffffff),
      endless: true,
    };
    this.hazards.push(hazard);
    this.events.push({ type: 'hazardSpawn', cell: { x: cell.x, y: cell.y } });
  }

  /* ------------------------------------------------------------------ */
  /* Results & HUD                                                      */
  /* ------------------------------------------------------------------ */

  getResult() {
    return {
      mode: this.mode,
      difficulty: this.difficultyKey,
      level: this.levelNumber,
      levelName: this.level?.name || null,
      chapterName: this.level?.chapterName || 'ENDLESS CIRCUIT',
      theme: this.themeKey,
      status: this.status,
      cause: this.finalCause,
      score: this.score,
      seconds: this.elapsed,
      nodes: this.collected,
      maxCombo: this.maxCombo,
      powerupsUsed: this.stats.powerupsUsed,
      shieldSaves: this.stats.shieldSaves,
      terminals: this.stats.terminals,
      pairs: this.stats.pairs,
      stars: this.calculateStars(),
      parTime: this.level?.parTime ?? null,
      seed: this.seed,
      usedPowerups: [...this.usedPowerupTypes],
    };
  }

  getHudState() {
    const objective = this.getObjectiveStatus();
    const speed = this.getSpeedInfo();
    return {
      score: this.score,
      objective,
      speed,
      streak: this.streak,
      comboMultiplier: this.comboMultiplier,
      elapsed: this.elapsed,
      mode: this.mode,
      level: this.levelNumber,
      levelName: this.level?.name || null,
      chapterName: this.level?.chapterName || 'ENDLESS CIRCUIT',
      theme: this.themeKey,
      activePowerups: this.getActivePowerups(),
      shield: this.effects.shield,
      graceSteps: this.graceSteps,
      status: this.status,
    };
  }

  drainEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  getStateForTest() {
    return {
      status: this.status,
      snake: this.snake.map((segment) => ({ x: segment.x, y: segment.y })),
      direction: { ...this.direction },
      score: this.score,
      collected: this.collected,
      growthDebt: this.growthDebt,
      effects: { ...this.effects },
      energyNodes: this.energyNodes.map((node) => ({ ...node })),
      steps: this.steps,
      streak: this.streak,
    };
  }
}

const NON_LEVEL_THEME = 'cpu';

export { FAIL_CAUSE, ENDLESS_THEME_ORDER };
