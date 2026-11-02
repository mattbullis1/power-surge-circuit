import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PowerEngine } from '../js/engine.js';
import { CONFIG } from '../js/config.js';
import { generateLevel } from '../js/levels.js';

function setSnake(engine, segments, direction = { x: 1, y: 0 }) {
  engine.snake = segments.map(([x, y]) => ({ x, y, prevX: x, prevY: y }));
  engine.direction = { ...direction };
  engine.queuedDirection = null;
  engine.growthDebt = 0;
  engine._rebuildOccupancy();
}

function linearSnake(headX = 5, headY = 5, length = 5) {
  const cells = [];
  for (let i = 0; i < length; i += 1) cells.push([headX - i, headY]);
  return cells;
}

/**
 * Normalises a 2D cell list. Some environments (notably the VS Code/Jupyter
 * JS scratch evaluator) instrument Array.prototype and make
 * structuredClone() return an empty object for array roots, so tests build
 * engine levels from explicit maps instead.
 */
function cloneCells(list) {
  return Array.isArray(list) ? list.map((cell) => ({ ...cell })) : [];
}

function testLevel(overrides = {}) {
  return {
    layoutVersion: 1,
    level: 99,
    name: 'Test Circuit',
    chapterId: 'cpu',
    chapterName: 'CPU CORE',
    chapterNumber: 1,
    theme: 'cpu',
    objective: { type: 'collect', target: 99 },
    speedTier: 0,
    parTime: 40,
    seed: 1,
    hazards: [],
    hazardClusters: [],
    barriers: [],
    barrierGroups: [],
    terminals: [],
    exit: null,
    optionalEnergy: false,
    ...overrides,
  };
}

/**
 * Builds a campaign engine from raw level data. Arrays are copied explicitly:
 * some JS hosts instrument Array.prototype, which makes structuredClone()
 * return an empty object for array roots.
 */
function buildCampaignEngine({ level, difficulty = 'normal', seed = 1234 }) {
  const built = testLevel();
  built.level = level.level ?? built.level;
  built.name = level.name ?? built.name;
  built.theme = level.theme ?? built.theme;
  built.chapterName = level.chapterName ?? built.chapterName;
  built.parTime = level.parTime ?? built.parTime;
  built.speedTier = level.speedTier ?? built.speedTier;
  built.objective = { ...(level.objective ?? built.objective) };
  built.optionalEnergy = level.optionalEnergy ?? built.optionalEnergy;
  built.hazards = cloneCells(level.hazards);
  built.hazardClusters = cloneCells(level.hazardClusters);
  built.barriers = cloneCells(level.barriers);
  built.barrierGroups = (level.barrierGroups || []).map((group) => ({
    id: group.id,
    cells: cloneCells(group.cells),
    offset: group.offset,
  }));
  built.terminals = cloneCells(level.terminals);
  built.exit = level.exit ? { ...level.exit } : null;

  const engine = new PowerEngine({ mode: 'campaign', difficulty, level: built, seed });
  engine.start();
  engine.energyNodes = [];
  engine.powerUps = [];
  engine._replenishEnergy = () => {};
  engine._maybeSpawnPowerUp = () => {};
  engine._maybeAddEndlessHazard = () => {};
  engine.nextPowerUpAt = 999999;
  return engine;
}

function isolatedEngine({ level = testLevel(), difficulty = 'normal', seed = 1234 } = {}) {
  const engine = buildCampaignEngine({ level, difficulty, seed });
  engine.hazards = cloneCells(level.hazards);
  engine.barriers = cloneCells(level.barriers);
  return engine;
}

function addEnergy(engine, x, y) {
  const node = { id: ++engine.energyCounter, x, y, spawnedAt: engine.steps, seed: 1 };
  engine.energyNodes.push(node);
  return node;
}

function uniqueSnakeCells(engine) {
  return new Set(engine.snake.map((segment) => `${segment.x},${segment.y}`)).size;
}

test('grid movement advances exactly one cell and stores render interpolation data', () => {
  const engine = isolatedEngine();
  setSnake(engine, linearSnake(5, 5, 4));
  const oldHead = { x: engine.snake[0].x, y: engine.snake[0].y };
  engine.step();
  assert.equal(engine.snake[0].x, oldHead.x + 1);
  assert.equal(engine.snake[0].y, oldHead.y);
  assert.equal(engine.snake[0].prevX, oldHead.x);
  assert.equal(engine.snake.length, 4);
  assert.equal(engine.steps, 1);
});

test('one queued turn is applied on the next tick', () => {
  const engine = isolatedEngine();
  setSnake(engine, linearSnake(5, 5, 5));
  assert.equal(engine.queueDirection(0, -1), true);
  engine.step();
  assert.deepEqual(engine.direction, { x: 0, y: -1 });
  assert.equal(engine.snake[0].y, 4);
  assert.equal(engine.queuedDirection, null);
});

test('a queued turn can be replaced before the tick, but only with a legal turn', () => {
  const engine = isolatedEngine();
  setSnake(engine, linearSnake(5, 5, 5));
  engine.queueDirection(0, -1);
  assert.equal(engine.queueDirection(0, 1), true, 'down is legal relative to travelling right');
  engine.step();
  assert.deepEqual(engine.direction, { x: 0, y: 1 });
});

test('reverse direction is rejected', () => {
  const engine = isolatedEngine();
  setSnake(engine, linearSnake(5, 5, 5));
  assert.equal(engine.queueDirection(-1, 0), false);
  assert.equal(engine.queuedDirection, null);
  engine.step();
  assert.equal(engine.snake[0].x, 6);
});

test('reverse is also rejected after a turn is committed', () => {
  const engine = isolatedEngine();
  setSnake(engine, linearSnake(5, 5, 5));
  engine.queueDirection(0, 1);
  engine.step();
  assert.equal(engine.queueDirection(0, -1), false);
  assert.equal(engine.direction.y, 1);
});

test('board edges wrap to the opposite side', () => {
  const engine = isolatedEngine();
  setSnake(
    engine,
    [
      [CONFIG.game.cols - 1, 5],
      [CONFIG.game.cols - 2, 5],
      [CONFIG.game.cols - 3, 5],
      [CONFIG.game.cols - 4, 5],
    ],
    { x: 1, y: 0 },
  );
  engine.step();
  assert.equal(engine.snake[0].x, 0);
  assert.equal(engine.snake[0].y, 5);
  engine.step();
  assert.equal(engine.snake[0].x, 1);
});

test('vertical wrap works as well', () => {
  const engine = isolatedEngine();
  setSnake(engine, [[5, 0], [5, 1], [5, 2], [5, 3]], { x: 0, y: -1 });
  engine.step();
  assert.equal(engine.snake[0].y, CONFIG.game.rows - 1);
});

test('collecting an energy node permanently grows the trail', () => {
  const engine = isolatedEngine();
  setSnake(engine, linearSnake(5, 5, 4));
  addEnergy(engine, 6, 5);
  engine.step();
  assert.equal(engine.collected, 1);
  assert.equal(engine.growthDebt, 1);
  assert.equal(engine.snake.length, 4, 'growth is banked for the following tick');
  engine.step();
  assert.equal(engine.snake.length, 5, 'banked growth is applied');
  assert.equal(engine.growthDebt, 0);
});

test('moving into the vacated tail cell is allowed when not growing', () => {
  const engine = isolatedEngine();
  // Head at 3,3 moving down; tail at 3,4 is directly ahead and will move away.
  setSnake(
    engine,
    [
      [3, 3],
      [2, 3],
      [2, 4],
      [3, 4],
    ],
    { x: 0, y: 1 },
  );
  engine.step();
  assert.equal(engine.status, 'running');
  assert.equal(engine.finalCause, null);
  assert.equal(engine.snake[0].x, 3);
  assert.equal(engine.snake[0].y, 4);
});

test('moving into the tail cell is fatal while the tail is growing', () => {
  const engine = isolatedEngine();
  setSnake(
    engine,
    [
      [3, 3],
      [2, 3],
      [2, 4],
      [3, 4],
    ],
    { x: 0, y: 1 },
  );
  engine.growthDebt = 1;
  engine.step();
  assert.equal(engine.status, 'over');
  assert.equal(engine.finalCause, 'self');
});

test('self-collision without a shield ends the run', () => {
  const engine = isolatedEngine();
  setSnake(
    engine,
    [
      [4, 5],
      [3, 5],
      [3, 4],
      [4, 4],
      [5, 4],
      [5, 5],
      [6, 5],
    ],
    { x: 1, y: 0 },
  );
  engine.step();
  assert.equal(engine.status, 'over');
  assert.equal(engine.finalCause, 'self');
  assert.equal(engine.snake[0].x, 4, 'the fatal move is not applied');
});

test('shield absorbs a self-collision, cuts the overlapping trail and preserves score', () => {
  const engine = isolatedEngine();
  setSnake(
    engine,
    [
      [4, 5],
      [3, 5],
      [3, 4],
      [4, 4],
      [5, 4],
      [5, 5],
      [6, 5],
    ],
    { x: 1, y: 0 },
  );
  engine.effects.shield = 1;
  engine.score = 4321;
  engine.step();
  assert.equal(engine.status, 'running');
  assert.equal(engine.effects.shield, 0);
  assert.equal(engine.stats.shieldSaves, 1);
  assert.equal(engine.score, 4321);
  assert.ok(engine.graceSteps > 0);
  assert.equal(uniqueSnakeCells(engine), engine.snake.length, 'no overlapping body segments');
  assert.equal(engine.snake[0].x, 5);
  assert.equal(engine.snake[0].y, 5);

  engine.step();
  assert.equal(engine.status, 'running', 'no immediate repeated fatal collision');
  const events = engine.drainEvents();
  assert.ok(events.some((event) => event.type === 'shield'));
});

test('shield absorbs a hazard collision and lets the surge burn through', () => {
  const engine = isolatedEngine();
  setSnake(engine, linearSnake(5, 5, 5));
  engine.hazards = [{ x: 6, y: 5, clusterId: 0 }];
  engine.effects.shield = 1;
  engine.step();
  assert.equal(engine.status, 'running');
  assert.equal(engine.snake[0].x, 6);
  assert.equal(engine.snake[0].y, 5);
  engine.step();
  assert.equal(engine.status, 'running');
  assert.equal(engine.snake[0].x, 7);
});

test('active barriers are fatal without a shield and passable while inactive', () => {
  const active = isolatedEngine();
  setSnake(active, linearSnake(5, 5, 5));
  active.barriers = [{ x: 6, y: 5, groupId: 0, offset: 0 }];
  active.elapsed = 0;
  active.step();
  assert.equal(active.status, 'over');
  assert.equal(active.finalCause, 'barrier');

  const inactive = isolatedEngine();
  setSnake(inactive, linearSnake(5, 5, 5));
  inactive.barriers = [{ x: 6, y: 5, groupId: 0, offset: 0 }];
  inactive.elapsed = CONFIG.barriers.period * 0.75;
  inactive.step();
  assert.equal(inactive.status, 'running');
  assert.equal(inactive.snake[0].x, 6);
});

test('magnet collects energy within two cells and grows the trail normally', () => {
  const engine = isolatedEngine();
  setSnake(engine, linearSnake(5, 5, 4));
  engine.effects.magnet = 5;
  addEnergy(engine, 6, 6); // distance 1 from the next head cell
  addEnergy(engine, 10, 10); // out of range
  engine.step();
  assert.equal(engine.collected, 1);
  assert.equal(engine.energyNodes.length, 1);
  assert.equal(engine.energyNodes[0].x, 10);
  assert.equal(engine.growthDebt, 1);
  assert.ok(engine.score >= 100);
  const events = engine.drainEvents();
  const magnetCollect = events.find((event) => event.type === 'collect');
  assert.equal(magnetCollect.source, 'magnet');
});

test('magnet radius is Euclidean (diagonal nodes at 1.4 cells are collected, cells beyond 2 are not)', () => {
  const engine = isolatedEngine();
  setSnake(engine, linearSnake(5, 5, 4));
  engine.effects.magnet = 5;
  addEnergy(engine, 6, 6); // 1.414 from next head
  addEnergy(engine, 8, 8); // 3.6 from next head
  engine.step();
  assert.equal(engine.energyNodes.length, 1);
  assert.equal(engine.energyNodes[0].x, 8);
});

test('power-up timers expire independently', () => {
  const engine = isolatedEngine();
  engine.effects.slow = 8;
  engine.effects.double = 12;
  engine.effects.magnet = 10;
  engine.effects.shield = 1;
  for (let i = 0; i < 79; i += 1) engine.updateTimers(0.1); // 7.9s total
  assert.ok(Math.abs(engine.effects.slow - 0.1) < 1e-9);
  assert.ok(Math.abs(engine.effects.double - 4.1) < 1e-9);
  assert.ok(Math.abs(engine.effects.magnet - 2.1) < 1e-9);
  engine.updateTimers(0.2);
  assert.equal(engine.effects.slow, 0);
  assert.ok(engine.effects.double > 0);
  assert.ok(engine.effects.magnet > 0);
  assert.equal(engine.effects.shield, 1, 'shield is charge-based, not timed');
  for (let i = 0; i < 50; i += 1) engine.updateTimers(0.1); // +5s total = 13.1s
  assert.equal(engine.effects.double, 0);
  assert.equal(engine.effects.magnet, 0);
  assert.equal(engine.effects.slow, 0);
  const events = engine.drainEvents();
  assert.ok(events.some((event) => event.type === 'powerupExpired' && event.powerup === 'slow'));
});

test('slow motion lengthens the tick interval by 35% speed reduction', () => {
  const engine = isolatedEngine();
  const normal = engine.currentTickMs();
  engine.effects.slow = 8;
  const slowed = engine.currentTickMs();
  assert.ok(slowed > normal);
  assert.ok(Math.abs(normal / slowed - CONFIG.powerups.slowSpeedFactor) < 0.001);
});

test('board power-ups expire after their configured lifetime', () => {
  const engine = isolatedEngine();
  setSnake(engine, linearSnake(5, 5, 5));
  engine.powerUps = [
    { id: 1, type: 'slow', x: 10, y: 10, expiresAtStep: 0, seed: 1 },
  ];
  engine.step();
  assert.equal(engine.powerUps.length, 0);
  assert.ok(engine.drainEvents().some((event) => event.type === 'powerupExpire'));
});

test('power-up pickup activates effects and stats', () => {
  const engine = isolatedEngine();
  setSnake(engine, linearSnake(5, 5, 5));
  engine.powerUps = [{ id: 1, type: 'shield', x: 6, y: 5, expiresAtStep: 999, seed: 1 }];
  engine.step();
  assert.equal(engine.effects.shield, 1);
  assert.equal(engine.stats.powerupsUsed, 1);
  assert.ok(engine.usedPowerupTypes.has('shield'));
});

test('scoring is deterministic, speed-boosted and combo-aware', () => {
  const run = () => {
    const engine = isolatedEngine();
    setSnake(engine, linearSnake(4, 8, 5));
    engine.speedTier = 2;
    const scores = [];
    for (let i = 0; i < 4; i += 1) {
      addEnergy(engine, 5 + i, 8);
      engine.step();
      scores.push(engine.score);
    }
    return { engine, scores };
  };
  const first = run();
  const second = run();
  assert.deepEqual(first.scores, second.scores);
  // Base 100 + 2 speed tiers × 25 = 150 per node. Streaks 1–2 score 1×,
  // streaks 3–4 score 1.5×, then 2× at streak 5.
  assert.deepEqual(first.scores, [150, 300, 450, 675]);
  assert.equal(first.engine.streak, 4);
  assert.equal(first.engine.comboMultiplier, 1.5);
  assert.equal(first.engine.maxCombo, 4);
});

test('double points doubles node scoring', () => {
  const base = isolatedEngine();
  setSnake(base, linearSnake(5, 5, 4));
  addEnergy(base, 6, 5);
  base.step();
  const normalScore = base.score;
  assert.equal(normalScore, 100);

  const doubled = isolatedEngine();
  setSnake(doubled, linearSnake(5, 5, 4));
  doubled.effects.double = 10;
  addEnergy(doubled, 6, 5);
  doubled.step();
  assert.equal(doubled.score, normalScore * 2);
});

test('combo streaks reset after the quick-collection window', () => {
  const engine = isolatedEngine();
  setSnake(engine, linearSnake(5, 5, 5));
  addEnergy(engine, 6, 5);
  engine.step();
  assert.equal(engine.streak, 1);
  for (let i = 0; i < CONFIG.scoring.comboWindowSteps + 2; i += 1) engine.step();
  assert.equal(engine.streak, 0);
  assert.equal(engine.comboMultiplier, 1);
});

test('terminal sequence activates only the expected terminal', () => {
  const level = testLevel({
    objective: { type: 'terminals', count: 2 },
    terminals: [
      { x: 6, y: 5, index: 0, pairId: null, endpoint: null },
      { x: 8, y: 5, index: 1, pairId: null, endpoint: null },
    ],
  });
  const engine = isolatedEngine({ level });
  // Collecting sequence terminal 1 first must be ignored.
  setSnake(engine, linearSnake(7, 5, 4));
  engine.step();
  assert.equal(engine.terminals[1].active, false, 'out-of-order terminal stays offline');
  assert.equal(engine.nextTerminalIndex, 0);
  assert.ok(engine.drainEvents().some((event) => event.type === 'terminalLocked'));

  // Terminals are consumed when the surge enters their cell.
  setSnake(engine, linearSnake(5, 5, 4));
  engine.step();
  assert.equal(engine.terminals[0].active, true, 'terminal 0 is activated first');
  assert.equal(engine.stats.terminals, 1);
  assert.equal(engine.nextTerminalIndex, 1);
  assert.equal(engine.status, 'running');

  setSnake(engine, linearSnake(7, 5, 4));
  engine.step();
  assert.equal(engine.terminals[1].active, true, 'terminal 1 completes the sequence');
  assert.equal(engine.status, 'complete', `unexpected status ${engine.status}, cause ${engine.finalCause}`);
});

test('connect objective completes when both endpoints of every pair are active', () => {
  const level = testLevel({
    objective: { type: 'connect', pairs: 1 },
    terminals: [
      { x: 6, y: 5, index: 0, pairId: 0, endpoint: 0 },
      { x: 9, y: 5, index: 1, pairId: 0, endpoint: 1 },
    ],
  });
  const engine = isolatedEngine({ level });
  setSnake(engine, linearSnake(5, 5, 4));
  assert.equal(engine.terminals[0].active, false);
  engine.step(); // enters endpoint A
  assert.equal(engine.status, 'running');
  assert.equal(engine.terminals[0].active, true);
  assert.equal(engine.completedPairs.size, 0);
  setSnake(engine, linearSnake(8, 5, 4));
  engine.step(); // enters endpoint B, closing the link
  assert.equal(engine.completedPairs.size, 1);
  assert.equal(engine.status, 'complete');
  assert.ok(engine.score >= CONFIG.scoring.pairBase, `score was ${engine.score}`);
});

test('escape requires the node quota before the exit activates', () => {
  const level = testLevel({
    objective: { type: 'escape', target: 2 },
    exit: { x: 8, y: 5, kind: 'exit' },
  });
  const engine = isolatedEngine({ level });
  setSnake(engine, linearSnake(7, 5, 4));
  engine.step(); // reach exit with 0/2
  assert.equal(engine.status, 'running');
  assert.ok(engine.drainEvents().some((event) => event.type === 'exitLocked'));

  engine.collected = 2;
  setSnake(engine, linearSnake(7, 5, 4));
  engine.step();
  assert.equal(engine.status, 'complete');
  assert.equal(engine.exit.reached, true);
  assert.ok(engine.drainEvents().some((event) => event.type === 'complete'));
});

test('collect objective completes and awards a level bonus', () => {
  const level = testLevel({ objective: { type: 'collect', target: 3 }, parTime: 40 });
  const engine = isolatedEngine({ level });
  setSnake(engine, linearSnake(5, 5, 4));
  engine.collected = 2;
  engine.score = 250;
  addEnergy(engine, 6, 5);
  engine.step();
  assert.equal(engine.status, 'complete');
  assert.ok(engine.score >= 250 + CONFIG.scoring.nodeBase + CONFIG.scoring.levelClearBase);
  assert.ok(engine.calculateStars() >= 1);
});

test('campaign star ratings use par time and shield integrity', () => {
  const level = testLevel({ objective: { type: 'collect', target: 1 }, parTime: 40 });
  const engine = isolatedEngine({ level });
  engine.status = 'complete';
  engine.stats.shieldSaves = 0;

  // A shield still held at the finish also rules out a flawless rating.
  engine.elapsed = 20;
  engine.effects.shield = 1;
  assert.equal(engine.calculateStars(), 2);
  engine.effects.shield = 0;

  // Without a burned shield: inside par → 2, inside the efficiency window → 3.
  // parTime is 40, so the three-star window is 31.2 seconds.
  engine.elapsed = 35;
  assert.equal(engine.calculateStars(), 2);
  engine.elapsed = 30;
  assert.equal(engine.calculateStars(), 3);
  engine.elapsed = 80;
  assert.equal(engine.calculateStars(), 1);

  // A burned shield caps the rating at two stars.
  engine.elapsed = 20;
  engine.stats.shieldSaves = 1;
  assert.equal(engine.calculateStars(), 2);
});

test('endless speed ramps every configured number of collections', () => {
  const engine = new PowerEngine({ mode: 'endless', difficulty: 'normal', seed: 77 });
  engine.start();
  engine._replenishEnergy = () => {};
  engine._maybeSpawnPowerUp = () => {};
  setSnake(engine, linearSnake(4, 9, 5));
  const startTick = engine.currentTickMs();
  for (let i = 0; i < CONFIG.speed.endless.tierEveryCollections; i += 1) {
    addEnergy(engine, 5 + i, 9);
    engine.step();
  }
  assert.equal(engine.speedTier, 1);
  assert.ok(engine.currentTickMs() < startTick);
  assert.ok(engine.drainEvents().some((event) => event.type === 'speedRamp'));
});

test('update() advances a deterministic number of steps for a fixed dt', () => {
  const build = () => {
    const engine = new PowerEngine({ mode: 'endless', difficulty: 'normal', seed: 99 });
    engine.start();
    engine._replenishEnergy = () => {};
    engine._maybeSpawnPowerUp = () => {};
    setSnake(engine, linearSnake(4, 9, 5));
    return engine;
  };
  const a = build();
  const b = build();
  for (let i = 0; i < 10; i += 1) {
    a.update(0.1);
    b.update(0.1);
  }
  assert.equal(a.steps, b.steps);
  assert.deepEqual(a.getStateForTest(), b.getStateForTest());
});

test('initial energy nodes are reachable and never overlap the serpent', () => {
  for (let levelNumber = 1; levelNumber <= 30; levelNumber += 1) {
    const level = generateLevel(levelNumber);
    const engine = new PowerEngine({ mode: 'campaign', difficulty: 'normal', level, seed: 12 });
    const needsEnergy = ['collect', 'escape'].includes(level.objective.type);
    if (needsEnergy) {
      assert.ok(engine.energyNodes.length > 0, `level ${levelNumber} should start with energy`);
    }
    const occupied = new Set(engine.snake.map((s) => `${s.x},${s.y}`));
    const blocked = new Set([
      ...engine.hazards.map((cell) => `${cell.x},${cell.y}`),
      ...engine.barriers.map((cell) => `${cell.x},${cell.y}`),
      ...engine.terminals.map((cell) => `${cell.x},${cell.y}`),
      ...(engine.exit ? [`${engine.exit.x},${engine.exit.y}`] : []),
    ]);
    for (const node of engine.energyNodes) {
      const key = `${node.x},${node.y}`;
      assert.ok(!occupied.has(key), 'node overlaps snake');
      assert.ok(!blocked.has(key), 'node overlaps a blocked structure');
    }
  }
});
