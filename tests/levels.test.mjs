import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAPTERS,
  generateLevel,
  getCampaignLevels,
  getChapterForLevel,
  getLevelBlueprint,
  validateLevelLayout,
} from '../js/levels.js';
import { CONFIG } from '../js/config.js';
import { PowerEngine } from '../js/engine.js';

const layouts = Array.from({ length: 30 }, (_, index) => generateLevel(index + 1));

test('all 30 campaign levels generate and validate', () => {
  for (const layout of layouts) {
    const report = validateLevelLayout(layout);
    assert.equal(report.valid, true, `level ${layout.level}: ${report.errors.join('; ')}`);
    assert.ok(report.reachableCells >= 90);
  }
});

test('generation is deterministic for a given level number', () => {
  for (const levelNumber of [1, 5, 10, 17, 25, 30]) {
    const a = generateLevel(levelNumber);
    const b = generateLevel(levelNumber);
    assert.deepEqual(a, b, `level ${levelNumber} should be deterministic`);
  }
});

test('campaign covers six chapters of five levels with correct themes', () => {
  assert.equal(CHAPTERS.length, 6);
  for (const chapter of CHAPTERS) {
    assert.equal(chapter.levels[1] - chapter.levels[0] + 1, 5);
  }
  const expectedThemes = ['cpu', 'memory', 'power', 'gpu', 'nexus', 'reactor'];
  for (let level = 1; level <= 30; level += 1) {
    const chapter = getChapterForLevel(level);
    const theme = expectedThemes[Math.floor((level - 1) / 5)];
    assert.equal(chapter.theme, theme, `level ${level}`);
    assert.equal(layouts[level - 1].theme, theme);
  }
});

test('objective types are introduced progressively and every type is present', () => {
  const levels = getCampaignLevels();
  const byType = new Map();
  levels.forEach((level) => {
    const entry = byType.get(level.objective.type) || [];
    entry.push(level.level);
    byType.set(level.objective.type, entry);
  });
  assert.deepEqual([...byType.keys()].sort(), ['collect', 'connect', 'escape', 'terminals']);
  assert.equal(byType.get('terminals')[0], 3);
  assert.equal(byType.get('connect')[0], 5);
  assert.equal(byType.get('escape')[0], 8);
  assert.equal(byType.get('collect')[0], 1);
});

test('objective counts match generated geometry', () => {
  for (const layout of layouts) {
    if (layout.objective.type === 'collect' || layout.objective.type === 'escape') {
      assert.ok(layout.objective.target >= 1);
      assert.equal(layout.exit !== null, layout.objective.type === 'escape');
    }
    if (layout.objective.type === 'terminals') {
      assert.equal(layout.terminals.length, layout.objective.count);
      assert.deepEqual(
        layout.terminals.map((terminal) => terminal.index),
        Array.from({ length: layout.terminals.length }, (_, index) => index),
      );
    }
    if (layout.objective.type === 'connect') {
      assert.equal(layout.terminals.length, layout.objective.pairs * 2);
      const pairs = new Set(layout.terminals.map((terminal) => terminal.pairId));
      assert.equal(pairs.size, layout.objective.pairs);
    }
  }
});

test('no structures overlap and spawn is clear on every level', () => {
  for (const layout of layouts) {
    const seen = new Set();
    const all = [
      ...layout.hazards.map((cell) => ({ ...cell, type: 'hazard' })),
      ...layout.barriers.map((cell) => ({ ...cell, type: 'barrier' })),
      ...layout.terminals.map((cell) => ({ ...cell, type: 'terminal' })),
      ...(layout.exit ? [{ ...layout.exit, type: 'exit' }] : []),
    ];
    for (const cell of all) {
      const key = `${cell.x},${cell.y}`;
      assert.equal(seen.has(key), false, `level ${layout.level} ${cell.type} overlaps at ${key}`);
      seen.add(key);
    }
    for (let i = 0; i < CONFIG.game.startLength; i += 1) {
      const key = `${CONFIG.game.startHead.x - i},${CONFIG.game.startHead.y}`;
      assert.equal(seen.has(key), false, `level ${layout.level} spawn overlaps at ${key}`);
    }
    for (let i = 1; i <= 4; i += 1) {
      const key = `${CONFIG.game.startHead.x + i},${CONFIG.game.startHead.y}`;
      assert.equal(seen.has(key), false, `level ${layout.level} spawn corridor blocked at ${key}`);
    }
  }
});

test('temporary barriers never gate objectives when energised', () => {
  for (const layout of layouts) {
    for (const group of layout.barrierGroups) {
      const blocked = new Set([
        ...layout.hazards.map((cell) => `${cell.x},${cell.y}`),
        ...layout.barriers.map((cell) => `${cell.x},${cell.y}`),
        ...group.cells.map((cell) => `${cell.x},${cell.y}`),
      ]);
      const seen = new Set();
      const queue = [{ ...CONFIG.game.startHead }];
      seen.add(`${queue[0].x},${queue[0].y}`);
      let index = 0;
      while (index < queue.length) {
        const current = queue[index++];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const x = ((current.x + dx) % CONFIG.game.cols + CONFIG.game.cols) % CONFIG.game.cols;
          const y = ((current.y + dy) % CONFIG.game.rows + CONFIG.game.rows) % CONFIG.game.rows;
          const key = `${x},${y}`;
          if (seen.has(key) || blocked.has(key)) continue;
          seen.add(key);
          queue.push({ x, y });
        }
      }
      for (const terminal of layout.terminals) {
        assert.ok(seen.has(`${terminal.x},${terminal.y}`), `level ${layout.level} barrier gates terminal`);
      }
      if (layout.exit) assert.ok(seen.has(`${layout.exit.x},${layout.exit.y}`), 'barrier gates exit');
    }
  }
});

test('difficulty metadata progresses across the campaign', () => {
  for (let i = 1; i < layouts.length; i += 1) {
    assert.ok(layouts[i].speedTier >= layouts[i - 1].speedTier, 'speed tier should not regress');
  }
  assert.ok(layouts[29].speedTier > layouts[0].speedTier);
  const expected = getLevelBlueprint(30);
  assert.equal(layouts[29].name, expected.name);
  assert.equal(layouts[29].level, 30);
});

test('validateLevelLayout rejects bad layouts', () => {
  const base = generateLevel(3);
  const withMissingTerminal = { ...base, terminals: base.terminals.slice(1) };
  assert.equal(validateLevelLayout(withMissingTerminal).valid, false);

  const overlap = structuredClone(base);
  overlap.hazards.push({ ...overlap.terminals[0], clusterId: 999 });
  assert.equal(validateLevelLayout(overlap).valid, false);

  const corrupted = { ...generateLevel(8) };
  corrupted.exit = null;
  assert.equal(validateLevelLayout(corrupted).valid, false);

  assert.equal(validateLevelLayout(null).valid, false);
});

test('every campaign level can instantiate a deterministic engine with reachable starting energy', () => {
  for (const layout of layouts) {
    const engine = new PowerEngine({
      mode: 'campaign',
      difficulty: 'normal',
      level: structuredClone(layout),
      seed: 100 + layout.level,
    });
    assert.equal(engine.status, 'ready');
    assert.equal(engine.levelNumber, layout.level);
    assert.deepEqual(engine.getObjectiveStatus().type, layout.objective.type);
    const needsEnergy = ['collect', 'escape'].includes(layout.objective.type);
    if (needsEnergy) assert.ok(engine.energyNodes.length >= 1);
    const reachable = engine._reachableCells();
    for (const node of engine.energyNodes) {
      assert.ok(
        reachable.has(`${node.x},${node.y}`),
        `level ${layout.level} starting node unreachable`,
      );
    }
    if (needsEnergy && layout.objective.target > CONFIG.spawn.energyCount) {
      assert.ok(
        reachable.size > CONFIG.spawn.energyCount * 3,
        `level ${layout.level} needs room to keep spawning energy`,
      );
    }
  }
});
