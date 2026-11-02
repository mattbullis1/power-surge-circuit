/**
 * POWER SURGE CIRCUIT — central balancing configuration.
 * Every gameplay tunable lives here so future balancing does not require
 * touching simulation code. Values are plain data, safe to freeze.
 */

export const GRID = Object.freeze({ cols: 24, rows: 18 });

export const DIFFICULTIES = Object.freeze({
  easy: {
    key: 'easy',
    label: 'EASY',
    short: 'EASY',
    baseTickMs: 210,
    minTickMs: 105,
    blurb: 'Forgiving current. Slower surge, wider reaction window.',
  },
  normal: {
    key: 'normal',
    label: 'NORMAL',
    short: 'NORM',
    baseTickMs: 165,
    minTickMs: 85,
    blurb: 'The intended charge. Balanced speed and pressure.',
  },
  hard: {
    key: 'hard',
    label: 'HARD',
    short: 'HARD',
    baseTickMs: 135,
    minTickMs: 72,
    blurb: 'Overclocked. Fast current for experienced operators.',
  },
});

export const DIFFICULTY_ORDER = Object.freeze(['easy', 'normal', 'hard']);

export const POWERUP_META = Object.freeze({
  slow: {
    key: 'slow',
    label: 'SLOW MOTION',
    short: 'SLOW',
    glyph: '◷',
    color: '#6ee7ff',
    blurb: 'Current resistance. Movement slows by 35%.',
  },
  double: {
    key: 'double',
    label: 'DOUBLE POINTS',
    short: '×2',
    glyph: '×2',
    color: '#ffd166',
    blurb: 'Score output doubled for 12 seconds.',
  },
  magnet: {
    key: 'magnet',
    label: 'MAGNET',
    short: 'MAG',
    glyph: '⌁',
    color: '#b388ff',
    blurb: 'Pulls in energy nodes within 2 cells.',
  },
  shield: {
    key: 'shield',
    label: 'SHIELD',
    short: 'SHD',
    glyph: '⬡',
    color: '#7dffb2',
    blurb: 'Absorbs one fatal collision, then burns out.',
  },
});

export const POWERUP_ORDER = Object.freeze(['slow', 'double', 'magnet', 'shield']);

export const CONFIG = Object.freeze({
  version: 1,

  game: {
    cols: GRID.cols,
    rows: GRID.rows,
    startLength: 5,
    startHead: { x: 7, y: 9 },
    startDirection: { x: 1, y: 0 },
    growthPerNode: 1,
    maxDeltaSeconds: 0.12,
    countdownMs: 2400,
    resultsDelayMs: 1050,
  },

  spawn: {
    energyCount: 3,
    terminalLevelEnergyCount: 2,
    energyMinHeadDistance: 4,
    energyMinSpacing: 2,
    powerupLifetimeSteps: 260,
    maxPlacementAttempts: 260,
  },

  speed: {
    userMin: 0.75,
    userMax: 1.25,
    userStep: 0.05,
    userDefault: 1,
    endless: {
      tierEveryCollections: 5,
      tierFactor: 0.93,
      maxTier: 10,
      hazardEveryTiers: 3,
      maxHazards: 12,
    },
    campaign: {
      tierFactor: 0.985,
    },
    maxStepsPerFrame: 4,
  },

  /**
   * Display-only labels for the endless speed tier shown in the HUD.
   * The engine still derives the numeric tier from speed.endless.*.
   */
  endlessTierLabels: Object.freeze(['STABLE', 'WARM', 'LOADED', 'SURGING', 'CRITICAL', 'OVERLOAD']),

  scoring: {
    nodeBase: 100,
    comboWindowSteps: 18,
    /**
     * Streaks that award 1×. The multiplier steps up every comboStep
     * collections after that, e.g. streaks 1–2 → 1×, 3–4 → 1.5×, 5–6 → 2×.
     */
    comboBaseStreak: 3,
    comboStep: 2,
    comboMultiplierStep: 0.5,
    comboMaxMultiplier: 4,
    speedBonusPerTier: 25,
    terminalBase: 250,
    pairBase: 300,
    escapeBase: 600,
    levelClearBase: 500,
    shieldBonus: 0,
  },

  powerups: {
    durations: { slow: 8, double: 12, magnet: 10, shield: 0 },
    slowSpeedFactor: 0.65,
    magnetRadius: 2,
    endlessSpawn: { minSteps: 55, maxSteps: 90, firstMinSteps: 30, firstMaxSteps: 50 },
    campaignSpawn: { minSteps: 75, maxSteps: 120, firstMinSteps: 45, firstMaxSteps: 70 },
    maxOnBoard: 1,
  },

  shield: {
    graceSteps: 3,
  },

  barriers: {
    period: 3.0,
    activeRatio: 0.5,
    warningFraction: 0.18,
  },

  campaign: {
    totalLevels: 30,
    levelsPerChapter: 5,
    chapters: 6,
    starParGrace: 1.5,
    starThreeEfficiency: 0.78,
  },

  ui: {
    hudRefreshMs: 100,
    toastMs: 3400,
    cardStaggerMs: 55,
  },

  storage: {
    key: 'powerSurgeCircuit.save.v1',
    backupKey: 'powerSurgeCircuit.save.v1.backup',
    corruptKeyPrefix: 'powerSurgeCircuit.corrupt.',
    version: 1,
  },

  audio: {
    musicVolumeDefault: 0.5,
    sfxVolumeDefault: 0.7,
    musicLookahead: 0.32,
    schedulerMs: 90,
    bpm: { menu: 92, cpu: 112, memory: 116, power: 120, gpu: 124, nexus: 128, reactor: 132 },
  },
});

export const GAME_KEYS = Object.freeze([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Space',
  'Escape',
]);

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function getDifficulty(key) {
  return DIFFICULTIES[key] || DIFFICULTIES.normal;
}
