/**
 * Versioned, defensive localStorage persistence.
 * Every value read from disk is treated as hostile: types are checked,
 * numbers clamped, unknown keys dropped. A corrupt primary save falls back
 * to the last known-good backup, then to defaults.
 */
import { CONFIG, DIFFICULTY_ORDER, clamp } from './config.js';
import { ACHIEVEMENT_IDS } from './achievements.js';

const VALID_DIFFICULTY = new Set(DIFFICULTY_ORDER);
const VALID_ACHIEVEMENT = new Set(ACHIEVEMENT_IDS);

export function createDefaultSave() {
  return {
    version: CONFIG.storage.version,
    settings: {
      difficulty: 'normal',
      highContrast: false,
      colorblind: false,
      reducedMotion: false,
      gameSpeed: CONFIG.speed.userDefault,
      screenShake: 1,
      musicVolume: CONFIG.audio.musicVolumeDefault,
      sfxVolume: CONFIG.audio.sfxVolumeDefault,
    },
    highScores: {
      endless: { easy: 0, normal: 0, hard: 0 },
      campaign: { easy: 0, normal: 0, hard: 0 },
    },
    campaign: {
      unlocked: 1,
      levels: {},
    },
    achievements: {},
    stats: {
      nodesCollected: 0,
      powerupsUsed: 0,
      shieldSaves: 0,
      runs: 0,
      campaignClears: 0,
      bestCombo: 0,
      endlessSecondsBest: 0,
    },
    lastMode: 'endless',
    lastDifficulty: 'normal',
    updatedAt: null,
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteInt(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return clamp(Math.floor(number), min, max);
}

function finiteNumber(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return clamp(number, min, max);
}

function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function sanitizeSettings(raw, defaults) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    difficulty: VALID_DIFFICULTY.has(source.difficulty) ? source.difficulty : defaults.difficulty,
    highContrast: booleanOr(source.highContrast, defaults.highContrast),
    colorblind: booleanOr(source.colorblind, defaults.colorblind),
    reducedMotion: booleanOr(source.reducedMotion, defaults.reducedMotion),
    gameSpeed: finiteNumber(source.gameSpeed, defaults.gameSpeed, CONFIG.speed.userMin, CONFIG.speed.userMax),
    screenShake: finiteNumber(source.screenShake, defaults.screenShake, 0, 1),
    musicVolume: finiteNumber(source.musicVolume, defaults.musicVolume, 0, 1),
    sfxVolume: finiteNumber(source.sfxVolume, defaults.sfxVolume, 0, 1),
  };
}

function sanitizeHighScores(raw, defaults) {
  const source = isPlainObject(raw) ? raw : {};
  const out = { endless: {}, campaign: {} };
  for (const mode of ['endless', 'campaign']) {
    const modeRaw = isPlainObject(source[mode]) ? source[mode] : {};
    const modeDefault = isPlainObject(defaults[mode]) ? defaults[mode] : {};
    for (const difficulty of DIFFICULTY_ORDER) {
      out[mode][difficulty] = finiteInt(
        modeRaw[difficulty],
        finiteInt(modeDefault[difficulty], 0),
        0,
        99_999_999,
      );
    }
  }
  return out;
}

function sanitizeCampaign(raw, defaults) {
  const source = isPlainObject(raw) ? raw : {};
  const levelsRaw = isPlainObject(source.levels) ? source.levels : {};
  const levels = {};
  for (const [key, value] of Object.entries(levelsRaw)) {
    const number = Number(key);
    if (!Number.isInteger(number) || number < 1 || number > CONFIG.campaign.totalLevels) continue;
    if (!isPlainObject(value)) continue;
    levels[String(number)] = {
      bestScore: finiteInt(value.bestScore, 0, 0, 99_999_999),
      stars: finiteInt(value.stars, 0, 0, 3),
      bestTime: finiteNumber(value.bestTime, 0, 0, 86_400),
      completions: finiteInt(value.completions, 0, 0, 1_000_000),
      lastDifficulty: VALID_DIFFICULTY.has(value.lastDifficulty) ? value.lastDifficulty : 'normal',
    };
  }
  const maxUnlockedFromLevels = Object.keys(levels).reduce((max, key) => {
    const level = Number(key);
    return levels[key].completions > 0 ? Math.max(max, Math.min(level + 1, CONFIG.campaign.totalLevels)) : max;
  }, 1);
  return {
    unlocked: Math.max(
      finiteInt(source.unlocked, defaults.unlocked, 1, CONFIG.campaign.totalLevels),
      maxUnlockedFromLevels,
    ),
    levels,
  };
}

function sanitizeAchievements(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const out = {};
  for (const [id, value] of Object.entries(source)) {
    if (!VALID_ACHIEVEMENT.has(id)) continue;
    if (isPlainObject(value)) {
      out[id] = {
        unlockedAt: finiteInt(value.unlockedAt, 0, 0, 9_999_999_999_999),
      };
    } else if (value === true) {
      out[id] = { unlockedAt: 0 };
    }
  }
  return out;
}

function sanitizeStats(raw, defaults) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    nodesCollected: finiteInt(source.nodesCollected, defaults.nodesCollected, 0, 99_999_999),
    powerupsUsed: finiteInt(source.powerupsUsed, defaults.powerupsUsed, 0, 99_999_999),
    shieldSaves: finiteInt(source.shieldSaves, defaults.shieldSaves, 0, 99_999_999),
    runs: finiteInt(source.runs, defaults.runs, 0, 99_999_999),
    campaignClears: finiteInt(source.campaignClears, defaults.campaignClears, 0, 99_999_999),
    bestCombo: finiteInt(source.bestCombo, defaults.bestCombo, 0, 9_999),
    endlessSecondsBest: finiteNumber(source.endlessSecondsBest, defaults.endlessSecondsBest, 0, 9_999_999),
  };
}

/** Converts arbitrary parsed JSON into a safe, complete save object. */
export function sanitizeSave(raw) {
  const defaults = createDefaultSave();
  if (!isPlainObject(raw)) return defaults;

  return {
    version: CONFIG.storage.version,
    settings: sanitizeSettings(raw.settings, defaults.settings),
    highScores: sanitizeHighScores(raw.highScores, defaults.highScores),
    campaign: sanitizeCampaign(raw.campaign, defaults.campaign),
    achievements: sanitizeAchievements(raw.achievements),
    stats: sanitizeStats(raw.stats, defaults.stats),
    lastMode: raw.lastMode === 'campaign' ? 'campaign' : 'endless',
    lastDifficulty: VALID_DIFFICULTY.has(raw.lastDifficulty)
      ? raw.lastDifficulty
      : defaults.lastDifficulty,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : null,
  };
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function createMemoryBackend() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/**
 * @param {Storage} [backend] localStorage-compatible object. Inject a fake
 * backend in tests. Falls back to memory if access throws (private mode).
 */
export function createStorage(backend) {
  let store = backend;
  let memoryOnly = false;

  if (!store) {
    try {
      store = globalThis.localStorage;
      if (!store) throw new Error('localStorage unavailable');
      // Access check: localStorage can be defined but throw on use.
      const probe = '__psc_probe__';
      store.setItem(probe, '1');
      store.removeItem(probe);
    } catch {
      store = createMemoryBackend();
      memoryOnly = true;
    }
  }

  function readKey(key) {
    try {
      return store.getItem(key);
    } catch {
      return null;
    }
  }

  function writeKey(key, value) {
    try {
      store.setItem(key, value);
    } catch {
      // Quota exceeded or storage disabled: continue with in-memory copy.
      memoryOnly = true;
    }
  }

  function parseKey(key) {
    const raw = readKey(key);
    if (raw == null || raw === '') return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  let data = createDefaultSave();
  let recoveredFromBackup = false;
  let corrupt = false;
  let lastWriteSucceeded = false;
  let lastWriteCorrupt = false;

  function load() {
    recoveredFromBackup = false;
    corrupt = false;

    let raw = readKey(CONFIG.storage.key);
    if (raw != null) {
      try {
        const parsed = JSON.parse(raw);
        if (!isPlainObject(parsed)) throw new Error('root is not an object');
        data = sanitizeSave(parsed);
        return data;
      } catch {
        corrupt = true;
        lastWriteCorrupt = true;
        lastWriteSucceeded = false;
      }
    }

    const backupRaw = readKey(CONFIG.storage.backupKey);
    if (backupRaw != null) {
      try {
        const parsed = JSON.parse(backupRaw);
        if (isPlainObject(parsed)) {
          data = sanitizeSave(parsed);
          recoveredFromBackup = true;
          // Preserve the damaged primary for diagnostics without breaking play.
          if (corrupt && raw != null) {
            const key = `${CONFIG.storage.corruptKeyPrefix}${Date.now()}`;
            writeKey(key, raw);
          }
          return data;
        }
      } catch {
        // backup also invalid
      }
    }

    data = createDefaultSave();
    if (corrupt && raw != null) {
      writeKey(`${CONFIG.storage.corruptKeyPrefix}${Date.now()}`, raw);
    }
    return data;
  }

  function save() {
    try {
      data.version = CONFIG.storage.version;
      data.updatedAt = Date.now();
      const serialized = JSON.stringify(data);
      // Never rotate a known-corrupt primary into the backup slot, otherwise a
      // good backup would be destroyed by the very failure it protects against.
      if (lastWriteSucceeded && !lastWriteCorrupt) {
        const previous = readKey(CONFIG.storage.key);
        if (previous) writeKey(CONFIG.storage.backupKey, previous);
      }
      lastWriteSucceeded = true;
      lastWriteCorrupt = false;
      writeKey(CONFIG.storage.key, serialized);
      return true;
    } catch {
      return false;
    }
  }

  function get() {
    return data;
  }

  function updateSettings(patch) {
    data.settings = sanitizeSettings({ ...data.settings, ...patch }, createDefaultSave().settings);
    save();
    return data.settings;
  }

  function setLastMode(mode) {
    data.lastMode = mode === 'campaign' ? 'campaign' : 'endless';
    save();
  }

  function setDifficulty(difficulty) {
    if (!VALID_DIFFICULTY.has(difficulty)) return data.settings.difficulty;
    data.settings.difficulty = difficulty;
    data.lastDifficulty = difficulty;
    save();
    return difficulty;
  }

  function recordRun({ mode, difficulty, score, seconds, nodes, bestCombo, shieldSaves, powerupsUsed }) {
    const diff = VALID_DIFFICULTY.has(difficulty) ? difficulty : 'normal';
    const modeKey = mode === 'campaign' ? 'campaign' : 'endless';
    const safeScore = finiteInt(score, 0, 0, 99_999_999);
    const previousBest = data.highScores[modeKey][diff] || 0;
    const isNewBest = safeScore > previousBest;
    if (isNewBest) data.highScores[modeKey][diff] = safeScore;
    data.stats.runs += 1;
    data.stats.nodesCollected += finiteInt(nodes, 0, 0, 99_999_999);
    data.stats.powerupsUsed += finiteInt(powerupsUsed, 0, 0, 99_999_999);
    data.stats.shieldSaves += finiteInt(shieldSaves, 0, 0, 99_999_999);
    data.stats.bestCombo = Math.max(data.stats.bestCombo, finiteInt(bestCombo, 0, 0, 9_999));
    if (modeKey === 'endless') {
      data.stats.endlessSecondsBest = Math.max(
        data.stats.endlessSecondsBest,
        finiteNumber(seconds, 0, 0, 9_999_999),
      );
    }
    save();
    return { isNewBest, previousBest };
  }

  function recordCampaignLevel(level, { score, seconds, stars, difficulty, shieldsUsed }) {
    const levelNumber = finiteInt(level, 1, 1, CONFIG.campaign.totalLevels);
    const key = String(levelNumber);
    const previous = data.campaign.levels[key] || {
      bestScore: 0,
      stars: 0,
      bestTime: 0,
      completions: 0,
      lastDifficulty: 'normal',
    };
    const newStars = finiteInt(stars, 1, 1, 3);
    const safeScore = finiteInt(score, 0, 0, 99_999_999);
    const safeTime = finiteNumber(seconds, 0, 0, 86_400);
    const isNewBest = safeScore > previous.bestScore;
    data.campaign.levels[key] = {
      bestScore: Math.max(previous.bestScore, safeScore),
      stars: Math.max(previous.stars, newStars),
      bestTime: previous.bestTime > 0 ? Math.min(previous.bestTime, safeTime) : safeTime,
      completions: previous.completions + 1,
      lastDifficulty: VALID_DIFFICULTY.has(difficulty) ? difficulty : 'normal',
    };
    data.campaign.unlocked = Math.max(
      data.campaign.unlocked,
      Math.min(levelNumber + 1, CONFIG.campaign.totalLevels),
    );
    data.stats.campaignClears += 1;
    data.stats.shieldSaves += finiteInt(shieldsUsed, 0, 0, 99_999);
    data.highScores.campaign[data.campaign.levels[key].lastDifficulty] = Math.max(
      data.highScores.campaign[data.campaign.levels[key].lastDifficulty],
      safeScore,
    );
    save();
    return { isNewBest, previousBest: previous.bestScore, unlocked: data.campaign.unlocked };
  }

  function unlockAchievement(id) {
    if (!VALID_ACHIEVEMENT.has(id) || data.achievements[id]) return false;
    data.achievements[id] = { unlockedAt: Date.now() };
    save();
    return true;
  }

  function isAchievementUnlocked(id) {
    return Boolean(data.achievements[id]);
  }

  function resetProgress() {
    const settings = clone(data.settings);
    const lastDifficulty = data.lastDifficulty;
    data = createDefaultSave();
    data.settings = sanitizeSettings(settings, data.settings);
    data.lastDifficulty = lastDifficulty;
    data.settings.difficulty = lastDifficulty;
    save();
    return data;
  }

  function resetAll() {
    data = createDefaultSave();
    save();
    return data;
  }

  return {
    load,
    save,
    get,
    updateSettings,
    setLastMode,
    setDifficulty,
    recordRun,
    recordCampaignLevel,
    unlockAchievement,
    isAchievementUnlocked,
    resetProgress,
    resetAll,
    get isMemoryOnly() {
      return memoryOnly;
    },
    get recoveredFromBackup() {
      return recoveredFromBackup;
    },
    get corrupt() {
      return corrupt;
    },
  };
}

export { finiteInt, finiteNumber };
