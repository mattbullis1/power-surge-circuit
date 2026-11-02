/**
 * Campaign definition and deterministic procedural layout generation.
 *
 * Layouts are seeded from the level number, validated for reachability, and
 * regenerated with a new seed offset if validation fails. A barrier group is
 * additionally checked one group at a time: objectives must remain reachable
 * even while that group is energised, so barriers can never gate progress.
 */
import { CONFIG } from './config.js';
import { RNG, hashSeed } from './rng.js';

export const CHAPTERS = Object.freeze([
  {
    id: 'cpu',
    number: 1,
    name: 'CPU CORE',
    theme: 'cpu',
    levels: [1, 5],
    tagline: 'Boot sector. Clean buses, raw logic.',
    description: 'Learn the surge inside the processor’s primary logic die.',
  },
  {
    id: 'memory',
    number: 2,
    name: 'MEMORY BANKS',
    theme: 'memory',
    levels: [6, 10],
    tagline: 'Rows of volatile cells. Everything remembers.',
    description: 'Thread through address lines and volatile storage lattices.',
  },
  {
    id: 'power',
    number: 3,
    name: 'POWER SUPPLY',
    theme: 'power',
    levels: [11, 15],
    tagline: 'High current. Thin tolerance.',
    description: 'Ride the rails while capacitors discharge around you.',
  },
  {
    id: 'gpu',
    number: 4,
    name: 'GRAPHICS PROCESSOR',
    theme: 'gpu',
    levels: [16, 20],
    tagline: 'Parallel shards. Impossible colour.',
    description: 'Synchronise across shader lanes and raster threads.',
  },
  {
    id: 'nexus',
    number: 5,
    name: 'CIRCUIT NEXUS',
    theme: 'nexus',
    levels: [21, 25],
    tagline: 'Every trace converges here.',
    description: 'Cross the switching mesh at the heart of the machine.',
  },
  {
    id: 'reactor',
    number: 6,
    name: 'REACTOR CORE',
    theme: 'reactor',
    levels: [26, 30],
    tagline: 'Containment failing. One last surge.',
    description: 'Stabilise the reactor before the whole board melts down.',
  },
]);

const BLUEPRINTS = [
  { level: 1, name: 'Boot Sequence', objective: { type: 'collect', target: 6 }, hazards: 0, barriers: 0, speedTier: 0 },
  { level: 2, name: 'Cache Line', objective: { type: 'collect', target: 8 }, hazards: 2, barriers: 0, speedTier: 1 },
  { level: 3, name: 'Signal Path', objective: { type: 'terminals', count: 3 }, hazards: 2, barriers: 0, speedTier: 2 },
  { level: 4, name: 'Voltage Drift', objective: { type: 'collect', target: 10 }, hazards: 3, barriers: 0, speedTier: 3 },
  { level: 5, name: 'Core Lock', objective: { type: 'connect', pairs: 2 }, hazards: 4, barriers: 0, speedTier: 4 },

  { level: 6, name: 'Address Bus', objective: { type: 'collect', target: 10 }, hazards: 3, barriers: 1, speedTier: 4 },
  { level: 7, name: 'Parity Check', objective: { type: 'terminals', count: 4 }, hazards: 3, barriers: 2, speedTier: 5 },
  { level: 8, name: 'Memory Leak', objective: { type: 'escape', target: 8 }, hazards: 3, barriers: 2, speedTier: 6 },
  { level: 9, name: 'Dual Channel', objective: { type: 'connect', pairs: 3 }, hazards: 4, barriers: 2, speedTier: 6 },
  { level: 10, name: 'Bank Overflow', objective: { type: 'collect', target: 12 }, hazards: 5, barriers: 3, speedTier: 7 },

  { level: 11, name: 'Current Spike', objective: { type: 'escape', target: 9 }, hazards: 4, barriers: 3, speedTier: 7 },
  { level: 12, name: 'Capacitor Row', objective: { type: 'terminals', count: 5 }, hazards: 4, barriers: 4, speedTier: 8 },
  { level: 13, name: 'Brownout', objective: { type: 'collect', target: 12 }, hazards: 5, barriers: 4, speedTier: 8 },
  { level: 14, name: 'Relay Matrix', objective: { type: 'connect', pairs: 3 }, hazards: 5, barriers: 4, speedTier: 9 },
  { level: 15, name: 'Breaker Box', objective: { type: 'escape', target: 11 }, hazards: 5, barriers: 5, speedTier: 10 },

  { level: 16, name: 'Raster Run', objective: { type: 'collect', target: 14 }, hazards: 6, barriers: 4, speedTier: 10 },
  { level: 17, name: 'Shader Chain', objective: { type: 'terminals', count: 6 }, hazards: 6, barriers: 5, speedTier: 11 },
  { level: 18, name: 'Frame Drop', objective: { type: 'escape', target: 12 }, hazards: 6, barriers: 5, speedTier: 11 },
  { level: 19, name: 'Pixel Storm', objective: { type: 'connect', pairs: 4 }, hazards: 6, barriers: 5, speedTier: 12 },
  { level: 20, name: 'Overclock', objective: { type: 'collect', target: 16 }, hazards: 7, barriers: 6, speedTier: 13 },

  { level: 21, name: 'Crossroads', objective: { type: 'terminals', count: 6 }, hazards: 7, barriers: 6, speedTier: 13 },
  { level: 22, name: 'Mesh Link', objective: { type: 'connect', pairs: 4 }, hazards: 7, barriers: 7, speedTier: 14 },
  { level: 23, name: 'Signal Maze', objective: { type: 'escape', target: 14 }, hazards: 7, barriers: 7, speedTier: 15 },
  { level: 24, name: 'Data Flood', objective: { type: 'collect', target: 18 }, hazards: 8, barriers: 7, speedTier: 16 },
  { level: 25, name: 'Nexus Gate', objective: { type: 'terminals', count: 7 }, hazards: 8, barriers: 8, speedTier: 17 },

  { level: 26, name: 'Containment', objective: { type: 'connect', pairs: 4 }, hazards: 8, barriers: 8, speedTier: 17 },
  { level: 27, name: 'Thermal Runaway', objective: { type: 'escape', target: 16 }, hazards: 9, barriers: 8, speedTier: 18 },
  { level: 28, name: 'Ion Veil', objective: { type: 'collect', target: 20 }, hazards: 9, barriers: 9, speedTier: 19 },
  { level: 29, name: 'Meltdown Sequence', objective: { type: 'terminals', count: 8 }, hazards: 9, barriers: 9, speedTier: 20 },
  { level: 30, name: 'Power Surge', objective: { type: 'collect', target: 22 }, hazards: 10, barriers: 10, speedTier: 21 },
];

const HAZARD_SHAPES = [
  { weight: 34, cells: [[0, 0]] },
  { weight: 30, cells: [[0, 0], [1, 0]] },
  { weight: 14, cells: [[0, 0], [0, 1]] },
  { weight: 12, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  { weight: 10, cells: [[0, 0], [0, 1], [1, 1]] },
];

const LAYOUT_VERSION = 1;

export function getLevelBlueprint(levelNumber) {
  return BLUEPRINTS.find((entry) => entry.level === levelNumber) || BLUEPRINTS[0];
}

export function getChapterForLevel(levelNumber) {
  return (
    CHAPTERS.find((chapter) => levelNumber >= chapter.levels[0] && levelNumber <= chapter.levels[1]) ||
    CHAPTERS[0]
  );
}

export function getSpawnSegments() {
  const { startHead, startDirection, startLength } = CONFIG.game;
  const segments = [];
  for (let i = 0; i < startLength; i += 1) {
    segments.push({
      x: startHead.x - startDirection.x * i,
      y: startHead.y - startDirection.y * i,
    });
  }
  return segments;
}

export function getSpawnCells() {
  return getSpawnSegments();
}

export function getLandingCells() {
  const { startHead, startDirection } = CONFIG.game;
  const cells = [];
  for (let i = 1; i <= 6; i += 1) {
    cells.push({ x: startHead.x + startDirection.x * i, y: startHead.y + startDirection.y * i });
    cells.push({ x: startHead.x + startDirection.x * i, y: startHead.y + startDirection.y * i + 1 });
    cells.push({ x: startHead.x + startDirection.x * i, y: startHead.y + startDirection.y * i - 1 });
  }
  return cells;
}

function key(x, y) {
  return `${x},${y}`;
}

function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < CONFIG.game.cols && y < CONFIG.game.rows;
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function chebyshev(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function weightedPick(rng, entries) {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = rng.float(0, total);
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }
  return entries[entries.length - 1];
}

function collectForbiddenCells() {
  const forbidden = new Set();
  for (const cell of [...getSpawnCells(), ...getLandingCells()]) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const x = cell.x + dx;
        const y = cell.y + dy;
        if (inBounds(x, y)) forbidden.add(key(x, y));
      }
    }
  }
  return forbidden;
}

function canPlace(cells, { reserved, forbidden, nearHazards = false, hazardKeys = null }) {
  for (const cell of cells) {
    if (!inBounds(cell.x, cell.y)) return false;
    if (cell.x < 1 || cell.y < 1 || cell.x > CONFIG.game.cols - 2 || cell.y > CONFIG.game.rows - 2) {
      return false;
    }
    const cellKey = key(cell.x, cell.y);
    if (reserved.has(cellKey) || forbidden.has(cellKey)) return false;
    if (nearHazards && hazardKeys) {
      if (hazardKeys.has(cellKey)) return false;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (hazardKeys.has(key(cell.x + dx, cell.y + dy))) return false;
        }
      }
    }
  }
  return true;
}

function buildHazards(bp, rng, reserved, forbidden) {
  const hazardClusters = [];
  const hazardKeys = new Set();
  let clusterId = 0;

  for (let attempt = 0; attempt < bp.hazards * 26 && hazardClusters.length < bp.hazards; attempt += 1) {
    const shape = weightedPick(rng, HAZARD_SHAPES);
    const anchor = {
      x: rng.int(1, CONFIG.game.cols - 3),
      y: rng.int(1, CONFIG.game.rows - 3),
    };
    const cells = shape.cells.map(([dx, dy]) => ({ x: anchor.x + dx, y: anchor.y + dy }));
    if (!canPlace(cells, { reserved, forbidden })) continue;
    // Keep a one-cell service gap between components unless a single-cell
    // chip is deliberately brushed against another chip (visual variety).
    const touching = cells.some((cell) =>
      [...hazardKeys].some((existing) => {
        const [ex, ey] = existing.split(',').map(Number);
        return Math.abs(ex - cell.x) <= 1 && Math.abs(ey - cell.y) <= 1;
      }),
    );
    if (touching && rng.chance(0.8)) continue;

    const cluster = {
      id: clusterId,
      cells: cells.map((cell) => ({ ...cell })),
      seed: rng.int(0, 0xffffffff),
    };
    hazardClusters.push(cluster);
    cells.forEach((cell) => {
      reserved.add(key(cell.x, cell.y));
      hazardKeys.add(key(cell.x, cell.y));
    });
    clusterId += 1;
  }
  return { hazardClusters, hazardKeys };
}

function buildBarriers(bp, rng, reserved, forbidden, hazardKeys) {
  const barrierGroups = [];
  const barrierKeys = new Set();
  let groupId = 0;

  for (let attempt = 0; attempt < bp.barriers * 40 && barrierGroups.length < bp.barriers; attempt += 1) {
    const horizontal = rng.chance(0.5);
    const anchor = {
      x: rng.int(1, CONFIG.game.cols - 3),
      y: rng.int(1, CONFIG.game.rows - 2),
    };
    const cells = horizontal
      ? [{ x: anchor.x, y: anchor.y }, { x: anchor.x + 1, y: anchor.y }]
      : [{ x: anchor.x, y: anchor.y }, { x: anchor.x, y: anchor.y + 1 }];
    if (cells.some((cell) => hazardKeys.has(key(cell.x, cell.y)))) continue;
    if (!canPlace(cells, { reserved, forbidden, nearHazards: true, hazardKeys })) continue;
    const tooCloseToBarrier = cells.some((cell) =>
      [...barrierKeys].some((existing) => {
        const [ex, ey] = existing.split(',').map(Number);
        return chebyshev({ x: ex, y: ey }, cell) <= 1;
      }),
    );
    if (tooCloseToBarrier) continue;

    const group = {
      id: groupId,
      cells: cells.map((cell) => ({ ...cell })),
      offset: rng.float(0, CONFIG.barriers.period),
    };
    barrierGroups.push(group);
    cells.forEach((cell) => {
      reserved.add(key(cell.x, cell.y));
      barrierKeys.add(key(cell.x, cell.y));
    });
    groupId += 1;
  }
  return { barrierGroups, barrierKeys };
}

function randomFreeCell(rng, reserved, constraints = {}) {
  const { minHeadDistance = 0, minSpacing = [], spacing = 2 } = constraints;
  const head = CONFIG.game.startHead;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const cell = {
      x: rng.int(1, CONFIG.game.cols - 2),
      y: rng.int(1, CONFIG.game.rows - 2),
    };
    if (reserved.has(key(cell.x, cell.y))) continue;
    if (minHeadDistance > 0 && manhattan(cell, head) < minHeadDistance) continue;
    if (spacing > 0 && minSpacing.some((other) => chebyshev(cell, other) < spacing)) continue;
    return cell;
  }
  // Deterministic fallback scan.
  for (let y = 1; y < CONFIG.game.rows - 1; y += 1) {
    for (let x = 1; x < CONFIG.game.cols - 1; x += 1) {
      const cell = { x, y };
      if (reserved.has(key(x, y))) continue;
      if (minHeadDistance > 0 && manhattan(cell, head) < minHeadDistance) continue;
      if (spacing > 0 && minSpacing.some((other) => chebyshev(cell, other) < spacing)) continue;
      return cell;
    }
  }
  return null;
}

function buildTerminals(bp, rng, reserved) {
  const terminals = [];
  const objective = bp.objective;
  if (objective.type === 'terminals') {
    for (let i = 0; i < objective.count; i += 1) {
      const cell = randomFreeCell(rng, reserved, {
        minHeadDistance: 6,
        minSpacing: terminals,
        spacing: 3,
      });
      if (!cell) return { terminals, error: 'terminal placement failed' };
      const terminal = { ...cell, index: i, pairId: null, endpoint: null };
      terminals.push(terminal);
      reserved.add(key(cell.x, cell.y));
    }
    return { terminals };
  }

  if (objective.type === 'connect') {
    let index = 0;
    for (let pairId = 0; pairId < objective.pairs; pairId += 1) {
      const first = randomFreeCell(rng, reserved, {
        minHeadDistance: 5,
        minSpacing: terminals,
        spacing: 3,
      });
      if (!first) return { terminals, error: 'pair endpoint placement failed' };
      reserved.add(key(first.x, first.y));
      terminals.push({ ...first, index, pairId, endpoint: 0 });
      index += 1;

      let second = null;
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const candidate = randomFreeCell(rng, reserved, {
          minHeadDistance: 5,
          minSpacing: terminals,
          spacing: 3,
        });
        if (!candidate) break;
        const distance = manhattan(candidate, first);
        if (distance >= 6 && distance <= 15) {
          second = candidate;
          break;
        }
        // Reserve probe so retries do not repeatedly pick the same cell.
        if (rng.chance(0.15)) reserved.add(key(candidate.x, candidate.y));
      }
      if (!second) {
        // Relax the distance requirement, but keep endpoints distinct.
        second = randomFreeCell(rng, reserved, {
          minHeadDistance: 4,
          minSpacing: terminals,
          spacing: 2,
        });
      }
      if (!second) return { terminals, error: 'pair endpoint placement failed' };
      terminals.push({ ...second, index, pairId, endpoint: 1 });
      index += 1;
      reserved.add(key(second.x, second.y));
    }
    return { terminals };
  }

  return { terminals };
}

function buildExit(bp, rng, reserved) {
  if (bp.objective.type !== 'escape') return { exit: null };
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const cell = randomFreeCell(rng, reserved, {
      minHeadDistance: 11,
      minSpacing: [],
      spacing: 0,
    });
    if (!cell) continue;
    if (manhattan(cell, CONFIG.game.startHead) >= 11) {
      reserved.add(key(cell.x, cell.y));
      return { exit: { ...cell, kind: 'exit' } };
    }
  }
  return { exit: null, error: 'exit placement failed' };
}

function computeParTime(bp) {
  const objective = bp.objective;
  let seconds;
  if (objective.type === 'collect' || objective.type === 'escape') {
    seconds = 26 + objective.target * 2.1 + bp.hazards * 1.4 + bp.barriers * 0.8;
  } else if (objective.type === 'terminals') {
    seconds = 20 + objective.count * 4.5 + bp.hazards * 1.2 + bp.barriers * 0.6;
  } else {
    seconds = 24 + objective.pairs * 8 + bp.hazards * 1.2 + bp.barriers * 0.6;
  }
  return Math.round(seconds / 5) * 5;
}

function buildLayout(bp, rng) {
  const chapter = getChapterForLevel(bp.level);
  const reserved = new Set();
  const forbidden = collectForbiddenCells();

  getSpawnCells().forEach((cell) => reserved.add(key(cell.x, cell.y)));

  const { hazardClusters, hazardKeys } = buildHazards(bp, rng, reserved, forbidden);
  const { barrierGroups, barrierKeys } = buildBarriers(bp, rng, reserved, forbidden, hazardKeys);
  const { terminals, error: terminalError } = buildTerminals(bp, rng, reserved);
  const { exit, error: exitError } = buildExit(bp, rng, reserved);

  const hazards = hazardClusters.flatMap((cluster) =>
    cluster.cells.map((cell) => ({
      ...cell,
      clusterId: cluster.id,
      seed: cluster.seed,
    })),
  );
  const barriers = barrierGroups.flatMap((group) =>
    group.cells.map((cell) => ({
      ...cell,
      groupId: group.id,
      offset: group.offset,
    })),
  );

  return {
    layoutVersion: LAYOUT_VERSION,
    level: bp.level,
    name: bp.name,
    chapterId: chapter.id,
    chapterName: chapter.name,
    chapterNumber: chapter.number,
    theme: chapter.theme,
    objective: JSON.parse(JSON.stringify(bp.objective)),
    speedTier: bp.speedTier,
    parTime: computeParTime(bp),
    seed: rng.seed,
    hazards,
    hazardClusters,
    hazardKeys: [...hazardKeys],
    barriers,
    barrierGroups,
    barrierKeys: [...barrierKeys],
    terminals,
    exit,
    generationError: terminalError || exitError || null,
    optionalEnergy: !['collect', 'escape'].includes(bp.objective.type),
  };
}

function bfsReachable(start, blocked, cols, rows) {
  const seen = new Set();
  const queue = [start];
  const startKey = key(start.x, start.y);
  if (blocked.has(startKey)) return seen;
  seen.add(startKey);
  let index = 0;
  while (index < queue.length) {
    const current = queue[index];
    index += 1;
    const neighbours = [
      { x: current.x + 1, y: current.y },
      { x: current.x - 1, y: current.y },
      { x: current.x, y: current.y + 1 },
      { x: current.x, y: current.y - 1 },
    ];
    for (const next of neighbours) {
      const x = ((next.x % cols) + cols) % cols;
      const y = ((next.y % rows) + rows) % rows;
      const nextKey = key(x, y);
      if (seen.has(nextKey) || blocked.has(nextKey)) continue;
      seen.add(nextKey);
      queue.push({ x, y });
    }
  }
  return seen;
}

/**
 * Structural + playability validation. Safe to call from tests or tools.
 * @returns {{valid:boolean, errors:string[], reachableCells:number, freeCells:number}}
 */
export function validateLevelLayout(level) {
  const errors = [];
  if (!level || typeof level !== 'object') {
    return { valid: false, errors: ['layout is missing'], reachableCells: 0, freeCells: 0 };
  }
  const { cols, rows } = CONFIG.game;
  const head = CONFIG.game.startHead;
  const cells = new Map();
  const collisionKey = new Set();

  const checkCell = (cell, label, allowOccupied = false) => {
    if (!cell || !Number.isInteger(cell.x) || !Number.isInteger(cell.y)) {
      errors.push(`${label}: invalid coordinates`);
      return false;
    }
    if (cell.x < 0 || cell.y < 0 || cell.x >= cols || cell.y >= rows) {
      errors.push(`${label}: out of bounds ${cell.x},${cell.y}`);
      return false;
    }
    const cellKey = key(cell.x, cell.y);
    if (!allowOccupied && collisionKey.has(cellKey)) {
      errors.push(`${label}: overlaps another structure at ${cellKey}`);
      return false;
    }
    collisionKey.add(cellKey);
    cells.set(cellKey, label);
    return true;
  };

  getSpawnCells().forEach((cell, index) => {
    if (!checkCell(cell, `spawn[${index}]`)) return;
  });
  (level.hazards || []).forEach((cell, index) => checkCell(cell, `hazard[${index}]`));
  (level.barriers || []).forEach((cell, index) => checkCell(cell, `barrier[${index}]`));
  (level.terminals || []).forEach((cell, index) => checkCell(cell, `terminal[${index}]`));
  if (level.exit) checkCell(level.exit, 'exit');

  const objective = level.objective;
  if (!objective || !['collect', 'escape', 'terminals', 'connect'].includes(objective.type)) {
    errors.push('objective: invalid type');
  } else {
    if ((objective.type === 'collect' || objective.type === 'escape') && !(objective.target >= 1)) {
      errors.push('objective: missing target');
    }
    if (objective.type === 'terminals') {
      const count = (level.terminals || []).length;
      if (count !== objective.count) errors.push(`objective: expected ${objective.count} terminals, found ${count}`);
      (level.terminals || []).forEach((terminal, index) => {
        if (terminal.index !== index) errors.push(`terminal[${index}]: sequence index mismatch`);
      });
    }
    if (objective.type === 'connect') {
      const pairs = new Map();
      (level.terminals || []).forEach((terminal) => {
        if (!Number.isInteger(terminal.pairId)) {
          errors.push('connect: terminal missing pairId');
          return;
        }
        const entry = pairs.get(terminal.pairId) || [];
        entry.push(terminal);
        pairs.set(terminal.pairId, entry);
      });
      if (pairs.size !== objective.pairs) errors.push(`connect: expected ${objective.pairs} pairs, found ${pairs.size}`);
      pairs.forEach((endpoints, pairId) => {
        if (endpoints.length !== 2) errors.push(`connect: pair ${pairId} does not have two endpoints`);
        if (endpoints.length === 2 && manhattan(endpoints[0], endpoints[1]) < 2) {
          errors.push(`connect: pair ${pairId} endpoints are too close`);
        }
      });
    }
    if (objective.type === 'escape' && !level.exit) errors.push('escape: exit is missing');
    if (objective.type !== 'escape' && level.exit) errors.push('exit: should not exist for this objective');
  }

  const barrierGroups = level.barrierGroups || [];
  if (barrierGroups.some((group) => !Array.isArray(group.cells) || group.cells.length === 0)) {
    errors.push('barriers: malformed group');
  }
  const spawnKeys = new Set(getSpawnCells().map((cell) => key(cell.x, cell.y)));
  for (const spawnCell of getSpawnCells()) {
    if ((level.hazards || []).some((hazard) => hazard.x === spawnCell.x && hazard.y === spawnCell.y)) {
      errors.push('spawn: hazard overlaps starting serpent');
    }
    if ((level.barriers || []).some((barrier) => barrier.x === spawnCell.x && barrier.y === spawnCell.y)) {
      errors.push('spawn: barrier overlaps starting serpent');
    }
  }
  if (spawnKeys.size !== getSpawnCells().length) errors.push('spawn: duplicate cells');

  // Starting corridor must be clear. The player gets a full second to orient.
  for (let i = 1; i <= 4; i += 1) {
    const x = head.x + i;
    const y = head.y;
    const cellKey = key(x, y);
    if (level.hazards?.some((hazard) => hazard.x === x && hazard.y === y)) {
      errors.push('spawn corridor: hazard directly ahead');
    }
    if (level.barriers?.some((barrier) => barrier.x === x && barrier.y === y)) {
      errors.push('spawn corridor: barrier directly ahead');
    }
    if (cells.has(cellKey) && !level.terminals?.some((t) => t.x === x && t.y === y) && x >= cols - 1) {
      // Wrapping corridor cells are allowed; nothing to do.
    }
  }

  const blocked = new Set();
  (level.hazards || []).forEach((cell) => blocked.add(key(cell.x, cell.y)));
  (level.barriers || []).forEach((cell) => blocked.add(key(cell.x, cell.y)));
  const reachable = bfsReachable(head, blocked, cols, rows);
  const freeCells = cols * rows - blocked.size - getSpawnCells().length;

  for (const terminal of level.terminals || []) {
    if (!reachable.has(key(terminal.x, terminal.y))) {
      errors.push(`terminal ${terminal.index}: unreachable`);
    }
  }
  if (level.exit && !reachable.has(key(level.exit.x, level.exit.y))) {
    errors.push('exit: unreachable');
  }
  if (reachable.size < 90) errors.push('layout: too little navigable space');

  // Every barrier group must be bypassable while energised.
  for (const group of barrierGroups) {
    const blockedWithGroup = new Set(blocked);
    group.cells.forEach((cell) => blockedWithGroup.add(key(cell.x, cell.y)));
    const groupReachable = bfsReachable(head, blockedWithGroup, cols, rows);
    for (const terminal of level.terminals || []) {
      if (!groupReachable.has(key(terminal.x, terminal.y))) {
        errors.push(`barrier group ${group.id}: gates terminal ${terminal.index}`);
      }
    }
    if (level.exit && !groupReachable.has(key(level.exit.x, level.exit.y))) {
      errors.push(`barrier group ${group.id}: gates exit`);
    }
  }

  if (!(level.parTime > 0)) errors.push('parTime: must be positive');
  if (!Number.isFinite(level.speedTier) || level.speedTier < 0) errors.push('speedTier: invalid');

  return {
    valid: errors.length === 0,
    errors,
    reachableCells: reachable.size,
    freeCells,
  };
}

/**
 * Generates a deterministic, validated campaign layout.
 * @param {number} levelNumber 1..30
 */
export function generateLevel(levelNumber) {
  const number = Math.max(1, Math.min(CONFIG.campaign.totalLevels, Number(levelNumber) || 1));
  const bp = getLevelBlueprint(number);
  const baseSeed = hashSeed(`power-surge-circuit:campaign:v${LAYOUT_VERSION}:${number}`);
  let lastReport = null;

  for (let attempt = 0; attempt < 48; attempt += 1) {
    const rng = new RNG((baseSeed + Math.imul(attempt, 0x9e3779b1)) >>> 0);
    const layout = buildLayout(bp, rng);
    const report = validateLevelLayout(layout);
    lastReport = report;
    if (report.valid) {
      layout.generationReport = { attempt, reachableCells: report.reachableCells };
      return layout;
    }
  }

  const error = new Error(`Unable to generate valid layout for level ${number}: ${lastReport?.errors?.slice(0, 3).join('; ')}`);
  error.validation = lastReport;
  throw error;
}

/** Returns metadata for the level-select screen without generating geometry. */
export function getCampaignLevels() {
  return BLUEPRINTS.map((bp) => {
    const chapter = getChapterForLevel(bp.level);
    return {
      level: bp.level,
      name: bp.name,
      chapterId: chapter.id,
      chapterName: chapter.name,
      chapterNumber: chapter.number,
      theme: chapter.theme,
      objective: JSON.parse(JSON.stringify(bp.objective)),
      parTime: computeParTime(bp),
      speedTier: bp.speedTier,
      hazards: bp.hazards,
      barriers: bp.barriers,
    };
  });
}

export function getChapter(chapterIdOrNumber) {
  return (
    CHAPTERS.find(
      (chapter) => chapter.id === chapterIdOrNumber || chapter.number === Number(chapterIdOrNumber),
    ) || null
  );
}

export { bfsReachable, computeParTime };
