/**
 * POWER SURGE CIRCUIT — application shell.
 *
 * Owns the screen stack, the game loop, save data, audio routing and the
 * bridge between engine events and visual/audio feedback. All gameplay rules
 * live in engine.js; this file is presentation and orchestration only.
 */
import { CONFIG, DIFFICULTIES, DIFFICULTY_ORDER, POWERUP_META, getDifficulty } from './config.js';
import { applyThemeToDocument, getTheme } from './themes.js';
import { ACHIEVEMENTS } from './achievements.js';
import { createStorage } from './storage.js';
import { PowerEngine } from './engine.js';
import { generateLevel, getCampaignLevels, CHAPTERS } from './levels.js';
import { Renderer } from './renderer.js';
import { AudioEngine } from './audio.js';
import { InputController } from './input.js';
import { randomSeed } from './rng.js';

const APP_VERSION = '1.0.0';
const SCREEN_IDS = [
  'screen-menu',
  'screen-difficulty',
  'screen-campaign',
  'screen-settings',
  'screen-achievements',
  'screen-how',
  'screen-game',
];

const OBJECTIVE_LABELS = {
  collect: 'COLLECT',
  terminals: 'TERMINALS',
  connect: 'LINKS',
  escape: 'CHARGE',
  endless: 'SURVIVE',
};

function $(id) {
  return document.getElementById(id);
}

function formatNumber(value) {
  return Math.round(Number(value) || 0).toLocaleString('en-US');
}

function formatSeconds(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatObjectiveShort(objective) {
  if (!objective) return 'GOAL';
  switch (objective.type) {
    case 'collect':
      return `COLLECT ${objective.target}`;
    case 'terminals':
      return `SEQ ${objective.count}`;
    case 'connect':
      return `LINK ${objective.pairs}`;
    case 'escape':
      return `EXIT ${objective.target}`;
    default:
      return 'GOAL';
  }
}

class PowerSurgeApp {
  constructor() {
    this.storage = createStorage();
    this.save = this.storage.load();
    this.audio = new AudioEngine({
      musicVolume: this.save.settings.musicVolume,
      sfxVolume: this.save.settings.sfxVolume,
      onUnlock: () => this._startMusicForContext(),
    });
    this.audio.setMusicVolume(this.save.settings.musicVolume);
    this.audio.setSfxVolume(this.save.settings.sfxVolume);

    this.currentScreen = 'screen-menu';
    this.engine = null;
    this.renderer = null;
    this.input = null;
    this.runContext = null;
    this.rafId = null;
    this.lastFrameTime = 0;
    this.hudTimer = 0;
    this.hudDirty = true;
    this.countdown = null;
    this.ownedToasts = new Set();
    this.settingsReturnScreen = 'screen-menu';
    this.resultsVisible = false;
    this.resultsTimer = null;
    this.resultsToken = 0;
    this.runEndHandled = false;
    this.pausedViaVisibility = false;
    this.fpsAccumulator = 0;
    this.fpsFrames = 0;
    this.frameCount = 0;

    this.dom = this._collectDom();
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                               */
  /* ------------------------------------------------------------------ */

  init() {
    this._applySettingsToDocument();
    this._buildDifficultyGrid();
    this._buildCampaignScreen();
    this._buildAchievementList();
    this._bindMenu();
    this._bindSettings();
    this._bindGameControls();
    this._setupRenderer();
    this._refreshMenu();
    this._reportStorageStatus();
    this._installAudioUnlockListeners();

    document.addEventListener('visibilitychange', () => this._handleVisibilityChange());
    window.addEventListener('orientationchange', () => this._handleResize());
    window.addEventListener('resize', () => this._handleResize());
    window.addEventListener('beforeunload', () => this._persistBeforeUnload());

    this.showScreen('screen-menu');
    this._startMenuMusicWhenReady();
  }

  _collectDom() {
    const screens = {};
    for (const id of SCREEN_IDS) screens[id] = $(id);
    return {
      screens,
      toastStack: $('toast-stack'),
      countdown: $('countdown'),
      countdownValue: $('countdown-value'),
      countdownHint: $('countdown-hint'),
      canvasWrap: $('canvas-wrap'),
      canvas: $('board'),
      hudScore: $('hud-score'),
      hudBest: $('hud-best'),
      hudObjective: $('hud-objective'),
      hudObjectiveLabel: $('hud-objective-label'),
      hudObjectiveFill: $('hud-objective-fill'),
      hudSpeed: $('hud-speed'),
      hudContext: $('hud-context'),
      hudContextLabel: $('hud-context-label'),
      powerupStrip: $('powerup-strip'),
      modalPause: $('modal-pause'),
      modalResults: $('modal-results'),
      pauseSubtitle: $('pause-subtitle'),
      pauseStats: $('pause-stats'),
      resultsTitle: $('results-title'),
      resultsSubtitle: $('results-subtitle'),
      resultsStars: $('results-stars'),
      resultsNewBest: $('results-newbest'),
      resultsStats: $('results-stats'),
      resultsPrimary: $('btn-results-primary'),
      resultsSecondary: $('btn-results-secondary'),
      resultsMenu: $('btn-results-menu'),
      muteGlyph: $('mute-glyph'),
      muteButton: $('btn-mute'),
      menuEndlessBest: $('menu-endless-best'),
      menuCampaignProgress: $('menu-campaign-progress'),
      menuDifficultyValue: $('menu-difficulty-value'),
      menuAchievementsCount: $('menu-achievements-count'),
      difficultyGrid: $('difficulty-grid'),
      campaignLevels: $('campaign-levels'),
      campaignChapterName: $('campaign-chapter-name'),
      campaignChapterDesc: $('campaign-chapter-desc'),
      campaignProgressBadge: $('campaign-progress-badge'),
      achievementList: $('achievement-list'),
      achievementsSummary: $('achievements-summary'),
      storageStatus: $('storage-status'),
      settingsVersion: $('settings-version'),
      gameFooter: $('game-footer'),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Screens                                                            */
  /* ------------------------------------------------------------------ */

  showScreen(id) {
    if (!this.dom.screens[id]) return;
    for (const [screenId, element] of Object.entries(this.dom.screens)) {
      const active = screenId === id;
      element.classList.toggle('is-active', active);
      element.setAttribute('aria-hidden', active ? 'false' : 'true');
    }
    this.currentScreen = id;
    if (id !== 'screen-game') {
      this._closePause();
      this._closeResults();
    }
    if (id === 'screen-settings') {
      this.settingsReturnScreen = this.settingsReturnScreen || 'screen-menu';
      this._reportStorageStatus();
    }
    if (id === 'screen-campaign') this._buildCampaignScreen();
    if (id === 'screen-achievements') this._buildAchievementList();
    if (id === 'screen-menu') this._refreshMenu();
    this._setInputEnabled(id === 'screen-game');
    this._applyThemeForScreen(id);
  }

  _applyThemeForScreen(id) {
    let themeKey = 'menu';
    if (id === 'screen-game' && this.runContext) {
      themeKey = this.runContext.themeKey;
    } else if (id === 'screen-campaign') {
      themeKey = this._lastCampaignTheme || 'cpu';
    } else if (id === 'screen-difficulty') {
      themeKey = 'menu';
    }
    applyThemeToDocument(themeKey);
    if (this.renderer) this.renderer.setTheme(themeKey);
  }

  /* ------------------------------------------------------------------ */
  /* Menu                                                               */
  /* ------------------------------------------------------------------ */

  _bindMenu() {
    $('menu-endless').addEventListener('click', () => this.startEndless());
    $('menu-campaign').addEventListener('click', () => {
      this._click();
      this.showScreen('screen-campaign');
    });
    $('menu-difficulty').addEventListener('click', () => {
      this._click();
      this.showScreen('screen-difficulty');
    });
    $('menu-achievements').addEventListener('click', () => {
      this._click();
      this.showScreen('screen-achievements');
    });
    $('menu-settings').addEventListener('click', () => {
      this._click();
      this.settingsReturnScreen = 'screen-menu';
      this.showScreen('screen-settings');
    });
    $('menu-how').addEventListener('click', () => {
      this._click();
      this.showScreen('screen-how');
    });
    this.dom.muteButton.addEventListener('click', () => this._toggleMute());

    for (const button of document.querySelectorAll('[data-back]')) {
      button.addEventListener('click', () => {
        this._back();
        this.showScreen(button.dataset.back);
      });
    }
  }

  _refreshMenu() {
    const save = this.storage.get();
    this.dom.menuEndlessBest.textContent = `BEST ${formatNumber(save.highScores.endless[save.settings.difficulty])}`;
    const completed = Object.values(save.campaign.levels).filter((level) => level.completions > 0).length;
    this.dom.menuCampaignProgress.textContent = `${completed} / ${CONFIG.campaign.totalLevels}`;
    this.dom.menuDifficultyValue.textContent = getDifficulty(save.settings.difficulty).label;
    const unlocked = Object.keys(save.achievements).length;
    this.dom.menuAchievementsCount.textContent = `${unlocked} / ${ACHIEVEMENTS.length}`;
    this._syncMuteButton();
  }

  _buildDifficultyGrid() {
    const grid = this.dom.difficultyGrid;
    grid.textContent = '';
    const current = this.storage.get().settings.difficulty;
    for (const key of DIFFICULTY_ORDER) {
      const difficulty = DIFFICULTIES[key];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'option-card';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', key === current ? 'true' : 'false');
      button.dataset.difficulty = key;
      if (key === current) button.classList.add('is-selected');
      const cellsPerSecond = (1000 / difficulty.baseTickMs).toFixed(1);
      button.innerHTML = `
        <h3>${difficulty.label}</h3>
        <p>${difficulty.blurb}</p>
        <div class="meta">
          <span class="badge">START ${cellsPerSecond} cells/s</span>
          <span class="badge">LIMIT ${(1000 / difficulty.minTickMs).toFixed(1)}</span>
        </div>`;
      button.addEventListener('click', () => {
        this._click();
        this.storage.setDifficulty(key);
        this.save = this.storage.get();
        for (const sibling of grid.children) {
          const selected = sibling.dataset.difficulty === key;
          sibling.classList.toggle('is-selected', selected);
          sibling.setAttribute('aria-checked', selected ? 'true' : 'false');
        }
        this._refreshMenu();
        this._buildCampaignScreen();
      });
      grid.appendChild(button);
    }
  }

  _buildCampaignScreen() {
    const save = this.storage.get();
    const container = this.dom.campaignLevels;
    container.textContent = '';
    const levels = getCampaignLevels();
    const completedCount = levels.filter((level) => save.campaign.levels[String(level.level)]?.completions > 0).length;
    this.dom.campaignProgressBadge.textContent = `${completedCount}/${CONFIG.campaign.totalLevels}`;
    this._lastCampaignTheme = 'cpu';

    for (const chapter of CHAPTERS) {
      const section = document.createElement('section');
      section.className = 'chapter';
      const head = document.createElement('div');
      head.className = 'chapter-head';
      head.innerHTML = `<h3>${chapter.number}. ${chapter.name}</h3><span class="rule"></span>`;
      section.appendChild(head);

      const grid = document.createElement('div');
      grid.className = 'level-grid';

      for (const level of levels.filter(
        (entry) => entry.chapterId === chapter.id,
      )) {
        const record = save.campaign.levels[String(level.level)];
        const unlocked = level.level <= save.campaign.unlocked;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'level-chip';
        chip.disabled = !unlocked;
        if (record?.completions) chip.classList.add('is-complete');
        const stars = record ? '★'.repeat(record.stars) + '☆'.repeat(3 - record.stars) : '';
        chip.innerHTML = `
          <span class="num">${level.level}</span>
          <span class="obj">${formatObjectiveShort(level.objective)}</span>
          <span class="stars">${unlocked ? stars : '🔒'}</span>`;
        chip.setAttribute(
          'aria-label',
          `Level ${level.level}, ${level.name}, ${level.objective.type}${
            unlocked ? (record ? `, ${record.stars} stars, best ${record.bestScore}` : ', not completed') : ', locked'
          }`,
        );
        chip.addEventListener('click', () => {
          if (!unlocked) return;
          this._click();
          this._lastCampaignTheme = chapter.theme;
          this.startCampaign(level.level);
        });
        chip.addEventListener('focus', () => {
          this.dom.campaignChapterName.textContent = `${chapter.name} · ${level.name}`;
          this.dom.campaignChapterDesc.textContent = level.description || chapter.tagline;
          applyThemeToDocument(chapter.theme);
        });
        chip.addEventListener('blur', () => {
          this.dom.campaignChapterName.textContent = chapter.name;
          this.dom.campaignChapterDesc.textContent = chapter.description;
          applyThemeToDocument(this._lastCampaignTheme);
        });
        grid.appendChild(chip);
      }

      section.appendChild(grid);
      container.appendChild(section);
    }
  }

  _buildAchievementList() {
    const save = this.storage.get();
    const list = this.dom.achievementList;
    list.textContent = '';
    let unlockedCount = 0;
    for (const achievement of ACHIEVEMENTS) {
      const unlocked = Boolean(save.achievements[achievement.id]);
      if (unlocked) unlockedCount += 1;
      const item = document.createElement('div');
      item.className = `achievement tier-${achievement.tier} ${unlocked ? 'is-unlocked' : 'is-locked'}`;
      const status = unlocked
        ? new Date(save.achievements[achievement.id].unlockedAt || Date.now()).toLocaleDateString()
        : 'LOCKED';
      item.innerHTML = `
        <span class="icon" aria-hidden="true">${achievement.icon}</span>
        <span class="body">
          <strong>${achievement.name}</strong>
          <span>${achievement.description}</span>
        </span>
        <span class="status">${status}</span>`;
      list.appendChild(item);
    }
    this.dom.achievementsSummary.textContent = `${unlockedCount} of ${ACHIEVEMENTS.length} unlocked · ${achievementProgressPercent(
      unlockedCount,
    )}% complete`;
  }

  /* ------------------------------------------------------------------ */
  /* Settings                                                           */
  /* ------------------------------------------------------------------ */

  _bindSettings() {
    const music = $('set-music');
    const sfx = $('set-sfx');
    const speed = $('set-speed');
    const shake = $('set-shake');
    const contrast = $('set-contrast');
    const colorblind = $('set-colorblind');
    const motion = $('set-motion');

    const settings = this.storage.get().settings;
    music.value = String(settings.musicVolume);
    sfx.value = String(settings.sfxVolume);
    speed.value = String(settings.gameSpeed);
    shake.value = String(settings.screenShake);
    contrast.checked = settings.highContrast;
    colorblind.checked = settings.colorblind;
    motion.checked = settings.reducedMotion;
    this._updateSettingLabels();

    music.addEventListener('input', () => {
      const value = Number(music.value);
      this.storage.updateSettings({ musicVolume: value });
      this.audio.setMusicVolume(value);
      this._updateSettingLabels();
    });
    sfx.addEventListener('input', () => {
      const value = Number(sfx.value);
      this.storage.updateSettings({ sfxVolume: value });
      this.audio.setSfxVolume(value);
      this._updateSettingLabels();
    });
    sfx.addEventListener('change', () => this._play('powerup'));
    speed.addEventListener('input', () => {
      const value = Number(speed.value);
      this.storage.updateSettings({ gameSpeed: value });
      if (this.engine) this.engine.setUserSpeed(value);
      this._updateSettingLabels();
    });
    shake.addEventListener('input', () => {
      this.storage.updateSettings({ screenShake: Number(shake.value) });
      this._applySettingsToDocument();
      this._updateSettingLabels();
    });
    contrast.addEventListener('change', () => {
      this.storage.updateSettings({ highContrast: contrast.checked });
      this._applySettingsToDocument();
      this._click();
    });
    colorblind.addEventListener('change', () => {
      this.storage.updateSettings({ colorblind: colorblind.checked });
      this._applySettingsToDocument();
      this._click();
    });
    motion.addEventListener('change', () => {
      this.storage.updateSettings({ reducedMotion: motion.checked });
      this._applySettingsToDocument();
      this._click();
    });

    $('btn-reset-progress').addEventListener('click', () => {
      if (!window.confirm('Reset all scores, level unlocks and achievements? Settings are kept.')) return;
      this.storage.resetProgress();
      this.save = this.storage.get();
      this._buildCampaignScreen();
      this._buildAchievementList();
      this._refreshMenu();
      this._reportStorageStatus();
      this._toast('Progress reset', 'Scores and unlocks cleared.', '↺');
      this._play('uiBack');
    });

    $('btn-reset-all').addEventListener('click', () => {
      if (!window.confirm('Restore factory defaults? Every setting, score and unlock is erased.')) return;
      this.storage.resetAll();
      this.save = this.storage.get();
      this.audio.setMusicVolume(this.save.settings.musicVolume);
      this.audio.setSfxVolume(this.save.settings.sfxVolume);
      music.value = String(this.save.settings.musicVolume);
      sfx.value = String(this.save.settings.sfxVolume);
      speed.value = String(this.save.settings.gameSpeed);
      shake.value = String(this.save.settings.screenShake);
      contrast.checked = this.save.settings.highContrast;
      colorblind.checked = this.save.settings.colorblind;
      motion.checked = this.save.settings.reducedMotion;
      this._applySettingsToDocument();
      this._updateSettingLabels();
      this._buildDifficultyGrid();
      this._buildCampaignScreen();
      this._buildAchievementList();
      this._refreshMenu();
      this._reportStorageStatus();
      this._toast('Factory reset', 'All data restored to defaults.', '⟲');
      this._play('uiBack');
    });
  }

  _updateSettingLabels() {
    const settings = this.storage.get().settings;
    $('set-music-value').textContent = `${Math.round(settings.musicVolume * 100)}%`;
    $('set-sfx-value').textContent = `${Math.round(settings.sfxVolume * 100)}%`;
    $('set-speed-value').textContent = `${Math.round(settings.gameSpeed * 100)}%`;
    $('set-shake-value').textContent = `${Math.round(settings.screenShake * 100)}%`;
    this.dom.settingsVersion.textContent = `Power Surge Circuit v${APP_VERSION}`;
  }

  _applySettingsToDocument() {
    const settings = this.storage.get().settings;
    document.body.classList.toggle('high-contrast', settings.highContrast);
    document.body.classList.toggle('colorblind', settings.colorblind);
    document.body.classList.toggle('reduced-motion', settings.reducedMotion);
    if (this.renderer) {
      this.renderer.setSettings({
        reducedMotion: settings.reducedMotion,
        screenShake: settings.screenShake,
        highContrast: settings.highContrast,
        colorblind: settings.colorblind,
      });
    }
  }

  _reportStorageStatus() {
    const parts = [];
    parts.push(this.storage.isMemoryOnly ? 'Session only — browser storage unavailable, progress will not persist.' : 'Local storage active.');
    if (this.storage.corrupt) parts.push('Damaged save data was quarantined.');
    if (this.storage.recoveredFromBackup) parts.push('Recovered from the last good backup.');
    this.dom.storageStatus.textContent = parts.join(' ');
  }

  /* ------------------------------------------------------------------ */
  /* Renderer + input                                                   */
  /* ------------------------------------------------------------------ */

  _setupRenderer() {
    this.renderer = new Renderer(this.dom.canvas);
    this._applySettingsToDocument();
    this._handleResize();

    this.input = new InputController({
      target: this.dom.canvasWrap,
      onDirection: (direction) => this._handleDirection(direction),
      onPause: () => this._handlePauseKey(),
      onTap: () => this._handleTap(),
      onFirstInput: () => this._ensureAudio(),
    });
    this.input.attach();
    this._setInputEnabled(false);
  }

  _bindGameControls() {
    this.dom.modalPause.querySelector('#btn-resume').addEventListener('click', () => this._resumeGame());
    this.dom.modalPause.querySelector('#btn-pause-settings').addEventListener('click', () => {
      this._click();
      this.settingsReturnScreen = 'screen-game';
      this._closePause();
      this.showScreen('screen-settings');
    });
    this.dom.modalPause.querySelector('#btn-pause-restart').addEventListener('click', () => {
      this._click();
      this._restartRun();
    });
    this.dom.modalPause.querySelector('#btn-pause-menu').addEventListener('click', () => {
      this._back();
      this._quitToMenu();
    });
    this.dom.resultsPrimary.addEventListener('click', () => {
      this._click();
      this._handleResultsPrimary();
    });
    this.dom.resultsSecondary.addEventListener('click', () => {
      this._click();
      this._restartRun();
    });
    this.dom.resultsMenu.addEventListener('click', () => {
      this._back();
      this._quitToMenu();
    });
  }

  _setInputEnabled(enabled) {
    if (this.input) this.input.setEnabled(enabled);
  }

  _handleDirection(direction) {
    if (this.currentScreen !== 'screen-game') return;
    if (!this.engine) return;
    if (this.engine.status === 'running') {
      this.engine.queueDirection(direction.x, direction.y);
    }
  }

  _handlePauseKey() {
    if (this.currentScreen !== 'screen-game' || !this.engine) return;
    if (this.engine.status === 'running') this._pauseGame();
    else if (this.engine.status === 'paused') this._resumeGame();
  }

  _handleTap() {
    if (this.currentScreen !== 'screen-game' || !this.engine) return;
    if (this.engine.status === 'running') this._pauseGame();
    else if (this.engine.status === 'paused') this._resumeGame();
  }

  _handleResize() {
    if (!this.renderer) return;
    const rect = this.dom.canvasWrap.getBoundingClientRect();
    // A zero-sized box means the game screen is hidden; skip until visible.
    if (rect.width < 10 || rect.height < 10) return;
    this.renderer.resize(rect.width, rect.height);
  }

  _handleVisibilityChange() {
    if (document.hidden) {
      if (this.currentScreen === 'screen-game' && this.engine?.status === 'running') {
        this.pausedViaVisibility = true;
        this._pauseGame();
      }
      this.audio.stopMusic();
      this.audio.suspend();
    } else {
      this.audio.resume();
      this._startMusicForContext();
      if (this.pausedViaVisibility) this.pausedViaVisibility = false;
      this.lastFrameTime = 0;
    }
  }

  _persistBeforeUnload() {
    this.storage.save();
  }

  /* ------------------------------------------------------------------ */
  /* Audio helpers                                                      */
  /* ------------------------------------------------------------------ */

  _installAudioUnlockListeners() {
    const unlock = () => {
      this._ensureAudio();
    };
    for (const event of ['pointerdown', 'keydown', 'touchstart']) {
      window.addEventListener(event, unlock, { once: true, passive: true });
    }
  }

  async _ensureAudio() {
    if (this.audio.ready) return true;
    const ok = await this.audio.unlock();
    if (ok) this._startMusicForContext();
    return ok;
  }

  _startMusicForContext() {
    if (!this.audio.ready) return;
    if (this.audio.musicVolume <= 0) {
      this.audio.stopMusic();
      return;
    }
    const theme =
      this.currentScreen === 'screen-game' && this.runContext
        ? this.runContext.themeKey
        : 'menu';
    this.audio.startMusic(theme);
  }

  _startMenuMusicWhenReady() {
    if (!this.audio.ready) return;
    if (this.audio.musicVolume > 0) this.audio.startMusic('menu');
  }

  _play(name, options) {
    this.audio.play(name, options);
  }

  _click() {
    this._ensureAudio();
    this._play('ui');
  }

  _back() {
    this._play('uiBack');
  }

  _toggleMute() {
    const settings = this.storage.get().settings;
    const muted = settings.musicVolume <= 0 && settings.sfxVolume <= 0;
    if (muted) {
      const music = settings.musicVolume > 0 ? settings.musicVolume : CONFIG.audio.musicVolumeDefault;
      const sfx = settings.sfxVolume > 0 ? settings.sfxVolume : CONFIG.audio.sfxVolumeDefault;
      this.storage.updateSettings({ musicVolume: music, sfxVolume: sfx });
      this.audio.setMusicVolume(music);
      this.audio.setSfxVolume(sfx);
    } else {
      this.storage.updateSettings({ musicVolume: 0, sfxVolume: 0 });
      this.audio.setMusicVolume(0);
      this.audio.setSfxVolume(0);
      this.audio.stopMusic();
    }
    const save = this.storage.get();
    $('set-music').value = String(save.settings.musicVolume);
    $('set-sfx').value = String(save.settings.sfxVolume);
    this._updateSettingLabels();
    this._syncMuteButton();
    this._ensureAudio();
  }

  _syncMuteButton() {
    const settings = this.storage.get().settings;
    const muted = settings.musicVolume <= 0 && settings.sfxVolume <= 0;
    this.dom.muteGlyph.textContent = muted ? '🔇' : '♪';
    this.dom.muteButton.setAttribute('aria-pressed', muted ? 'true' : 'false');
    this.dom.muteButton.setAttribute('aria-label', muted ? 'Audio muted, click to unmute' : 'Audio on, click to mute');
  }

  /* ------------------------------------------------------------------ */
  /* Run lifecycle                                                      */
  /* ------------------------------------------------------------------ */

  startEndless() {
    this._click();
    const difficulty = this.storage.get().settings.difficulty;
    this._beginRun({
      mode: 'endless',
      difficulty,
      levelNumber: null,
      seed: randomSeed(),
      label: 'ENDLESS SURVIVAL',
    });
  }

  startCampaign(levelNumber) {
    const difficulty = this.storage.get().settings.difficulty;
    this._beginRun({
      mode: 'campaign',
      difficulty,
      levelNumber,
      seed: null,
      label: `LEVEL ${levelNumber}`,
    });
  }

  _beginRun({ mode, difficulty, levelNumber, seed, label }) {
    let engine;
    try {
      if (mode === 'campaign') {
        engine = new PowerEngine({
          mode,
          difficulty,
          level: generateLevel(levelNumber),
          seed: 0,
          userSpeed: this.storage.get().settings.gameSpeed,
        });
      } else {
        engine = new PowerEngine({
          mode,
          difficulty,
          seed,
          userSpeed: this.storage.get().settings.gameSpeed,
        });
      }
    } catch (error) {
      this._toast('Unable to load level', error.message, '⚠');
      this.showScreen('screen-campaign');
      return;
    }

    this.engine = engine;
    this.runContext = {
      mode,
      difficulty,
      levelNumber,
      label,
      themeKey: engine.themeKey,
      startedAt: Date.now(),
      shieldsUsed: 0,
      comfortableClears: 0,
      trackers: {
        usedAllPowerups: new Set(),
      },
    };
    this.ownedToasts.clear();
    this.resultsVisible = false;
    this.runEndHandled = false;
    this._cancelResultsReveal();
    this._closeResults();
    this.renderer.clearEffects();
    this.renderer.setTheme(engine.themeKey);
    this.audio.setMusicTheme(engine.themeKey);

    this.storage.setLastMode(mode);
    this.storage.setDifficulty(difficulty);

    this.dom.gameFooter.textContent = '';
    this.showScreen('screen-game');
    // The canvas box only has real dimensions once the screen is visible.
    requestAnimationFrame(() => {
      this._handleResize();
      this._handleResize();
    });

    const best =
      mode === 'campaign'
        ? this.storage.get().campaign.levels[String(levelNumber)]?.bestScore || 0
        : this.storage.get().highScores.endless[difficulty] || 0;
    this.dom.hudBest.textContent = `BEST ${formatNumber(best)}`;
    this.dom.hudContext.textContent =
      mode === 'campaign' ? `LEVEL ${levelNumber}` : 'ENDLESS';
    this.dom.hudContextLabel.textContent = mode === 'campaign' ? engine.level.chapterName : 'SPEED';
    this._updateHud(true);

    this._startCountdown();
    this._startMusicForContext();
  }

  _startCountdown() {
    const hint = this.engine.getObjectiveText();
    this.dom.countdownHint.textContent = this.engine.mode === 'campaign'
      ? `${this.engine.level.name.toUpperCase()} — ${hint}`
      : 'Collect energy nodes. The board wraps at every edge.';
    this.dom.countdownValue.textContent = '3';
    this.dom.countdown.classList.add('is-active');
    this.dom.countdown.setAttribute('aria-hidden', 'false');
    this.countdown = {
      remaining: CONFIG.game.countdownMs,
      lastValue: 3,
    };
  }

  _updateCountdown(deltaMs) {
    if (!this.countdown) return;
    this.countdown.remaining -= deltaMs;
    const value = Math.ceil(this.countdown.remaining / (CONFIG.game.countdownMs / 3));
    if (value !== this.countdown.lastValue) {
      this.countdown.lastValue = value;
      if (value > 0) {
        this.dom.countdownValue.textContent = String(value);
        // Retrigger the pop animation.
        this.dom.countdownValue.style.animation = 'none';
        this.dom.countdownValue.style.animation = '';
        this._play('ui');
      }
    }
    if (this.countdown.remaining <= 0) {
      this.dom.countdownValue.textContent = 'GO';
      this.dom.countdown.classList.remove('is-active');
      this.dom.countdown.setAttribute('aria-hidden', 'true');
      this.countdown = null;
      if (this.engine && this.engine.status === 'ready') {
        this.engine.start();
        this._play('speedRamp');
      }
    }
  }

  _pauseGame() {
    if (!this.engine || this.engine.status !== 'running') return;
    this.engine.pause();
    this._renderPauseStats();
    this.dom.pauseSubtitle.textContent = this._contextLabel();
    this.dom.modalPause.classList.add('is-active');
    this.dom.modalPause.setAttribute('aria-hidden', 'false');
    this.audio.stopMusic();
    this._play('uiBack');
  }

  _resumeGame() {
    if (!this.engine) return;
    this._closePause();
    if (this.engine.status === 'paused') {
      this.engine.resume();
      this.lastFrameTime = 0;
      this._play('ui');
      this._startMusicForContext();
    }
  }

  _closePause() {
    this.dom.modalPause.classList.remove('is-active');
    this.dom.modalPause.setAttribute('aria-hidden', 'true');
  }

  _closeResults() {
    this.resultsVisible = false;
    this._cancelResultsReveal();
    this.dom.modalResults.classList.remove('is-active');
    this.dom.modalResults.setAttribute('aria-hidden', 'true');
  }

  _restartRun() {
    if (!this.runContext) {
      this._quitToMenu();
      return;
    }
    const context = this.runContext;
    this._closePause();
    this._closeResults();
    if (context.mode === 'campaign') this.startCampaign(context.levelNumber);
    else this.startEndless();
  }

  _quitToMenu() {
    this.engine = null;
    this.runContext = null;
    this.countdown = null;
    this.renderer?.clearEffects();
    this._closePause();
    this._closeResults();
    this.showScreen('screen-menu');
    this._startMusicForContext();
  }

  _contextLabel() {
    if (!this.runContext) return '';
    const difficulty = getDifficulty(this.runContext.difficulty).label;
    if (this.runContext.mode === 'campaign' && this.engine?.level) {
      return `${this.engine.level.name.toUpperCase()} · ${this.engine.level.chapterName} · ${difficulty}`;
    }
    return `ENDLESS SURVIVAL · ${difficulty}`;
  }

  _renderPauseStats() {
    const engine = this.engine;
    if (!engine) return;
    const rows = [
      ['Score', formatNumber(engine.score)],
      ['Time', formatSeconds(engine.elapsed)],
      ['Nodes', formatNumber(engine.collected)],
      ['Best combo', `${engine.maxCombo}×`],
    ];
    this.dom.pauseStats.innerHTML = rows
      .map(
        ([label, value]) => `
        <div class="result-stat">
          <span class="label">${label}</span>
          <span class="value">${value}</span>
        </div>`,
      )
      .join('');
  }

  /* ------------------------------------------------------------------ */
  /* Results + progression                                              */
  /* ------------------------------------------------------------------ */

  _handleRunEnd() {
    const engine = this.engine;
    const context = this.runContext;
    if (!engine || !context || this.resultsVisible || this.runEndHandled) return;
    this.runEndHandled = true;

    const result = engine.getResult();
    const isCampaign = context.mode === 'campaign';
    const cleared = engine.status === 'complete';

    let bestInfo = { isNewBest: false, previousBest: 0 };
    if (cleared && isCampaign) {
      bestInfo = this.storage.recordCampaignLevel(context.levelNumber, {
        score: result.score,
        seconds: result.seconds,
        stars: result.stars,
        difficulty: context.difficulty,
        shieldsUsed: context.shieldsUsed,
      });
    } else if (!cleared && !isCampaign) {
      bestInfo = this.storage.recordRun({
        mode: 'endless',
        difficulty: context.difficulty,
        score: result.score,
        seconds: result.seconds,
        nodes: result.nodes,
        bestCombo: result.maxCombo,
        shieldSaves: result.shieldSaves,
        powerupsUsed: result.powerupsUsed,
      });
    } else if (!cleared && isCampaign) {
      // A failed campaign attempt still counts toward global stats.
      this.storage.recordRun({
        mode: 'campaign',
        difficulty: context.difficulty,
        score: result.score,
        seconds: result.seconds,
        nodes: result.nodes,
        bestCombo: result.maxCombo,
        shieldSaves: result.shieldSaves,
        powerupsUsed: result.powerupsUsed,
      });
    }

    this.save = this.storage.get();
    this._evaluateRunAchievements(result, cleared);

    if (cleared) {
      this._play('levelClear');
      this.renderer.addFlash(0.4);
    } else {
      this._play('collision');
      this._play('meltdown');
    }

    // The delay lets the explosion and clear flourish play out. If the player
    // restarts or quits before it fires, the pending reveal is cancelled so a
    // stale results card cannot appear over a fresh run.
    if (this.resultsTimer != null) clearTimeout(this.resultsTimer);
    const revealToken = ++this.resultsToken;
    this.resultsTimer = setTimeout(() => {
      this.resultsTimer = null;
      if (revealToken !== this.resultsToken) return;
      if (this.currentScreen !== 'screen-game') return;
      this._showResults(result, cleared, bestInfo);
    }, cleared ? 260 : CONFIG.game.resultsDelayMs);
  }

  _cancelResultsReveal() {
    this.resultsToken = (this.resultsToken || 0) + 1;
    if (this.resultsTimer != null) {
      clearTimeout(this.resultsTimer);
      this.resultsTimer = null;
    }
  }

  _showResults(result, cleared, bestInfo) {
    this.resultsVisible = true;
    const isCampaign = result.mode === 'campaign';

    this.dom.resultsTitle.textContent = cleared
      ? `Level ${result.level} Cleared`
      : isCampaign
        ? 'Surge Terminated'
        : 'Meltdown';
    this.dom.resultsSubtitle.textContent = isCampaign
      ? `${result.levelName?.toUpperCase() || ''} · ${result.chapterName} · ${getDifficulty(
          result.difficulty,
        ).label}`
      : `ENDLESS SURVIVAL · ${getDifficulty(result.difficulty).label}`;

    if (isCampaign && cleared) {
      const stars = result.stars || 1;
      this.dom.resultsStars.innerHTML = [1, 2, 3]
        .map(
          (index) =>
            `<span class="${index <= stars ? 'earned' : ''}" aria-hidden="true">${index <= stars ? '★' : '☆'}</span>`,
        )
        .join('');
      this.dom.resultsStars.setAttribute('aria-label', `${stars} of 3 stars`);
      this.dom.resultsStars.style.display = '';
    } else {
      this.dom.resultsStars.innerHTML = '';
      this.dom.resultsStars.style.display = 'none';
    }

    this.dom.resultsNewBest.hidden = !bestInfo?.isNewBest;
    if (bestInfo?.isNewBest) {
      this.dom.resultsNewBest.textContent = isCampaign ? 'New level record' : 'New personal best';
    }

    const rows = [
      ['Final score', formatNumber(result.score), true],
      ['Time', formatSeconds(result.seconds), false],
      ['Nodes', formatNumber(result.nodes), false],
      ['Best combo', `${result.maxCombo}×`, false],
      ['Power-ups', formatNumber(result.powerupsUsed), false],
      ['Shields used', formatNumber(result.shieldSaves), false],
    ];
    if (cleared && isCampaign && result.parTime) {
      rows.push(['Par time', formatSeconds(result.parTime), false]);
    }
    if (!cleared) {
      rows.push(['Cause', causeLabel(result.cause), false]);
      if (bestInfo?.previousBest) rows.push(['Previous best', formatNumber(bestInfo.previousBest), false]);
    }
    this.dom.resultsStats.innerHTML = rows
      .map(
        ([label, value, highlight]) => `
        <div class="result-stat${highlight ? ' highlight' : ''}">
          <span class="label">${label}</span>
          <span class="value">${value}</span>
        </div>`,
      )
      .join('');

    const nextLevel = isCampaign && cleared ? Math.min(result.level + 1, CONFIG.campaign.totalLevels) : null;
    const canAdvance = nextLevel != null && nextLevel !== result.level
      && nextLevel <= this.storage.get().campaign.unlocked;

    if (isCampaign) {
      this.dom.resultsPrimary.textContent = canAdvance ? `Next Level (${nextLevel})` : 'Retry Level';
      this.dom.resultsSecondary.parentElement.style.display = '';
      this.dom.resultsSecondary.textContent = canAdvance ? 'Replay' : 'Restart';
      this.runContext.nextLevel = canAdvance ? nextLevel : null;
    } else {
      this.dom.resultsPrimary.textContent = 'Play Again';
      this.dom.resultsSecondary.textContent = 'Restart';
      this.runContext.nextLevel = null;
    }

    this.dom.modalResults.classList.add('is-active');
    this.dom.modalResults.setAttribute('aria-hidden', 'false');
    this.dom.resultsPrimary.focus({ preventScroll: true });
    this.audio.stopMusic();
  }

  _handleResultsPrimary() {
    const nextLevel = this.runContext?.nextLevel;
    if (nextLevel) this.startCampaign(nextLevel);
    else this._restartRun();
  }

  _evaluateRunAchievements(result, cleared) {
    const save = this.storage.get();
    const unlock = (id) => {
      if (this.storage.unlockAchievement(id)) {
        const achievement = ACHIEVEMENTS.find((entry) => entry.id === id);
        if (achievement) {
          this._toast(`Achievement · ${achievement.name}`, achievement.description, achievement.icon);
        }
        this._play('achievement');
      }
    };

    if (save.stats.nodesCollected >= 1 || result.nodes >= 1) unlock('first_surge');
    if (result.maxCombo >= 8) unlock('chain_8');
    if (result.maxCombo >= 16) unlock('chain_16');
    if (result.shieldSaves >= 1) unlock('shield_burn');
    if (save.stats.nodesCollected >= 100) unlock('century');
    if (result.usedPowerups?.length >= 4) unlock('power_four');
    if (result.mode === 'endless' && result.score >= 10000) unlock('high_voltage');
    if (result.mode === 'endless' && result.seconds >= 300) unlock('survivor');
    if (result.mode === 'endless' && save.stats.endlessSecondsBest >= 300) unlock('survivor');

    if (cleared && result.mode === 'campaign') {
      if (result.level >= 5) unlock('cpu_clear');
      if (result.level >= 10) unlock('memory_clear');
      if (result.level >= 15) unlock('power_clear');
      if (result.level >= 20) unlock('gpu_clear');
      if (result.level >= 25) unlock('nexus_clear');
      if (result.level >= 30) unlock('reactor_clear');
      if (result.difficulty === 'hard') unlock('hard_clear');
      if (result.stars >= 3) unlock('untouchable');
    }

    this._refreshMenu();
  }

  /* ------------------------------------------------------------------ */
  /* Game loop                                                          */
  /* ------------------------------------------------------------------ */

  _startLoop() {
    if (this.rafId != null) return;
    const loop = (timestamp) => {
      this.rafId = requestAnimationFrame(loop);
      this._frame(timestamp);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  _frame(timestamp) {
    if (this.lastFrameTime === 0) this.lastFrameTime = timestamp;
    let deltaMs = timestamp - this.lastFrameTime;
    this.lastFrameTime = timestamp;
    if (deltaMs > 250) deltaMs = 250; // tab was backgrounded
    const delta = deltaMs / 1000;

    this.frameCount += 1;
    this.fpsAccumulator += delta;
    this.fpsFrames += 1;

    const onGameScreen = this.currentScreen === 'screen-game';
    const engine = this.engine;

    if (engine && onGameScreen) {
      if (this.countdown) {
        this._updateCountdown(deltaMs);
      } else if (engine.status === 'running') {
        engine.update(delta);
      }

      this._consumeEngineEvents(engine);
      this.renderer.render(engine, delta);
      this._debugOverlay();

      this.hudTimer += deltaMs;
      if (this.hudTimer >= CONFIG.ui.hudRefreshMs) {
        this.hudTimer = 0;
        this._updateHud(false);
      }

      // resultsVisible flips true when the card is presented; runEndHandled
      // stops the scoring pipeline re-running on every frame during the
      // presentation delay.
      if (
        (engine.status === 'over' || engine.status === 'complete') &&
        !this.resultsVisible &&
        !this.runEndHandled
      ) {
        this._handleRunEnd();
      }
    }
  }

  _debugOverlay() {
    if (!location.search.includes('debug')) return;
    if (this.fpsAccumulator < 1) return;
    const fps = this.fpsFrames / this.fpsAccumulator;
    this.fpsAccumulator = 0;
    this.fpsFrames = 0;
    if (!this.debugElement) {
      this.debugElement = document.createElement('div');
      this.debugElement.style.cssText =
        'position:absolute;top:6px;left:6px;z-index:40;font:11px ui-monospace,monospace;color:#9fe8ff;background:rgba(0,0,0,.6);padding:4px 6px;border-radius:6px;pointer-events:none';
      this.dom.canvasWrap.appendChild(this.debugElement);
    }
    const engine = this.engine;
    this.debugElement.textContent = [
      `${fps.toFixed(0)} fps`,
      `steps ${engine.steps}`,
      `tick ${engine.currentTickMs().toFixed(0)}ms`,
      `parts ${this.renderer.particles.length}`,
      `quality ${this.renderer.quality.toFixed(2)}`,
      `score ${engine.score}`,
    ].join(' · ');
  }

  /* ------------------------------------------------------------------ */
  /* Engine events → feedback                                           */
  /* ------------------------------------------------------------------ */

  _consumeEngineEvents(engine) {
    const events = engine.drainEvents();
    if (events.length === 0) return;
    const theme = getTheme(engine.themeKey);

    for (const event of events) {
      switch (event.type) {
        case 'collect': {
          const { x, y } = this.renderer.cellToPixel(event.cell.x, event.cell.y);
          this.renderer.spawnBurst(x, y, {
            count: event.source === 'magnet' ? 8 : 14,
            color: theme.accent,
            maxSpeed: 150,
            life: 0.5,
          });
          this._play(event.source === 'magnet' ? 'magnetCollect' : 'collect', { step: event.streak });
          this._floatCombo(event);
          break;
        }
        case 'energySpawn': {
          this._play('spark');
          break;
        }
        case 'powerup': {
          this.renderer.addFlash(0.3);
          this.renderer.addShake(3);
          this._play('powerup');
          const meta = POWERUP_META[event.powerup];
          this._toast(meta.label, meta.blurb, meta.glyph);
          break;
        }
        case 'powerupSpawn': {
          this._play('terminal');
          break;
        }
        case 'powerupExpire': {
          this._play('uiBack');
          break;
        }
        case 'powerupExpired': {
          break;
        }
        case 'shield': {
          const { x, y } = this.renderer.cellToPixel(event.cell.x, event.cell.y);
          this.renderer.spawnBurst(x, y, { count: 30, color: '#7dffb2', maxSpeed: 240, life: 0.8 });
          this.renderer.addFlash(0.5);
          this.renderer.addShake(12);
          this._play('shield');
          if (this.runContext) this.runContext.shieldsUsed += 1;
          this._toast('Shield absorbed the hit', 'Trail sealed. Keep moving.', '⬡');
          break;
        }
        case 'phase': {
          const { x, y } = this.renderer.cellToPixel(event.cell.x, event.cell.y);
          this.renderer.spawnBurst(x, y, { count: 12, color: theme.primary, maxSpeed: 120, life: 0.4 });
          break;
        }
        case 'terminal': {
          const { x, y } = this.renderer.cellToPixel(event.cell.x, event.cell.y);
          this.renderer.spawnBurst(x, y, { count: 24, color: theme.warning, maxSpeed: 220, life: 0.8 });
          this.renderer.addFlash(0.25);
          this._play('terminal');
          break;
        }
        case 'terminalLocked': {
          this._play('terminalLocked');
          this._toast(
            'Terminal offline',
            `Activate terminal ${event.expected + 1} first.`,
            '⚠',
            1600,
          );
          break;
        }
        case 'connected': {
          for (const endpoint of event.endpoints || []) {
            const { x, y } = this.renderer.cellToPixel(endpoint.x, endpoint.y);
            this.renderer.spawnBurst(x, y, { count: 26, color: theme.accent, maxSpeed: 240, life: 0.9 });
          }
          this.renderer.addFlash(0.3);
          this._play('connect');
          break;
        }
        case 'exit': {
          const { x, y } = this.renderer.cellToPixel(event.cell.x, event.cell.y);
          this.renderer.spawnBurst(x, y, { count: 40, color: theme.warning, maxSpeed: 280, life: 1 });
          break;
        }
        case 'exitLocked': {
          this._play('terminalLocked');
          this.renderer.addShake(2);
          break;
        }
        case 'speedRamp': {
          this._play('speedRamp');
          this.renderer.addFlash(0.2);
          this._toast(`Current ramping up`, `Speed tier ${event.tier} · ${event.cellsPerSecond.toFixed(1)} cells/s`, '⚡', 2200);
          break;
        }
        case 'hazardSpawn': {
          const { x, y } = this.renderer.cellToPixel(event.cell.x, event.cell.y);
          this.renderer.spawnSparks(event.cell.x, event.cell.y, { count: 18 });
          this.renderer.spawnBurst(x, y, { count: 10, color: theme.danger, maxSpeed: 90, life: 0.6 });
          this._play('hazard');
          this.renderer.boardCacheKey = '';
          break;
        }
        case 'gameover': {
          this.renderer.triggerExplosion(event.cell.x, event.cell.y);
          this.renderer.addShake(22);
          break;
        }
        case 'complete': {
          this.renderer.addFlash(0.45);
          break;
        }
        default:
          break;
      }
    }

    // Colourblind assist adds a subtle periodic spark on live barriers so the
    // hazard state is never carried by colour alone.
    if (this.renderer.settings.colorblind && engine.status === 'running') {
      for (const barrier of engine.barriers) {
        if (engine.isBarrierActiveAt(barrier)) {
          this.renderer.spawnSparks(barrier.x, barrier.y, { count: 1, life: 0.3 });
        }
      }
    }
  }

  _floatCombo(event) {
    if (event.streak < 3) return;
    if (this.renderer.settings.reducedMotion) return;
    const { x, y } = this.renderer.cellToPixel(event.cell.x, event.cell.y);
    const element = document.createElement('div');
    element.className = 'combo-float';
    element.textContent = event.multiplier > 1 ? `${event.multiplier}× +${formatNumber(event.points)}` : `+${formatNumber(event.points)}`;
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
    element.style.color = event.multiplier >= 2 ? getTheme(this.engine.themeKey).accent : undefined;
    this.dom.canvasWrap.appendChild(element);
    setTimeout(() => element.remove(), 800);
  }

  /* ------------------------------------------------------------------ */
  /* HUD + toasts                                                       */
  /* ------------------------------------------------------------------ */

  _updateHud(force) {
    const engine = this.engine;
    if (!engine) return;
    if (!force && !this.hudDirty) {
      // Still cheap enough to update every tick; kept simple for clarity.
    }
    const hud = engine.getHudState();

    this.dom.hudScore.textContent = formatNumber(hud.score);

    const objective = hud.objective;
    this.dom.hudObjectiveLabel.textContent = objective.label || OBJECTIVE_LABELS[objective.type] || 'GOAL';
    this.dom.hudObjective.textContent = objective.detail || '';
    const ratio =
      objective.target && objective.target > 0
        ? Math.min(1, (objective.current || 0) / objective.target)
        : objective.type === 'endless'
          ? 0
          : 0;
    this.dom.hudObjectiveFill.style.width = `${(ratio * 100).toFixed(1)}%`;
    this.dom.hudObjective.classList.toggle('warn', Boolean(objective.exitReady) || objective.complete);

    const speed = hud.speed;
    this.dom.hudSpeed.textContent = `${speed.cellsPerSecond.toFixed(1)}/s`;
    if (engine.mode === 'endless') {
      const label = CONFIG.endlessTierLabels[Math.min(speed.tier, CONFIG.endlessTierLabels.length - 1)];
      this.dom.hudContextLabel.textContent = chipLabelForTier(speed.tier);
      this.dom.hudContext.textContent = label;
    } else {
      this.dom.hudContextLabel.textContent = 'LEVEL';
      this.dom.hudContext.textContent = `${hud.level} · ${hud.levelName || ''}`.trim();
    }

    this._renderPowerupStrip(hud.activePowerups);
  }

  _renderPowerupStrip(active) {
    const strip = this.dom.powerupStrip;
    const wanted = active.map((entry) => entry.type).join(',');
    if (strip.dataset.state === wanted) return;
    strip.dataset.state = wanted;
    strip.textContent = '';
    for (const entry of active) {
      const pill = document.createElement('span');
      pill.className = 'powerup-pill';
      pill.style.color = entry.color;
      const ratio = entry.remaining == null ? 1 : entry.ratio;
      pill.innerHTML = `
        <span aria-hidden="true">${entry.glyph}</span>
        <span>${entry.label}</span>
        ${entry.remaining == null ? '' : `<span class="track"><i style="width:${(ratio * 100).toFixed(0)}%"></i></span>`}`;
      pill.setAttribute(
        'aria-label',
        entry.remaining == null
          ? `${entry.name} active`
          : `${entry.name}, ${entry.remaining.toFixed(1)} seconds remaining`,
      );
      strip.appendChild(pill);
    }
  }

  _toast(title, body, glyph = '⚡', duration = CONFIG.ui.toastMs) {
    const stack = this.dom.toastStack;
    const key = `${title}|${body}`;
    if (this.ownedToasts.has(key)) return;
    this.ownedToasts.add(key);
    const element = document.createElement('div');
    element.className = 'toast';
    element.innerHTML = `<span class="glyph" aria-hidden="true">${glyph}</span><span><strong>${title}</strong><br /><span>${body}</span></span>`;
    stack.appendChild(element);
    while (stack.children.length > 3) stack.firstElementChild.remove();
    setTimeout(() => {
      element.classList.add('is-leaving');
      setTimeout(() => {
        element.remove();
        this.ownedToasts.delete(key);
      }, 240);
    }, duration);
  }
}

function chipLabelForTier(tier) {
  if (tier === 0) return 'SPEED';
  return `TIER ${tier}`;
}

function causeLabel(cause) {
  switch (cause) {
    case 'self':
      return 'Trail contact';
    case 'hazard':
      return 'Damaged component';
    case 'barrier':
      return 'Energised barrier';
    default:
      return 'Surge lost';
  }
}

function achievementProgressPercent(unlocked) {
  return Math.round((unlocked / ACHIEVEMENTS.length) * 100);
}

/* -------------------------------------------------------------------- */
/* Boot                                                                 */
/* -------------------------------------------------------------------- */

function boot() {
  const app = new PowerSurgeApp();
  app.init();
  app._startLoop();
  window.powerSurge = app; // Debug handle for QA tooling.
  document.body.dataset.ready = 'true';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

export { PowerSurgeApp, boot };
