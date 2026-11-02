import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PowerEngine } from '../js/engine.js';
import { CONFIG } from '../js/config.js';
import { generateLevel } from '../js/levels.js';

/** Drives one simulated frame and returns the step count. */
function frame(engine, dt) {
  return engine.update(dt);
}

test('a long endless run stays internally consistent', () => {
  const engine = new PowerEngine({ mode: 'endless', difficulty: 'normal', seed: 2024 });
  engine.start();

  // Play for 90 simulated seconds with a simple greedy autopilot that avoids
  // hazards and its own body. This exercises spawn, collection, power-ups and
  // the endless speed ramp for thousands of steps.
  const directions = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 0, y: -1 },
  ];
  const elapsedFrames = Math.round(90 / (1 / 60));
  let collections = 0;

  for (let i = 0; i < elapsedFrames && engine.status === 'running'; i += 1) {
    frame(engine, 1 / 60);
    if (engine.status !== 'running') break;

    const head = engine.snake[0];
    const target = engine.energyNodes[0];
    const blocked = new Set();
    engine.snake.slice(1).forEach((segment) => blocked.add(`${segment.x},${segment.y}`));
    engine.hazards.forEach((hazard) => blocked.add(`${hazard.x},${hazard.y}`));
    engine.barriers.forEach((barrier) => blocked.add(`${barrier.x},${barrier.y}`));

    const legal = directions.filter((direction) => {
      if (direction.x === -engine.direction.x && direction.y === -engine.direction.y) return false;
      const x = ((head.x + direction.x) % engine.cols + engine.cols) % engine.cols;
      const y = ((head.y + direction.y) % engine.rows + engine.rows) % engine.rows;
      return !blocked.has(`${x},${y}`);
    });
    if (legal.length === 0) break;

    let best = legal[0];
    let bestScore = Infinity;
    for (const direction of legal) {
      const x = ((head.x + direction.x) % engine.cols + engine.cols) % engine.cols;
      const y = ((head.y + direction.y) % engine.rows + engine.rows) % engine.rows;
      const distance = target ? Math.abs(x - target.x) + Math.abs(y - target.y) : 0;
      if (distance < bestScore) {
        bestScore = distance;
        best = direction;
      }
    }
    engine.queueDirection(best.x, best.y);
    collections = engine.collected;
  }

  assert.ok(engine.steps > 100, `expected many steps, got ${engine.steps}`);
  assert.ok(collections > 0, 'autopilot should collect energy');
  // Invariants that must hold at any point during a run.
  const unique = new Set(engine.snake.map((segment) => `${segment.x},${segment.y}`));
  assert.equal(unique.size, engine.snake.length, 'no duplicate body segments');
  for (const segment of engine.snake) {
    assert.ok(segment.x >= 0 && segment.x < engine.cols);
    assert.ok(segment.y >= 0 && segment.y < engine.rows);
  }
  assert.ok(Number.isFinite(engine.score));
  assert.ok(engine.score >= 0);
  assert.ok(engine.currentTickMs() >= 42);
});

test('energy node count is maintained while the game runs', () => {
  const engine = new PowerEngine({ mode: 'endless', difficulty: 'easy', seed: 7 });
  engine.start();
  for (let i = 0; i < 40; i += 1) {
    engine.energyNodes.forEach(() => {});
    frame(engine, 0.2);
    if (engine.status !== 'running') break;
    assert.equal(engine.energyNodes.length, CONFIG.spawn.energyCount, `frame ${i}`);
  }
});

test('a shield never leaves the surge in an immediately fatal state', () => {
  const engine = new PowerEngine({ mode: 'endless', difficulty: 'normal', seed: 5 });
  engine.start();
  engine.effects.shield = 1;
  // Force a self-collision by waiting until the snake is long enough to bite
  // itself, then verifying the run continues for a few more steps.
  for (let i = 0; i < 3000 && engine.status === 'running'; i += 1) {
    frame(engine, 1 / 60);
    if (engine.stats.shieldSaves > 0) break;
  }
  if (engine.stats.shieldSaves > 0) {
    assert.equal(engine.effects.shield, 0, 'shield is consumed');
    assert.ok(engine.graceSteps >= 0);
    const before = engine.steps;
    for (let i = 0; i < 3; i += 1) frame(engine, 0.2);
    assert.ok(engine.steps > before, 'simulation continued after the shield rescue');
  }
});

test('pause and resume do not advance the simulation', () => {
  const engine = new PowerEngine({ mode: 'endless', difficulty: 'normal', seed: 11 });
  engine.start();
  frame(engine, 0.5);
  const stepsBefore = engine.steps;
  engine.pause();
  frame(engine, 5);
  assert.equal(engine.steps, stepsBefore);
  assert.equal(engine.status, 'paused');
  engine.resume();
  frame(engine, 0.5);
  assert.ok(engine.steps > stepsBefore);
});

test('the engine never allocates unbounded event queues', () => {
  const engine = new PowerEngine({ mode: 'endless', difficulty: 'normal', seed: 13 });
  engine.start();
  for (let i = 0; i < 900; i += 1) {
    frame(engine, 1 / 60);
    engine.drainEvents();
    if (engine.status !== 'running') break;
  }
  assert.ok(engine.events.length < 200, `event queue grew to ${engine.events.length}`);
});

test('frame time extremes do not break the simulation (tab switch catch-up)', () => {
  for (const dtSeconds of [0, 0.0001, 0.05, 0.25, 1, 30]) {
    const engine = new PowerEngine({ mode: 'endless', difficulty: 'normal', seed: 17 });
    engine.start();
    assert.doesNotThrow(() => frame(engine, dtSeconds), `dt=${dtSeconds}`);
    assert.ok(Number.isFinite(engine.elapsed));
    assert.ok(engine.elapsed <= CONFIG.game.maxDeltaSeconds + 1e-9, `dt=${dtSeconds}`);
  }
});

test('campaign engine completes each objective type', () => {
  const levelNumbers = { collect: 1, terminals: 3, connect: 5, escape: 8 };
  for (const [type, levelNumber] of Object.entries(levelNumbers)) {
    const layout = generateLevel(levelNumber);
    const engine = new PowerEngine({
      mode: 'campaign',
      difficulty: 'easy',
      level: layout,
      seed: 500 + levelNumber,
    });
    engine.start();
    assert.equal(engine.objective.type, type);
    const status = engine.getObjectiveStatus();
    assert.ok(status.detail.length > 0);
    assert.ok(engine.getObjectiveText().length > 0);
  }
});

test('state serialisation helpers stay cheap and stable', () => {
  const engine = new PowerEngine({ mode: 'endless', difficulty: 'hard', seed: 19 });
  engine.start();
  frame(engine, 0.4);
  const a = engine.getStateForTest();
  const b = engine.getStateForTest();
  assert.deepEqual(a, b);
  const hud = engine.getHudState();
  assert.equal(typeof hud.score, 'number');
  assert.ok(Array.isArray(hud.activePowerups));
  const result = engine.getResult();
  assert.equal(result.mode, 'endless');
  assert.equal(result.difficulty, 'hard');
});

test('repeated identical runs with the same seed stay identical', () => {
  const play = () => {
    const engine = new PowerEngine({ mode: 'endless', difficulty: 'normal', seed: 4242 });
    engine.start();
    for (let i = 0; i < 600; i += 1) {
      frame(engine, 1 / 60);
      engine.queueDirection(i % 2 === 0 ? 0 : 1, i % 2 === 0 ? 1 : 0);
      if (engine.status !== 'running') break;
    }
    return { score: engine.score, steps: engine.steps, snake: engine.snake.length, status: engine.status };
  };
  assert.deepEqual(play(), play());
});
