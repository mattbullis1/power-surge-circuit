import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultSave, createStorage, sanitizeSave } from '../js/storage.js';
import { CONFIG } from '../js/config.js';

function memoryBackend() {
  const map = new Map();
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    /** Test helper: how many distinct keys currently hold data. */
    size() {
      return map.size;
    },
    has(key) {
      return map.has(key);
    },
  };
}

test('empty storage loads defaults', () => {
  const backend = memoryBackend();
  const storage = createStorage(backend);
  const data = storage.load();
  assert.deepEqual(data, createDefaultSave());
  assert.equal(storage.corrupt, false);
  assert.equal(storage.recoveredFromBackup, false);
});

test('save and load round-trip settings, scores, campaign and achievements', () => {
  const backend = memoryBackend();
  const storage = createStorage(backend);
  storage.load();
  storage.updateSettings({ difficulty: 'hard', highContrast: true, musicVolume: 0.25 });
  storage.recordRun({
    mode: 'endless',
    difficulty: 'hard',
    score: 12345,
    seconds: 88.5,
    nodes: 40,
    bestCombo: 9,
    shieldSaves: 2,
    powerupsUsed: 3,
  });
  storage.recordCampaignLevel(1, { score: 2200, seconds: 41.2, stars: 2, difficulty: 'hard', shieldsUsed: 0 });
  storage.unlockAchievement('first_surge');
  storage.save();

  const reloaded = createStorage(backend);
  const data = reloaded.load();
  assert.equal(reloaded.corrupt, false);
  assert.equal(data.settings.difficulty, 'hard');
  assert.equal(data.settings.highContrast, true);
  assert.equal(data.settings.musicVolume, 0.25);
  assert.equal(data.highScores.endless.hard, 12345);
  assert.equal(data.campaign.unlocked, 2);
  assert.equal(data.campaign.levels['1'].stars, 2);
  assert.equal(data.campaign.levels['1'].bestScore, 2200);
  assert.ok(data.achievements.first_surge.unlockedAt > 0);
  assert.equal(data.stats.runs, 1);
  assert.equal(data.stats.bestCombo, 9);
});

test('corrupt primary recovers the last known-good backup', () => {
  const backend = memoryBackend();
  const storage = createStorage(backend);
  storage.load();
  storage.recordRun({
    mode: 'endless',
    difficulty: 'normal',
    score: 777,
    seconds: 12,
    nodes: 4,
    bestCombo: 2,
    shieldSaves: 0,
    powerupsUsed: 0,
  });
  // First save writes the primary. A second update rotates the previous
  // known-good primary into the backup slot.
  storage.updateSettings({ colorblind: true });
  assert.ok(backend.getItem(CONFIG.storage.key));
  assert.ok(backend.getItem(CONFIG.storage.backupKey));
  assert.match(backend.getItem(CONFIG.storage.key), /777/);
  assert.match(backend.getItem(CONFIG.storage.backupKey), /777/);

  // The primary is now unreadable JSON. The previous good copy in the backup
  // slot must be recovered rather than wiped.
  backend.setItem(CONFIG.storage.key, '{not valid json');
  assert.match(
    backend.getItem(CONFIG.storage.backupKey),
    /"normal":777/,
    'backup was rotated from the last known-good primary',
  );
  const recovered = createStorage(backend);
  const data = recovered.load();
  assert.equal(recovered.corrupt, true);
  assert.equal(recovered.recoveredFromBackup, true);
  assert.equal(data.highScores.endless.normal, 777);
  // The backup is the previous good snapshot, so it predates the last update.
  assert.equal(data.settings.colorblind, false);
  // Once the recovered data is saved back, the newer settings survive.
  recovered.updateSettings({ colorblind: true });
  const replayed = createStorage(backend);
  const replayedData = replayed.load();
  assert.equal(replayed.corrupt, false);
  assert.equal(replayedData.settings.colorblind, true);
  assert.equal(replayedData.highScores.endless.normal, 777);
});

test('corrupt primary and backup fall back to safe defaults', () => {
  const backend = memoryBackend();
  backend.setItem(CONFIG.storage.key, 'garbage');
  backend.setItem(CONFIG.storage.backupKey, 'also-garbage');
  const storage = createStorage(backend);
  const data = storage.load();
  assert.deepEqual(data, createDefaultSave());
  assert.equal(storage.corrupt, true);
  assert.equal(storage.recoveredFromBackup, false);
});

test('invalid values are sanitized and clamped', () => {
  const raw = {
    version: 999,
    settings: {
      difficulty: 'impossible',
      highContrast: 'yes',
      gameSpeed: 999,
      screenShake: -4,
      musicVolume: 12,
      sfxVolume: 'loud',
      reducedMotion: true,
    },
    highScores: { endless: { easy: -999, normal: '5000', hard: Infinity }, campaign: {} },
    campaign: { unlocked: 9000, levels: {
      '0': { stars: 99 },
      '1': { bestScore: 1000, stars: 99, bestTime: 30, completions: 2, lastDifficulty: 'bad' },
      '42': { bestScore: 5 },
      bad: { bestScore: 100 },
    } },
    achievements: { first_surge: { unlockedAt: 1 }, fake_achievement: { unlockedAt: 2 }, chain_8: true },
    stats: { nodesCollected: -10, bestCombo: 999999 },
    lastMode: 'nonsense',
    lastDifficulty: 'nonsense',
  };
  const sanitized = sanitizeSave(raw);
  assert.equal(sanitized.version, CONFIG.storage.version);
  assert.equal(sanitized.settings.difficulty, 'normal');
  assert.equal(sanitized.settings.highContrast, false);
  assert.equal(sanitized.settings.gameSpeed, CONFIG.speed.userMax);
  assert.equal(sanitized.settings.screenShake, 0);
  assert.equal(sanitized.settings.musicVolume, 1);
  assert.equal(sanitized.settings.sfxVolume, CONFIG.audio.sfxVolumeDefault);
  assert.equal(sanitized.settings.reducedMotion, true);
  assert.equal(sanitized.highScores.endless.easy, 0);
  assert.equal(sanitized.highScores.endless.normal, 5000);
  assert.equal(sanitized.highScores.endless.hard, 0);
  assert.equal(sanitized.campaign.unlocked, CONFIG.campaign.totalLevels);
  assert.equal(sanitized.campaign.levels['1'].stars, 3);
  assert.equal(sanitized.campaign.levels['1'].completions, 2);
  assert.equal(sanitized.campaign.levels['0'], undefined);
  assert.equal(sanitized.campaign.levels['42'], undefined);
  assert.equal(sanitized.achievements.fake_achievement, undefined);
  assert.ok(sanitized.achievements.chain_8);
  assert.equal(sanitized.stats.nodesCollected, 0);
  assert.equal(sanitized.stats.bestCombo, 9999);
  assert.equal(sanitized.lastMode, 'endless');
  assert.equal(sanitized.lastDifficulty, 'normal');
});

test('campaign completions unlock the next level and never go backwards', () => {
  const backend = memoryBackend();
  const storage = createStorage(backend);
  storage.load();
  assert.equal(storage.get().campaign.unlocked, 1);
  storage.recordCampaignLevel(1, { score: 500, seconds: 30, stars: 1, difficulty: 'normal', shieldsUsed: 0 });
  assert.equal(storage.get().campaign.unlocked, 2);
  storage.recordCampaignLevel(1, { score: 300, seconds: 20, stars: 3, difficulty: 'easy', shieldsUsed: 0 });
  assert.equal(storage.get().campaign.unlocked, 2);
  assert.equal(storage.get().campaign.levels['1'].bestScore, 500);
  assert.equal(storage.get().campaign.levels['1'].stars, 3);
  assert.equal(storage.get().campaign.levels['1'].completions, 2);
  storage.recordCampaignLevel(30, { score: 1000, seconds: 50, stars: 2, difficulty: 'hard', shieldsUsed: 0 });
  assert.equal(storage.get().campaign.unlocked, 30);
});

test('high scores only increase and return best status', () => {
  const backend = memoryBackend();
  const storage = createStorage(backend);
  storage.load();
  const first = storage.recordRun({
    mode: 'endless', difficulty: 'normal', score: 1000, seconds: 10, nodes: 2, bestCombo: 1, shieldSaves: 0, powerupsUsed: 0,
  });
  assert.deepEqual(first, { isNewBest: true, previousBest: 0 });
  const second = storage.recordRun({
    mode: 'endless', difficulty: 'normal', score: 500, seconds: 20, nodes: 3, bestCombo: 2, shieldSaves: 0, powerupsUsed: 1,
  });
  assert.equal(second.isNewBest, false);
  assert.equal(storage.get().highScores.endless.normal, 1000);
});

test('achievements unlock once and are idempotent', () => {
  const storage = createStorage(memoryBackend());
  storage.load();
  assert.equal(storage.isAchievementUnlocked('shield_burn'), false);
  assert.equal(storage.unlockAchievement('shield_burn'), true);
  assert.equal(storage.unlockAchievement('shield_burn'), false);
  assert.equal(storage.unlockAchievement('not_real'), false);
  assert.equal(storage.isAchievementUnlocked('shield_burn'), true);
});

test('reset progress preserves preferences but clears scores and campaign', () => {
  const storage = createStorage(memoryBackend());
  storage.load();
  storage.updateSettings({ highContrast: true, musicVolume: 0.1 });
  storage.recordRun({ mode: 'endless', difficulty: 'normal', score: 900, seconds: 5, nodes: 1, bestCombo: 1, shieldSaves: 0, powerupsUsed: 0 });
  storage.recordCampaignLevel(1, { score: 200, seconds: 20, stars: 1, difficulty: 'normal', shieldsUsed: 0 });
  storage.unlockAchievement('first_surge');
  storage.resetProgress();
  const data = storage.get();
  assert.equal(data.settings.highContrast, true);
  assert.equal(data.settings.musicVolume, 0.1);
  assert.equal(data.highScores.endless.normal, 0);
  assert.equal(data.campaign.unlocked, 1);
  assert.deepEqual(data.achievements, {});
  assert.equal(data.stats.runs, 0);
});

test('storage failures never throw', () => {
  const failing = {
    getItem() { return null; },
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() {},
  };
  const storage = createStorage(failing);
  assert.doesNotThrow(() => storage.load());
  storage.updateSettings({ highContrast: true });
  assert.equal(storage.get().settings.highContrast, true);
  assert.equal(storage.get().highScores.endless.normal, 0);
});

test('sanitizeSave handles non-object roots', () => {
  for (const value of [null, [], 'string', 42, true]) {
    assert.deepEqual(sanitizeSave(value), createDefaultSave());
  }
});
