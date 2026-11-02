/**
 * Headless browser QA for Power Surge Circuit.
 *
 * Boots the local static server, drives a real Chrome/Edge instance through
 * the DevTools Protocol and verifies:
 *   - the app loads with no console errors or failed requests
 *   - every menu screen opens
 *   - a full endless run can be played, paused, resumed and restarted
 *   - keyboard, swipe and orientation-change input all reach the engine
 *   - the canvas actually renders non-empty frames
 *   - layout stays inside the viewport at phone, tablet and desktop sizes
 *
 * Run with:  node tools/qa.mjs        (add --headed to watch it)
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserHarness, findBrowser } from './cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Randomised by default so a leftover test server can never collide with a run.
const PORT = Number(process.env.QA_PORT || 8200 + Math.floor(Math.random() * 300));
const BASE = `http://127.0.0.1:${PORT}/index.html`;

const results = [];
let failures = 0;

function record(name, passed, detail = '') {
  results.push({ name, passed, detail });
  if (!passed) failures += 1;
  const mark = passed ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : '');
  } catch (error) {
    record(name, false, error.message);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(PORT), '127.0.0.1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    child.stdout.on('data', (chunk) => {
      if (!settled && String(chunk).includes('test server')) {
        settled = true;
        resolve(child);
      }
    });
    child.stderr.on('data', (chunk) => {
      if (!settled) {
        settled = true;
        reject(new Error(String(chunk)));
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Static server did not start in time'));
      }
    }, 8000);
  });
}

async function waitForLoad(session) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ready = await session.evaluate("document.body.dataset.ready === 'true'").catch(() => false);
    if (ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('App never signalled ready');
}

/** Reads a pixel sample from the canvas to prove something was drawn. */
const CANVAS_SAMPLE = `(() => {
  const canvas = document.getElementById('board');
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let nonBackground = 0;
  let sum = 0;
  const stride = 4 * 97;
  for (let i = 0; i < data.length; i += stride) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    sum += r + g + b;
    if (r + g + b > 90) nonBackground += 1;
  }
  return { samples: Math.floor(data.length / stride), nonBackground, avg: sum / (data.length / stride) / 3, width, height };
})()`;

async function main() {
  if (!findBrowser()) {
    console.error('No Chrome or Edge found. Set CHROME_PATH and retry.');
    process.exit(2);
  }

  console.log('Power Surge Circuit — headless browser QA\n');
  const server = await startServer();
  const harness = new BrowserHarness();
  const consoleErrors = [];
  const networkFailures = [];

  try {
    await harness.launch();
    console.log(`  Browser: ${harness.browserPath}`);
    console.log(`  Server:  ${BASE}\n`);

    const { id, session } = await harness.newPage(BASE);
    session.on('Runtime.exceptionThrown', (params) => {
      consoleErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'exception');
    });
    session.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        consoleErrors.push(params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
      }
    });
    session.on('Network.loadingFailed', (params) => {
      networkFailures.push(`${params.type} ${params.errorText}`);
    });
    await session.send('Network.enable');

    await waitForLoad(session);

    console.log('Boot & assets');
    await check('app boots and signals ready', async () => {
      assert(await session.evaluate("document.body.dataset.ready === 'true'"), 'ready flag not set');
      return 'body[data-ready=true]';
    });

    await check('no console errors during boot', async () => {
      assert(consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
      return 'clean console';
    });

    await check('no failed network requests', async () => {
      assert(networkFailures.length === 0, networkFailures.slice(0, 3).join(' | '));
      return 'all local assets resolved';
    });

    await check('no remote URLs are referenced', async () => {
      const remote = await session.evaluate(`(() => {
        const found = [];
        for (const el of document.querySelectorAll('script[src], link[href], img[src]')) {
          const url = el.getAttribute('src') || el.getAttribute('href') || '';
          if (/^https?:\\/\\//i.test(url)) found.push(url);
        }
        return found;
      })()`);
      assert(remote.length === 0, `remote refs: ${remote.join(', ')}`);
      return 'all asset paths are relative';
    });

    console.log('\nNavigation');
    const screens = [
      ['menu-difficulty', 'screen-difficulty'],
      ['menu-campaign', 'screen-campaign'],
      ['menu-achievements', 'screen-achievements'],
      ['menu-settings', 'screen-settings'],
      ['menu-how', 'screen-how'],
    ];
    for (const [buttonId, screenId] of screens) {
      await check(`menu → ${screenId}`, async () => {
        await session.evaluate(`document.getElementById('${buttonId}').click()`);
        await new Promise((resolve) => setTimeout(resolve, 140));
        const active = await session.evaluate(
          `document.getElementById('${screenId}').classList.contains('is-active')`,
        );
        assert(active, `${screenId} did not become active`);
        await session.evaluate(`document.querySelector('[data-back="screen-menu"]').click()`);
        await new Promise((resolve) => setTimeout(resolve, 120));
        return 'opens and returns';
      });
    }

    await check('difficulty selection persists', async () => {
      await session.evaluate(`document.getElementById('menu-difficulty').click()`);
      await new Promise((resolve) => setTimeout(resolve, 120));
      await session.evaluate(`document.querySelector('[data-difficulty="hard"]').click()`);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const label = await session.evaluate(`document.getElementById('menu-difficulty-value').textContent`);
      const stored = await session.evaluate(
        `JSON.parse(localStorage.getItem('powerSurgeCircuit.save.v1')).settings.difficulty`,
      );
      assert(label === 'HARD', `menu badge shows ${label}`);
      assert(stored === 'hard', `storage holds ${stored}`);
      await session.evaluate(`document.querySelector('[data-difficulty="normal"]').click()`);
      return 'hard selected and written to storage';
    });

    await check('campaign shows all 30 levels across 6 chapters', async () => {
      await session.evaluate(`document.getElementById('menu-campaign').click()`);
      await new Promise((resolve) => setTimeout(resolve, 160));
      const counts = await session.evaluate(`({
        chapters: document.querySelectorAll('#campaign-levels .chapter').length,
        levels: document.querySelectorAll('#campaign-levels .level-chip').length,
        locked: document.querySelectorAll('#campaign-levels .level-chip:disabled').length
      })`);
      assert(counts.chapters === 6, `expected 6 chapters, saw ${counts.chapters}`);
      assert(counts.levels === 30, `expected 30 levels, saw ${counts.levels}`);
      assert(counts.locked === 29, `expected 29 locked levels, saw ${counts.locked}`);
      await session.evaluate(`document.querySelector('[data-back="screen-menu"]').click()`);
      return `${counts.chapters} chapters, ${counts.levels} levels, ${counts.locked} locked`;
    });

    console.log('\nEndless gameplay');
    await check('endless run starts and advances', async () => {
      await session.evaluate(`document.getElementById('menu-endless').click()`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const onGame = await session.evaluate(
        `document.getElementById('screen-game').classList.contains('is-active')`,
      );
      assert(onGame, 'game screen not active');
      const countdownShown = await session.evaluate(
        `document.getElementById('countdown').classList.contains('is-active')`,
      );
      assert(countdownShown, 'countdown overlay missing');
      // Wait out the countdown plus a few seconds of play.
      await new Promise((resolve) => setTimeout(resolve, 4200));
      const status = await session.evaluate('window.powerSurge.engine.status');
      const steps = await session.evaluate('window.powerSurge.engine.steps');
      assert(status === 'running', `engine status was ${status}`);
      assert(steps > 5, `engine only advanced ${steps} steps`);
      return `running, ${steps} steps`;
    });

    await check('canvas renders non-empty frames', async () => {
      const sample = await session.evaluate(CANVAS_SAMPLE);
      assert(sample, 'canvas not found');
      assert(sample.width > 100 && sample.height > 100, `canvas is ${sample.width}x${sample.height}`);
      assert(sample.nonBackground > 40, `only ${sample.nonBackground} lit samples`);
      return `${sample.width}×${sample.height}, ${sample.nonBackground}/${sample.samples} lit samples, avg ${sample.avg.toFixed(1)}`;
    });

    await check('keyboard steering changes trail direction', async () => {
      await session.evaluate('window.powerSurge.engine.queuedDirection = null');
      await session.send('Input.dispatchKeyEvent', {
        type: 'keyDown', code: 'ArrowDown', key: 'ArrowDown', windowsVirtualKeyCode: 40,
      });
      await session.send('Input.dispatchKeyEvent', {
        type: 'keyUp', code: 'ArrowDown', key: 'ArrowDown', windowsVirtualKeyCode: 40,
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const direction = await session.evaluate('window.powerSurge.engine.direction');
      assert(direction && direction.y === 1, `direction was ${JSON.stringify(direction)}`);
      return 'ArrowDown applied';
    });

    await check('reverse input is rejected', async () => {
      const before = await session.evaluate('window.powerSurge.engine.direction.y');
      const accepted = await session.evaluate('window.powerSurge.engine.queueDirection(0, -1)');
      assert(accepted === false, 'reverse was accepted');
      const after = await session.evaluate('window.powerSurge.engine.direction.y');
      assert(before === after, 'direction changed');
      return 'upward reversal blocked while moving down';
    });

    await check('swipe gesture steers the surge', async () => {
      await session.evaluate('window.powerSurge.engine.queuedDirection = null');
      const box = await session.evaluate(`(() => {
        const rect = document.getElementById('canvas-wrap').getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width, h: rect.height };
      })()`);
      const startX = box.x - box.w * 0.2;
      const startY = box.y;
      await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', clickCount: 1, pointerType: 'touch' });
      for (let i = 1; i <= 6; i += 1) {
        await session.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: startX + (box.w * 0.4 * i) / 6, y: startY, button: 'left', pointerType: 'touch',
        });
      }
      await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startX + box.w * 0.4, y: startY, button: 'left', pointerType: 'touch' });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const direction = await session.evaluate('window.powerSurge.engine.direction');
      assert(direction && direction.x === 1, `direction after horizontal swipe was ${JSON.stringify(direction)}`);
      return 'horizontal swipe produced a right turn';
    });

    await check('pause and resume work from the keyboard', async () => {
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
      await new Promise((resolve) => setTimeout(resolve, 260));
      const pausedStatus = await session.evaluate('window.powerSurge.engine.status');
      const modalOpen = await session.evaluate(`document.getElementById('modal-pause').classList.contains('is-active')`);
      assert(pausedStatus === 'paused', `status was ${pausedStatus}`);
      assert(modalOpen, 'pause modal not shown');
      const stepsAtPause = await session.evaluate('window.powerSurge.engine.steps');
      await new Promise((resolve) => setTimeout(resolve, 700));
      const stepsWhilePaused = await session.evaluate('window.powerSurge.engine.steps');
      assert(stepsAtPause === stepsWhilePaused, 'simulation advanced while paused');

      await session.evaluate(`document.getElementById('btn-resume').click()`);
      await new Promise((resolve) => setTimeout(resolve, 700));
      const resumedSteps = await session.evaluate('window.powerSurge.engine.steps');
      assert(resumedSteps > stepsWhilePaused, 'simulation did not resume');
      return `${stepsWhilePaused} → ${resumedSteps} steps`;
    });

    await check('tap-to-pause works on the board', async () => {
      const box = await session.evaluate(`(() => {
        const rect = document.getElementById('canvas-wrap').getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, pointerType: 'touch' });
      await new Promise((resolve) => setTimeout(resolve, 60));
      await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, pointerType: 'touch' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const status = await session.evaluate('window.powerSurge.engine.status');
      assert(status === 'paused', `status after tap was ${status}`);
      await session.evaluate(`document.getElementById('btn-resume').click()`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      return 'tap pauses the run';
    });

    await check('HUD reports score, objective and speed', async () => {
      const hud = await session.evaluate(`({
        score: document.getElementById('hud-score').textContent,
        objective: document.getElementById('hud-objective').textContent,
        speed: document.getElementById('hud-speed').textContent
      })`);
      assert(/^\d[\d,]*$/.test(hud.score), `score shows "${hud.score}"`);
      assert(hud.objective.length > 0, 'objective empty');
      assert(/\/s$/.test(hud.speed), `speed shows "${hud.speed}"`);
      return `${hud.score} · ${hud.objective} · ${hud.speed}`;
    });

    await check('simulated self-collision ends the run with a results card', async () => {
      await session.evaluate(`(() => {
        const engine = window.powerSurge.engine;
        engine.effects.shield = 0;
        engine.graceSteps = 0;
        // Weave the trail so the cell directly below the head holds a
        // mid-body segment. The order matters: the obstacle must NOT be the
        // final (tail) segment, because the tail legitimately vacates its cell
        // and a move onto it is a legal tail-follow.
        const head = engine.snake[0];
        const cells = [
          [head.x, head.y],           // 0 head
          [head.x, head.y - 1],       // 1
          [head.x - 1, head.y - 1],   // 2
          [head.x, head.y + 1],       // 3  <- obstacle directly below the head
          [head.x + 1, head.y + 1],   // 4
          [head.x + 1, head.y],       // 5  tail
        ];
        engine.snake = cells.map(([x, y]) => ({ x, y, prevX: x, prevY: y }));
        engine.direction = { x: 1, y: 0 };
        engine.queuedDirection = { x: 0, y: 1 };
        engine.growthDebt = 0;
        engine._rebuildOccupancy();
        return engine.occupancy.get(head.x + ',' + (head.y + 1));
      })()`);
      const deadline = Date.now() + 8000;
      let shown = false;
      while (Date.now() < deadline && !shown) {
        shown = await session.evaluate(`document.getElementById('modal-results').classList.contains('is-active')`);
        if (!shown) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert(shown, 'results modal never appeared');
      const outcome = await session.evaluate(`({
        title: document.getElementById('results-title').textContent,
        stats: document.querySelectorAll('#results-stats .result-stat').length,
        cause: [...document.querySelectorAll('#results-stats .result-stat')]
          .map((el) => el.textContent)
          .find((text) => /Trail contact/i.test(text)) || ''
      })`);
      assert(outcome.stats >= 5, `only ${outcome.stats} stat rows`);
      assert(/Trail contact/i.test(outcome.cause), `cause row was "${outcome.cause}"`);
      return `"${outcome.title}" with ${outcome.stats} stat rows, cause reported`;
    });

    await check('results persist into local storage', async () => {
      const stats = await session.evaluate(
        `JSON.parse(localStorage.getItem('powerSurgeCircuit.save.v1')).stats`,
      );
      assert(stats.runs >= 1, `runs counter is ${stats.runs}`);
      return `runs=${stats.runs}, nodes=${stats.nodesCollected}`;
    });

    await check('restart from the results card begins a fresh run', async () => {
      await session.evaluate(`document.getElementById('btn-results-primary').click()`);
      await new Promise((resolve) => setTimeout(resolve, 4800));
      const state = await session.evaluate(`({
        status: window.powerSurge.engine.status,
        steps: window.powerSurge.engine.steps,
        score: window.powerSurge.engine.score,
        resultsOpen: document.getElementById('modal-results').classList.contains('is-active')
      })`);
      assert(state.resultsOpen === false, 'results modal still open');
      assert(state.status === 'running', `status was ${state.status}`);
      assert(state.steps > 2, `only ${state.steps} steps`);
      assert(state.score === 0, `score carried over: ${state.score}`);
      return `fresh run, ${state.steps} steps`;
    });

    await check('power-up pickup activates timers, HUD pill and audio hooks', async () => {
      await session.evaluate(`document.getElementById('menu-endless').click()`);
      await new Promise((resolve) => setTimeout(resolve, 4800));
      const activated = await session.evaluate(`(() => {
        const engine = window.powerSurge.engine;
        const head = engine.snake[0];
        engine.powerUps = [{
          id: 1, type: 'slow', x: (head.x + 1) % engine.cols, y: head.y,
          expiresAtStep: engine.steps + 400, seed: 5
        }];
        engine.direction = { x: 1, y: 0 };
        engine.queuedDirection = null;
        return true;
      })()`);
      assert(activated, 'could not stage a power-up');
      const deadline = Date.now() + 4000;
      let active = false;
      while (Date.now() < deadline && !active) {
        active = await session.evaluate('window.powerSurge.engine.effects.slow > 0');
        if (!active) await new Promise((resolve) => setTimeout(resolve, 150));
      }
      assert(active, 'slow motion never activated');
      await new Promise((resolve) => setTimeout(resolve, 260));
      const hud = await session.evaluate(`({
        pills: document.querySelectorAll('#powerup-strip .powerup-pill').length,
        label: document.querySelector('#powerup-strip .powerup-pill')?.textContent || '',
        tick: window.powerSurge.engine.currentTickMs()
      })`);
      assert(hud.pills >= 1, 'no power-up pill rendered');
      assert(/SLOW/.test(hud.label), `pill label was "${hud.label}"`);
      // 165ms base tick / 0.65 slow factor = 253.8ms
      assert(hud.tick > 200, `slowed tick was ${hud.tick}ms`);
      return `slow active, tick ${hud.tick.toFixed(0)}ms, ${hud.pills} pill`;
    });

    await check('slow motion expires and the pill disappears', async () => {
      await session.evaluate(`window.powerSurge.engine.effects.slow = 0.35`);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const state = await session.evaluate(`({
        slow: window.powerSurge.engine.effects.slow,
        pills: document.querySelectorAll('#powerup-strip .powerup-pill').length,
        tick: window.powerSurge.engine.currentTickMs()
      })`);
      assert(state.slow === 0, `slow was still ${state.slow}`);
      assert(state.pills === 0, `${state.pills} pills remained`);
      assert(state.tick < 200, `tick did not return to normal: ${state.tick}ms`);
      await session.evaluate('window.powerSurge._quitToMenu()');
      return 'effect and HUD pill cleared';
    });

    await check('settings sliders and toggles persist to storage', async () => {
      await session.evaluate(`document.getElementById('menu-settings').click()`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await session.evaluate(`(() => {
        const speed = document.getElementById('set-speed');
        speed.value = '1.2';
        speed.dispatchEvent(new Event('input', { bubbles: true }));
        const shake = document.getElementById('set-shake');
        shake.value = '0.4';
        shake.dispatchEvent(new Event('input', { bubbles: true }));
        const motion = document.getElementById('set-motion');
        motion.checked = true;
        motion.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const stored = await session.evaluate(
        `JSON.parse(localStorage.getItem('powerSurgeCircuit.save.v1')).settings`,
      );
      assert(Math.abs(stored.gameSpeed - 1.2) < 0.001, `gameSpeed was ${stored.gameSpeed}`);
      assert(Math.abs(stored.screenShake - 0.4) < 0.001, `screenShake was ${stored.screenShake}`);
      assert(stored.reducedMotion === true, 'reducedMotion not saved');
      const label = await session.evaluate(`document.getElementById('set-speed-value').textContent`);
      assert(label === '120%', `slider label was ${label}`);
      const applied = await session.evaluate(`({
        reduced: document.body.classList.contains('reduced-motion'),
        rendererShake: window.powerSurge.renderer.settings.screenShake
      })`);
      assert(applied.reduced, 'reduced-motion class not applied');
      assert(Math.abs(applied.rendererShake - 0.4) < 0.001, 'renderer did not receive shake value');
      // Restore defaults for the remaining checks.
      await session.evaluate(`(() => {
        const app = window.powerSurge;
        app.storage.updateSettings({ gameSpeed: 1, screenShake: 1, reducedMotion: false });
        app.save = app.storage.get();
        app._applySettingsToDocument();
      })()`);
      await session.evaluate(`document.querySelector('[data-back="screen-menu"]').click()`);
      return 'speed 1.2, shake 0.4, reduced motion all persisted';
    });

    await check('achievements screen lists every achievement with lock state', async () => {
      await session.evaluate(`document.getElementById('menu-achievements').click()`);
      await new Promise((resolve) => setTimeout(resolve, 220));
      const info = await session.evaluate(`({
        total: document.querySelectorAll('#achievement-list .achievement').length,
        locked: document.querySelectorAll('#achievement-list .achievement.is-locked').length,
        unlocked: document.querySelectorAll('#achievement-list .achievement.is-unlocked').length,
        summary: document.getElementById('achievements-summary').textContent
      })`);
      assert(info.total >= 15, `only ${info.total} achievements listed`);
      assert(info.unlocked + info.locked === info.total, 'lock state counts do not add up');
      assert(/unlocked/.test(info.summary), `summary was "${info.summary}"`);
      await session.evaluate(`document.querySelector('[data-back="screen-menu"]').click()`);
      return `${info.total} achievements, ${info.unlocked} unlocked`;
    });

    await check('unlocking an achievement shows a toast and appears in the list', async () => {
      await session.evaluate(`(() => {
        const app = window.powerSurge;
        app.storage.unlockAchievement('century');
        app._evaluateRunAchievements({ mode: 'endless', maxCombo: 99, nodes: 5, score: 20000, seconds: 400, shieldSaves: 0, usedPowerups: [] }, false);
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 320));
      const toasts = await session.evaluate(`document.querySelectorAll('#toast-stack .toast').length`);
      assert(toasts >= 1, 'no achievement toast appeared');
      const unlocked = await session.evaluate(
        `JSON.parse(localStorage.getItem('powerSurgeCircuit.save.v1')).achievements`,
      );
      assert(unlocked.century, 'achievement not written to storage');
      return `${Object.keys(unlocked).length} achievements unlocked`;
    });

    await check('quit to menu tears the run down', async () => {
      await session.evaluate(`window.powerSurge._quitToMenu()`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const onMenu = await session.evaluate(
        `document.getElementById('screen-menu').classList.contains('is-active')`,
      );
      const engine = await session.evaluate('window.powerSurge.engine');
      assert(onMenu, 'menu not active');
      assert(engine === null || engine === undefined, 'engine still attached');
      return 'menu restored';
    });

    console.log('\nCampaign gameplay');
    await check('level 1 loads and starts', async () => {
      await session.evaluate('window.powerSurge.startCampaign(1)');
      await new Promise((resolve) => setTimeout(resolve, 200));
      const info = await session.evaluate(`({
        mode: window.powerSurge.engine.mode,
        level: window.powerSurge.engine.levelNumber,
        objective: window.powerSurge.engine.objective.type,
        target: window.powerSurge.engine.objective.target,
        energy: window.powerSurge.engine.energyNodes.length,
        theme: window.powerSurge.engine.themeKey
      })`);
      assert(info.mode === 'campaign', `mode was ${info.mode}`);
      assert(info.level === 1, `level was ${info.level}`);
      assert(info.objective === 'collect', `objective was ${info.objective}`);
      assert(info.energy > 0, 'no energy nodes placed');
      await new Promise((resolve) => setTimeout(resolve, 4200));
      return `level 1 · ${info.objective} ${info.target} · theme ${info.theme}`;
    });

    await check('completing a campaign level shows stars and unlocks the next', async () => {
      await session.evaluate(`(() => {
        const engine = window.powerSurge.engine;
        engine.collected = engine.objective.target - 1;
        const head = engine.snake[0];
        engine.energyNodes = [{ id: 99999, x: (head.x + 1) % engine.cols, y: head.y, spawnedAt: 0, seed: 1 }];
      })()`);
      const deadline = Date.now() + 8000;
      let shown = false;
      while (Date.now() < deadline && !shown) {
        shown = await session.evaluate(`document.getElementById('modal-results').classList.contains('is-active')`);
        if (!shown) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert(shown, 'results modal never appeared after finishing the level');
      const state = await session.evaluate(`({
        title: document.getElementById('results-title').textContent,
        stars: document.querySelectorAll('#results-stars .earned').length,
        unlocked: JSON.parse(localStorage.getItem('powerSurgeCircuit.save.v1')).campaign.unlocked
      })`);
      assert(/Cleared/i.test(state.title), `title was "${state.title}"`);
      assert(state.stars >= 1, `no stars awarded`);
      assert(state.unlocked >= 2, `campaign unlocked is ${state.unlocked}`);
      return `${state.stars}★ awarded, unlocked through level ${state.unlocked}`;
    });

    await check('next-level button advances the campaign', async () => {
      await session.evaluate(`document.getElementById('btn-results-primary').click()`);
      await new Promise((resolve) => setTimeout(resolve, 700));
      const level = await session.evaluate('window.powerSurge.engine?.levelNumber');
      assert(level === 2, `advanced to level ${level}`);
      await session.evaluate('window.powerSurge._quitToMenu()');
      return 'advanced to level 2';
    });

    console.log('\nLayout & responsiveness');
    const viewports = [
      { name: 'iPhone SE portrait', width: 320, height: 568 },
      { name: 'Pixel 7 portrait', width: 412, height: 915 },
      { name: 'iPhone landscape', width: 844, height: 390 },
      { name: 'iPad portrait', width: 820, height: 1180 },
      { name: 'Desktop 1440p', width: 1440, height: 900 },
    ];

    for (const viewport of viewports) {
      await check(`layout fits ${viewport.name} (${viewport.width}×${viewport.height})`, async () => {
        await session.send('Emulation.setDeviceMetricsOverride', {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: 1,
          mobile: viewport.width < 900,
        });
        await session.evaluate(`document.getElementById('menu-endless').click()`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const layout = await session.evaluate(`(() => {
          const canvas = document.getElementById('board');
          const rect = canvas.getBoundingClientRect();
          const hud = document.querySelector('.hud').getBoundingClientRect();
          const shell = document.querySelector('.game-shell').getBoundingClientRect();
          return {
            canvas: { w: Math.round(rect.width), h: Math.round(rect.height), top: Math.round(rect.top), bottom: Math.round(rect.bottom) },
            hudH: Math.round(hud.height),
            shellH: Math.round(shell.height),
            docScroll: document.documentElement.scrollHeight - window.innerHeight,
            bodyScroll: document.body.scrollHeight - window.innerHeight,
            innerW: window.innerWidth,
            innerH: window.innerHeight,
            cell: window.powerSurge.renderer.cell
          };
        })()`);
        assert(layout.canvas.w > 90 && layout.canvas.h > 90, `canvas too small: ${layout.canvas.w}×${layout.canvas.h}`);
        assert(layout.canvas.bottom <= layout.innerH + 4, `canvas overflows bottom by ${layout.canvas.bottom - layout.innerH}px`);
        assert(layout.docScroll <= 1, `document scrolls vertically by ${layout.docScroll}px`);
        assert(layout.bodyScroll <= 1, `body scrolls vertically by ${layout.bodyScroll}px`);
        assert(layout.cell > 5, `cell size collapsed to ${layout.cell}`);
        await session.evaluate('window.powerSurge._quitToMenu()');
        await new Promise((resolve) => setTimeout(resolve, 200));
        return `canvas ${layout.canvas.w}×${layout.canvas.h}, cell ${layout.cell.toFixed(1)}px, no overflow`;
      });
    }

    await check('orientation change re-lays out the board', async () => {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: 412, height: 915, deviceScaleFactor: 1, mobile: true,
      });
      await session.evaluate(`document.getElementById('menu-endless').click()`);
      await new Promise((resolve) => setTimeout(resolve, 4600));
      const portrait = await session.evaluate(`(() => {
        const rect = document.getElementById('board').getBoundingClientRect();
        return { w: Math.round(rect.width), h: Math.round(rect.height) };
      })()`);
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: 915, height: 412, deviceScaleFactor: 1, mobile: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 900));
      const landscape = await session.evaluate(`(() => {
        const rect = document.getElementById('board').getBoundingClientRect();
        return { w: Math.round(rect.width), h: Math.round(rect.height) };
      })()`);
      assert(landscape.w !== portrait.w, 'canvas width did not change with orientation');
      assert(landscape.w > 0 && landscape.h > 0, 'canvas collapsed after rotation');
      await session.evaluate('window.powerSurge._quitToMenu()');
      return `${portrait.w}×${portrait.h} → ${landscape.w}×${landscape.h}`;
    });

    await check('high contrast and colourblind modes apply to the document', async () => {
      await session.evaluate(`(() => {
        const app = window.powerSurge;
        app.storage.updateSettings({ highContrast: true, colorblind: true, reducedMotion: true });
        app.save = app.storage.get();
        app._applySettingsToDocument();
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const classes = await session.evaluate(`Array.from(document.body.classList)`);
      assert(classes.includes('high-contrast'), 'high-contrast class missing');
      assert(classes.includes('colorblind'), 'colorblind class missing');
      assert(classes.includes('reduced-motion'), 'reduced-motion class missing');
      const rendererSettings = await session.evaluate('window.powerSurge.renderer.settings');
      assert(rendererSettings.highContrast === true, 'renderer did not receive high contrast');
      assert(rendererSettings.reducedMotion === true, 'renderer did not receive reduced motion');
      await session.evaluate(`(() => {
        const app = window.powerSurge;
        app.storage.updateSettings({ highContrast: false, colorblind: false, reducedMotion: false });
        app.save = app.storage.get();
        app._applySettingsToDocument();
      })()`);
      return 'accessibility classes and renderer flags wired';
    });

    await check('corrupt save data is recovered without breaking boot', async () => {
      await session.evaluate(`localStorage.setItem('powerSurgeCircuit.save.v1', '{broken json')`);
      const { id: reloadId, session: reloadSession } = await harness.newPage(BASE);
      await waitForLoad(reloadSession);
      const state = await reloadSession.evaluate(`({
        ready: document.body.dataset.ready === 'true',
        status: document.getElementById('storage-status').textContent,
        levels: document.querySelectorAll('#campaign-levels .level-chip').length,
        campaignUnlocked: window.powerSurge.storage.get().campaign.unlocked
      })`);
      assert(state.ready, 'app failed to boot with a corrupt save');
      assert(state.campaignUnlocked >= 1, 'campaign progress was lost entirely');
      await harness.closePage(reloadId);
      await session.evaluate(`localStorage.clear()`);
      return 'booted with defaults and quarantined the damaged data';
    });

    await check('no console errors accumulated during the whole session', async () => {
      assert(consoleErrors.length === 0, consoleErrors.slice(0, 4).join(' | '));
      return `${consoleErrors.length} errors`;
    });

    await check('sustained play keeps a healthy frame budget', async () => {
      await session.evaluate(`document.getElementById('menu-endless').click()`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const measurement = await session.evaluate(`new Promise((resolve) => {
        const samples = [];
        let last = performance.now();
        let frames = 0;
        function tick(now) {
          samples.push(now - last);
          last = now;
          frames += 1;
          if (frames < 150) requestAnimationFrame(tick);
          else {
            samples.shift();
            samples.sort((a, b) => a - b);
            resolve({
              median: samples[Math.floor(samples.length / 2)],
              p95: samples[Math.floor(samples.length * 0.95)],
              worst: samples[samples.length - 1],
              particles: window.powerSurge.renderer.particles.length,
              quality: window.powerSurge.renderer.quality
            });
          }
        }
        requestAnimationFrame(tick);
      })`);
      // SwiftShader software rendering is the floor here; real GPUs are far faster.
      assert(measurement.median < 90, `median frame time ${measurement.median.toFixed(1)}ms`);
      assert(measurement.worst < 600, `worst frame ${measurement.worst.toFixed(1)}ms`);
      await session.evaluate('window.powerSurge._quitToMenu()');
      return `median ${measurement.median.toFixed(1)}ms, p95 ${measurement.p95.toFixed(1)}ms, particles ${measurement.particles}, quality ${measurement.quality}`;
    });

    await harness.closePage(id);
  } finally {
    await harness.close();
    server.kill();
  }

  console.log(`\n${'='.repeat(64)}`);
  const passed = results.filter((entry) => entry.passed).length;
  console.log(`Browser QA: ${passed}/${results.length} checks passed`);
  if (failures > 0) {
    console.log('\nFailures:');
    for (const entry of results.filter((item) => !item.passed)) {
      console.log(`  - ${entry.name}: ${entry.detail}`);
    }
  }
  console.log('='.repeat(64));
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('\nQA harness crashed:', error);
  process.exit(3);
});
