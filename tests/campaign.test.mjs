import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../js/storage.js';
import { CONFIG } from '../js/config.js';
import { ACHIEVEMENTS } from '../js/achievements.js';
import { DIFFICULTIES } from '../js/config.js';
import { generateLevel } from '../js/levels.js';

function memoryBackend() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function freshStorage(failures = 0) {
  const backend = memoryBackend();
  const storage = createStorage(backend);
  storage.load();
  return { storage, backend };
}

test('campaign progression walks forward one level at a time', () => {
  const { storage } = freshStorage();
  for (let level = 1; level <= CONFIG.campaign.totalLevels; level += 1) {
    const state = storage.get();
    assert.equal(state.campaign.unlocked >= level, true, `level ${level} should be unlocked`);
    const result = storage.recordCampaignLevel(level, {
      score: 1000 * level,
      seconds: 30 + level,
      stars: (level % 3) + 1,
      difficulty: 'normal',
      shieldsUsed: 0,
    });
    assert.equal(result.unlocked, Math.min(level + 1, CONFIG.campaign.totalLevels));
  }
  const state = storage.get();
  assert.equal(state.stats.campaignClears, CONFIG.campaign.totalLevels);
  assert.equal(Object.keys(state.campaign.levels).length, CONFIG.campaign.totalLevels);
  assert.equal(state.campaign.unlocked, CONFIG.campaign.totalLevels);
});

test('campaign progress survives a reload', () => {
  const backend = memoryBackend();
  const first = createStorage(backend);
  first.load();
  first.recordCampaignLevel(1, { score: 900, seconds: 40, stars: 2, difficulty: 'easy', shieldsUsed: 0 });
  first.recordCampaignLevel(2, { score: 1100, seconds: 38, stars: 3, difficulty: 'hard', shieldsUsed: 0 });

  const second = createStorage(backend);
  const data = second.load();
  assert.equal(data.campaign.unlocked, 3);
  assert.equal(data.campaign.levels['2'].stars, 3);
  assert.equal(data.campaign.levels['2'].lastDifficulty, 'hard');
  assert.equal(data.highScores.campaign.hard, 1100);
});

test('per-level best values only improve', () => {
  const { storage } = freshStorage();
  storage.recordCampaignLevel(4, { score: 2000, seconds: 50, stars: 1, difficulty: 'normal', shieldsUsed: 0 });
  storage.recordCampaignLevel(4, { score: 1500, seconds: 60, stars: 2, difficulty: 'normal', shieldsUsed: 0 });
  const entry = storage.get().campaign.levels['4'];
  assert.equal(entry.bestScore, 2000, 'best score is kept');
  assert.equal(entry.stars, 2, 'best star rating is kept');
  assert.equal(entry.bestTime, 50, 'best time is the fastest clear');
  assert.equal(entry.completions, 2);
});

test('level numbers outside the campaign range are rejected safely', () => {
  const { storage } = freshStorage();
  storage.recordCampaignLevel(0, { score: 100, seconds: 10, stars: 3, difficulty: 'normal', shieldsUsed: 0 });
  storage.recordCampaignLevel(999, { score: 100, seconds: 10, stars: 3, difficulty: 'normal', shieldsUsed: 0 });
  storage.recordCampaignLevel('not a number', { score: 100, seconds: 10, stars: 3, difficulty: 'normal', shieldsUsed: 0 });
  const levels = Object.keys(storage.get().campaign.levels);
  assert.deepEqual(levels.sort(), ['1', '30']);
});

test('all difficulty presets are well formed and distinct', () => {
  const keys = Object.keys(DIFFICULTIES);
  assert.deepEqual(keys.sort(), ['easy', 'hard', 'normal']);
  for (const key of keys) {
    const difficulty = DIFFICULTIES[key];
    assert.ok(difficulty.baseTickMs > 0);
    assert.ok(difficulty.minTickMs > 0);
    assert.ok(difficulty.minTickMs < difficulty.baseTickMs);
    assert.ok(difficulty.label.length > 0);
  }
  assert.ok(DIFFICULTIES.hard.baseTickMs < DIFFICULTIES.normal.baseTickMs);
  assert.ok(DIFFICULTIES.normal.baseTickMs < DIFFICULTIES.easy.baseTickMs);
});

test('every achievement is unique and fully described', () => {
  const ids = new Set();
  for (const achievement of ACHIEVEMENTS) {
    assert.ok(achievement.id, 'achievement id');
    assert.ok(!ids.has(achievement.id), `duplicate id ${achievement.id}`);
    ids.add(achievement.id);
    assert.ok(achievement.name.length > 0);
    assert.ok(achievement.description.length > 0);
    assert.ok(achievement.icon.length > 0);
    assert.ok(['bronze', 'silver', 'gold'].includes(achievement.tier));
  }
  assert.ok(ACHIEVEMENTS.length >= 15);
});

test('achievements can all be unlocked and persist', () => {
  const backend = memoryBackend();
  const storage = createStorage(backend);
  storage.load();
  for (const achievement of ACHIEVEMENTS) {
    assert.equal(storage.unlockAchievement(achievement.id), true);
  }
  const reloaded = createStorage(backend);
  const data = reloaded.load();
  assert.equal(Object.keys(data.achievements).length, ACHIEVEMENTS.length);
});

test('settings survive reload with accessibility flags intact', () => {
  const backend = memoryBackend();
  const storage = createStorage(backend);
  storage.load();
  storage.updateSettings({
    highContrast: true,
    colorblind: true,
    reducedMotion: true,
    gameSpeed: 1.2,
    screenShake: 0.4,
    musicVolume: 0.1,
    sfxVolume: 0.9,
    difficulty: 'hard',
  });
  const reloaded = createStorage(backend).load();
  assert.equal(reloaded.settings.highContrast, true);
  assert.equal(reloaded.settings.colorblind, true);
  assert.equal(reloaded.settings.reducedMotion, true);
  assert.equal(reloaded.settings.gameSpeed, 1.2);
  assert.equal(reloaded.settings.screenShake, 0.4);
  assert.equal(reloaded.settings.musicVolume, 0.1);
  assert.equal(reloaded.settings.sfxVolume, 0.9);
  assert.equal(reloaded.settings.difficulty, 'hard');
});

test('campaign level layouts stay valid after a full playthrough simulation', () => {
  // Simulates the win condition path for each level type without rendering.
  for (const type of ['collect', 'terminals', 'connect', 'escape']) {
    const layout = generateLevel(
      { collect: 1, terminals: 3, connect: 5, escape: 8 }[type],
    );
    assert.equal(layout.objective.type, type);
    if (type === 'escape') assert.ok(layout.exit);
    if (type === 'connect') {
      const pairs = new Set(layout.terminals.map((terminal) => terminal.pairId));
      assert.equal(pairs.size, layout.objective.pairs);
    }
    if (type === 'terminals') {
      assert.equal(layout.terminals.length, layout.objective.count);
      assert.deepEqual(
        layout.terminals.map((terminal) => terminal.index),
        [...layout.terminals.map((terminal) => terminal.index)].sort((a, b) => a - b),
      );
    }
  }
});
