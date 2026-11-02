/**
 * Procedural Web Audio engine.
 *
 * Everything is synthesised at runtime: no audio files, no network requests.
 * The context is created lazily on the first user gesture so browser autoplay
 * policies are respected. Music and sound effects have independent gains.
 */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Semitone distance from A4 (440 Hz). */
function frequencyFor(note, octave) {
  const index = NOTE_NAMES.indexOf(note);
  const semitones = (octave - 4) * 12 + (index - 9);
  return 440 * Math.pow(2, semitones / 12);
}

/**
 * Scale degrees used by the generative music layer. Minor pentatonic keeps
 * every random walk consonant, so the soundtrack never sounds wrong.
 */
const SCALES = {
  minorPentatonic: [0, 3, 5, 7, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
};

const CHORD_PROGRESSIONS = {
  menu: [0, -2, -4, -2],
  cpu: [0, 0, 3, -2],
  memory: [0, 3, 5, 3],
  power: [0, -3, -5, -3],
  gpu: [0, 5, 3, 7],
  nexus: [0, 2, -3, 5],
  reactor: [0, -1, -3, -5],
};

export class AudioEngine {
  constructor(options = {}) {
    this.supported = typeof window !== 'undefined' && Boolean(
      window.AudioContext || window.webkitAudioContext,
    );
    this.context = null;
    this.masterGain = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.compressor = null;
    this.noiseBuffer = null;
    this.musicTimer = null;
    this.musicStep = 0;
    this.musicTheme = 'menu';
    this.musicEnabled = false;
    this.playing = false;
    this.musicVolume = Number.isFinite(options.musicVolume) ? options.musicVolume : 0.5;
    this.sfxVolume = Number.isFinite(options.sfxVolume) ? options.sfxVolume : 0.7;
    this.lastPlayedAt = new Map();
    this.voices = 0;
    this.maxVoices = 24;
    this.unlocked = false;
    this.onUnlock = typeof options.onUnlock === 'function' ? options.onUnlock : null;
  }

  /** Creates or resumes the AudioContext. Must be called from a user gesture. */
  async unlock() {
    if (!this.supported) return false;
    if (!this.context) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      this.context = new Ctor({ latencyHint: 'interactive' });
      this._buildGraph();
    }
    try {
      if (this.context.state === 'suspended') await this.context.resume();
    } catch {
      return false;
    }
    this.unlocked = this.context.state === 'running';
    if (this.unlocked && this.onUnlock) this.onUnlock();
    return this.unlocked;
  }

  _buildGraph() {
    const ctx = this.context;
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.9;

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 22;
    this.compressor.ratio.value = 8;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.22;

    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = this.musicVolume * 0.5;

    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = this.sfxVolume;

    this.musicGain.connect(this.compressor);
    this.sfxGain.connect(this.compressor);
    this.compressor.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);

    // Pink-ish noise buffer reused by every impact and spark sound.
    const seconds = 1.2;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = white * 0.6 + last * 3.2;
    }
    this.noiseBuffer = buffer;
  }

  get ready() {
    return this.unlocked && this.context && this.context.state === 'running';
  }

  setMusicVolume(value) {
    this.musicVolume = Math.max(0, Math.min(1, Number(value) || 0));
    if (this.musicGain) {
      this.musicGain.gain.setTargetAtTime(this.musicVolume * 0.5, this.context.currentTime, 0.05);
    }
  }

  setSfxVolume(value) {
    this.sfxVolume = Math.max(0, Math.min(1, Number(value) || 0));
    if (this.sfxGain) {
      this.sfxGain.gain.setTargetAtTime(this.sfxVolume, this.context.currentTime, 0.05);
    }
  }

  _now() {
    return this.context ? this.context.currentTime : 0;
  }

  _reserveVoice() {
    if (this.voices >= this.maxVoices) return false;
    this.voices += 1;
    return true;
  }

  _releaseVoice() {
    this.voices = Math.max(0, this.voices - 1);
  }

  /**
   * Rate-limits a sound so repeated events cannot stack into a wall of noise.
   * @param {string} name
   * @param {number} minIntervalMs
   */
  _throttle(name, minIntervalMs) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const previous = this.lastPlayedAt.get(name) || -Infinity;
    if (now - previous < minIntervalMs) return false;
    this.lastPlayedAt.set(name, now);
    return true;
  }

  /**
   * Core one-shot synthesiser.
   * @param {object} spec
   */
  _tone(spec) {
    if (!this.ready) return;
    if (!this._reserveVoice()) return;
    const ctx = this.context;
    const start = this._now() + (spec.delay || 0);
    const duration = spec.duration ?? 0.2;
    const destination = spec.bus === 'music' ? this.musicGain : this.sfxGain;

    const osc = ctx.createOscillator();
    osc.type = spec.type || 'sine';
    const from = spec.from ?? 440;
    const to = spec.to ?? from;
    osc.frequency.setValueAtTime(Math.max(20, from), start);
    if (spec.sweep === 'exponential' && to > 0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), start + duration);
    } else if (to !== from) {
      osc.frequency.linearRampToValueAtTime(Math.max(20, to), start + duration);
    }

    const gain = ctx.createGain();
    const peak = spec.gain ?? 0.25;
    const attack = spec.attack ?? 0.005;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(peak, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    let node = osc;
    if (spec.filter) {
      const filter = ctx.createBiquadFilter();
      filter.type = spec.filter.type || 'lowpass';
      filter.frequency.setValueAtTime(spec.filter.frequency ?? 1800, start);
      if (spec.filter.sweepTo) {
        filter.frequency.exponentialRampToValueAtTime(
          Math.max(60, spec.filter.sweepTo),
          start + duration,
        );
      }
      filter.Q.value = spec.filter.q ?? 1;
      node.connect(filter);
      node = filter;
    }
    node.connect(gain);
    gain.connect(destination);

    osc.start(start);
    osc.stop(start + duration + 0.02);
    osc.onended = () => this._releaseVoice();
  }

  /** Filtered noise burst: sparks, impacts, meltdown debris. */
  _noise(spec) {
    if (!this.ready || !this.noiseBuffer) return;
    if (!this._reserveVoice()) return;
    const ctx = this.context;
    const start = this._now() + (spec.delay || 0);
    const duration = spec.duration ?? 0.15;
    const destination = spec.bus === 'music' ? this.musicGain : this.sfxGain;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.playbackRate.value = spec.rate ?? 1;

    const filter = ctx.createBiquadFilter();
    filter.type = spec.filterType || 'bandpass';
    filter.frequency.setValueAtTime(spec.frequency ?? 2400, start);
    if (spec.sweepTo) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(60, spec.sweepTo), start + duration);
    }
    filter.Q.value = spec.q ?? 1.1;

    const gain = ctx.createGain();
    const peak = spec.gain ?? 0.2;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(peak, start + (spec.attack ?? 0.003));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(destination);
    source.start(start);
    source.stop(start + duration + 0.02);
    source.onended = () => this._releaseVoice();
  }

  /* ------------------------------------------------------------------ */
  /* Sound effects                                                      */
  /* ------------------------------------------------------------------ */

  play(name, options = {}) {
    if (!this.ready) return;
    const step = Number(options.step) || 0;
    switch (name) {
      case 'collect': {
        if (!this._throttle('collect', 45)) return;
        const base = 620 + Math.min(6, step) * 70;
        this._tone({
          type: 'triangle',
          from: base,
          to: base * 1.9,
          duration: 0.14,
          gain: 0.2,
          filter: { type: 'lowpass', frequency: 4200, sweepTo: 1400, q: 0.8 },
        });
        this._noise({ frequency: 5200, sweepTo: 2600, duration: 0.07, gain: 0.06, q: 2.4 });
        break;
      }
      case 'magnetCollect': {
        if (!this._throttle('magnetCollect', 60)) return;
        this._tone({ type: 'sawtooth', from: 320, to: 880, duration: 0.12, gain: 0.11, sweep: 'exponential' });
        break;
      }
      case 'powerup': {
        this._tone({ type: 'square', from: 420, to: 1260, duration: 0.34, gain: 0.13, sweep: 'exponential' });
        this._tone({ type: 'sine', from: 660, to: 1980, duration: 0.42, gain: 0.1, sweep: 'exponential', delay: 0.05 });
        break;
      }
      case 'shield': {
        if (!this._throttle('shield', 120)) return;
        this._noise({ filterType: 'bandpass', frequency: 320, sweepTo: 180, duration: 0.34, gain: 0.3, q: 0.7 });
        this._tone({ type: 'square', from: 180, to: 90, duration: 0.3, gain: 0.16 });
        break;
      }
      case 'terminal': {
        this._tone({ type: 'triangle', from: 520, to: 1040, duration: 0.2, gain: 0.16 });
        this._tone({ type: 'sine', from: 1300, duration: 0.26, gain: 0.09, delay: 0.08 });
        break;
      }
      case 'terminalLocked': {
        if (!this._throttle('terminalLocked', 300)) return;
        this._tone({ type: 'square', from: 220, to: 150, duration: 0.16, gain: 0.08 });
        break;
      }
      case 'connect': {
        this._tone({ type: 'triangle', from: 440, to: 880, duration: 0.28, gain: 0.15 });
        this._tone({ type: 'sine', from: 880, to: 1760, duration: 0.34, gain: 0.1, delay: 0.1 });
        break;
      }
      case 'speedRamp': {
        this._tone({ type: 'sawtooth', from: 300, to: 1500, duration: 0.4, gain: 0.11, sweep: 'exponential' });
        break;
      }
      case 'spark': {
        if (!this._throttle('spark', 90)) return;
        this._noise({ frequency: 6400 + Math.random() * 1400, sweepTo: 2000, duration: 0.06, gain: 0.05, q: 3 });
        break;
      }
      case 'hazard': {
        this._tone({ type: 'square', from: 140, to: 70, duration: 0.3, gain: 0.1 });
        this._noise({ frequency: 900, sweepTo: 200, duration: 0.28, gain: 0.12, q: 0.8 });
        break;
      }
      case 'barrierUp': {
        if (!this._throttle('barrierUp', 140)) return;
        this._tone({ type: 'sawtooth', from: 160, to: 420, duration: 0.16, gain: 0.07 });
        break;
      }
      case 'collision': {
        this._noise({ filterType: 'lowpass', frequency: 900, sweepTo: 90, duration: 0.6, gain: 0.42, q: 0.6 });
        this._tone({ type: 'square', from: 200, to: 45, duration: 0.55, gain: 0.22, sweep: 'exponential' });
        this._tone({ type: 'sawtooth', from: 110, to: 28, duration: 0.75, gain: 0.16, sweep: 'exponential', delay: 0.04 });
        break;
      }
      case 'meltdown': {
        this._noise({ filterType: 'lowpass', frequency: 1600, sweepTo: 60, duration: 1.5, gain: 0.36, q: 0.5 });
        this._tone({ type: 'sawtooth', from: 320, to: 30, duration: 1.4, gain: 0.2, sweep: 'exponential' });
        break;
      }
      case 'levelClear': {
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((frequency, index) => {
          this._tone({
            type: 'triangle',
            from: frequency,
            to: frequency,
            duration: 0.42,
            gain: 0.14,
            delay: index * 0.1,
          });
        });
        break;
      }
      case 'levelFail': {
        const notes = [392, 329.63, 261.63, 196];
        notes.forEach((frequency, index) => {
          this._tone({
            type: 'triangle',
            from: frequency,
            to: frequency * 0.98,
            duration: 0.36,
            gain: 0.13,
            delay: index * 0.12,
          });
        });
        break;
      }
      case 'ui': {
        if (!this._throttle('ui', 40)) return;
        this._tone({ type: 'sine', from: 880, to: 1180, duration: 0.07, gain: 0.07 });
        break;
      }
      case 'uiBack': {
        if (!this._throttle('uiBack', 40)) return;
        this._tone({ type: 'sine', from: 700, to: 480, duration: 0.08, gain: 0.07 });
        break;
      }
      case 'achievement': {
        [659.25, 830.61, 987.77, 1318.51].forEach((frequency, index) => {
          this._tone({
            type: 'sine',
            from: frequency,
            duration: 0.5,
            gain: 0.12,
            delay: index * 0.11,
          });
        });
        break;
      }
      default:
        break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Music                                                              */
  /* ------------------------------------------------------------------ */

  startMusic(theme = 'menu') {
    if (!this.ready) return;
    this.musicTheme = CHORD_PROGRESSIONS[theme] ? theme : 'menu';
    if (this.musicEnabled && this.musicTimer) return;
    this.musicEnabled = true;
    this.musicStep = 0;
    this._scheduleMusic();
    this.musicTimer = setInterval(() => this._scheduleMusic(), 400);
  }

  stopMusic() {
    this.musicEnabled = false;
    if (this.musicTimer) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }

  setMusicTheme(theme) {
    if (!CHORD_PROGRESSIONS[theme]) return;
    this.musicTheme = theme;
  }

  _scheduleMusic() {
    if (!this.ready || !this.musicEnabled) return;
    const ctx = this.context;
    const step = this.musicStep;
    const progression = CHORD_PROGRESSIONS[this.musicTheme] || CHORD_PROGRESSIONS.menu;
    const rootOffset = progression[step % progression.length];
    const stepDuration = 0.28;
    const start = this._now() + 0.06;
    const scale = this.musicTheme === 'reactor' || this.musicTheme === 'nexus'
      ? SCALES.minor
      : SCALES.minorPentatonic;
    const baseFrequency = frequencyFor('A', 2) * Math.pow(2, rootOffset / 12);

    // Bass pulse on every other step.
    if (step % 2 === 0) {
      this._tone({
        bus: 'music',
        type: 'sawtooth',
        from: baseFrequency,
        to: baseFrequency * 0.99,
        duration: stepDuration * 1.7,
        gain: 0.2,
        attack: 0.02,
        filter: { type: 'lowpass', frequency: 360, q: 4 },
      });
    }

    // Arpeggio note.
    const degree = scale[(step * 3 + Math.floor(step / 4)) % scale.length];
    const octave = step % 8 < 4 ? 4 : 5;
    const frequency = frequencyFor('A', octave) * Math.pow(2, (degree + rootOffset) / 12);
    this._tone({
      bus: 'music',
      type: step % 4 === 0 ? 'triangle' : 'sine',
      from: frequency,
      to: frequency * 1.005,
      duration: stepDuration * 1.2,
      gain: step % 4 === 0 ? 0.13 : 0.08,
      attack: 0.008,
      filter: { type: 'lowpass', frequency: 2600, q: 0.7 },
    });

    // Occasional high shimmer.
    if (step % 8 === 5) {
      const shimmer = frequencyFor('A', 6) * Math.pow(2, (degree + rootOffset) / 12);
      this._tone({
        bus: 'music',
        type: 'sine',
        from: shimmer,
        to: shimmer * 1.5,
        duration: stepDuration * 2,
        gain: 0.05,
        delay: stepDuration * 0.5,
      });
    }

    // Percussive tick.
    if (step % 2 === 1) {
      this._noise({
        bus: 'music',
        frequency: 8000,
        sweepTo: 4000,
        duration: 0.045,
        gain: 0.035,
        q: 2.2,
        delay: stepDuration * 0.5,
      });
    }

    this.musicStep = (step + 1) % 512;
  }

  /** Suspends all audio, e.g. when the page is hidden. */
  suspend() {
    if (this.context && this.context.state === 'running') {
      this.context.suspend().catch(() => {});
    }
  }

  resume() {
    if (this.context && this.context.state === 'suspended' && this.unlocked) {
      this.context.resume().catch(() => {});
    }
  }

  dispose() {
    this.stopMusic();
    if (this.context) {
      this.context.close().catch(() => {});
      this.context = null;
    }
    this.voices = 0;
  }
}

export { SCALES, CHORD_PROGRESSIONS, frequencyFor };
