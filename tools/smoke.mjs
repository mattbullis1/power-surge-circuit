/**
 * Real-browser smoke test for Power Surge Circuit.
 *
 * Launches headless Chrome/Edge, loads the game, clicks through the menu into a
 * live run, and fails on page exceptions, missing UI, blank canvas, or any
 * visibility bug.
 *
 * Visibility is checked with getComputedStyle(), not just element state: the
 * [hidden] attribute is silently defeated by any CSS rule that sets `display`,
 * so state-only assertions miss invisible overlays. The results banner uses the
 * [hidden] attribute, so it is audited explicitly.
 *
 * Usage:
 *   node tools/smoke.mjs                                  # XAMPP (port 8080)
 *   node tools/smoke.mjs https://mattbullis1.github.io/power-surge-circuit/
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] || 'http://localhost:8080/power-surge-circuit/';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.id = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const handler of this.listeners.get(message.method) || []) handler(message.params);
    });
  }

  static async connect(wsUrl) {
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    const list = this.listeners.get(method) || [];
    list.push(handler);
    this.listeners.set(method, list);
  }
}

async function main() {
  const browserPath = CHROME_CANDIDATES.find((c) => existsSync(c));
  if (!browserPath) throw new Error('No Chrome or Edge executable found');

  const port = await freePort();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'psc-smoke-'));
  const chrome = spawn(browserPath, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--mute-audio',
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--window-size=430,932',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  const errors = [];
  const failedRequests = [];
  let client;
  let failed = false;

  try {
    let ready = false;
    for (let i = 0; i < 120; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) { ready = true; break; }
      } catch { /* still starting */ }
      await wait(150);
    }
    if (!ready) throw new Error('Chrome DevTools endpoint never came up');

    const targetRes = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    const target = await targetRes.json();
    client = await Cdp.connect(target.webSocketDebuggerUrl);

    client.on('Runtime.exceptionThrown', (params) => {
      errors.push(params.exceptionDetails?.exception?.description
        || params.exceptionDetails?.text
        || 'page exception');
    });
    client.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        errors.push(params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });
    client.on('Network.loadingFailed', (params) => {
      failedRequests.push(`${params.type} ${params.errorText}`);
    });

    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Network.enable');

    const evaluate = async (expression) => {
      const res = await client.send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true, userGesture: true,
      });
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
      }
      return res.result.value;
    };

    const waitFor = async (expression, label, timeout = 15000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (await evaluate(expression)) return true;
        await wait(120);
      }
      throw new Error(`Timed out waiting for: ${label}`);
    };

    /**
     * Clicks a selector, but only inside the currently active screen.
     *
     * Every screen carries its own "Back" button, so a bare
     * document.querySelector('[data-back=...]') would return the first match in
     * document order — usually a hidden copy belonging to a different screen.
     * Scoping to .screen.is-active is what makes the click unambiguous.
     */
    const clickVisible = (selector) => evaluate(`(() => {
      const active = document.querySelector('.screen.is-active') || document;
      let target = active.querySelector(${JSON.stringify(selector)});
      if (!target) target = document.querySelector(${JSON.stringify(selector)});
      if (!target) return 'missing';
      const style = getComputedStyle(target);
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05;
      if (!visible) {
        return 'not visible (display:' + style.display + ' visibility:' + style.visibility + ' opacity:' + style.opacity + ')';
      }
      if (target.disabled) return 'disabled';
      target.click();
      return 'ok';
    })()`);

    const steps = [];
    const step = async (label, selector) => {
      const result = await clickVisible(selector);
      if (result !== 'ok') throw new Error(`Could not click ${label} (${selector}): ${result}`);
      steps.push(label);
      await wait(260);
    };

    /** Asserts the expected screen is the active one. */
    const expectScreen = async (id) => {
      const active = await evaluate(`(() => {
        const node = document.querySelector('.screen.is-active');
        return node ? node.id : null;
      })()`);
      if (active !== id) throw new Error(`Expected ${id} to be active, but ${active} is`);
    };

    console.log(`smoke: loading ${url}`);
    await client.send('Page.navigate', { url });
    await waitFor("document.readyState === 'complete'", 'page load');
    await waitFor("document.body.dataset.ready === 'true'", 'app ready (boot() ran)');

    // --- Boot visibility -------------------------------------------------
    //
    // Inactive screens keep `display: flex` so the opacity/transform transition
    // can run; they are removed from interaction with `visibility: hidden` plus
    // `pointer-events: none`. So the meaningful question is not "is display
    // none?" but "is it actually visible, and does it swallow clicks?".
    // Both are checked, including a real hit test at the centre of a menu
    // button to prove no inactive overlay is intercepting input.
    const bootStyles = await evaluate(`(() => {
      const probe = (sel) => {
        const node = document.querySelector(sel);
        if (!node) return { present: false };
        const s = getComputedStyle(node);
        return {
          present: true,
          display: s.display,
          visibility: s.visibility,
          opacity: Number(s.opacity),
          pointerEvents: s.pointerEvents,
          hiddenAttr: node.hasAttribute('hidden'),
        };
      };
      const btn = document.getElementById('menu-endless');
      const r = btn.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        menu: probe('#screen-menu'),
        game: probe('#screen-game'),
        pauseModal: probe('#modal-pause'),
        resultsModal: probe('#modal-results'),
        countdown: probe('#countdown'),
        newBest: probe('#results-newbest'),
        hitTarget: top ? (top.id || top.className || top.tagName) : 'null',
        hitIsMenuButton: top === btn || btn.contains(top),
      };
    })()`);

    const isVisible = (s) =>
      s.present && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity > 0.05;
    const isInteractable = (s) => isVisible(s) && s.pointerEvents !== 'none';

    if (!isVisible(bootStyles.menu)) {
      throw new Error(`Main menu is not visible after boot (visibility: ${bootStyles.menu.visibility})`);
    }
    if (!bootStyles.hitIsMenuButton) {
      throw new Error(`An inactive overlay is intercepting clicks: elementFromPoint returned "${bootStyles.hitTarget}"`);
    }
    for (const [name, probe] of Object.entries({
      'game screen': bootStyles.game,
      'pause modal': bootStyles.pauseModal,
      'results modal': bootStyles.resultsModal,
      countdown: bootStyles.countdown,
    })) {
      if (isVisible(probe)) {
        throw new Error(`${name} should not be visible at boot (opacity: ${probe.opacity}, visibility: ${probe.visibility})`);
      }
      if (isInteractable(probe)) {
        throw new Error(`${name} should not accept input at boot`);
      }
    }
    // The [hidden] attribute must actually suppress the results banner.
    if (bootStyles.newBest.hiddenAttr !== true) {
      throw new Error('[hidden] is missing on the results new-best banner');
    }
    if (isVisible(bootStyles.newBest)) {
      throw new Error('[hidden] is being overridden by CSS on #results-newbest (display: ' + bootStyles.newBest.display + ')');
    }

    // --- Menu navigation -------------------------------------------------
    const screens = [
      ['difficulty', '#menu-difficulty', 'screen-difficulty'],
      ['campaign', '#menu-campaign', 'screen-campaign'],
      ['settings', '#menu-settings', 'screen-settings'],
      ['achievements', '#menu-achievements', 'screen-achievements'],
      ['how to play', '#menu-how', 'screen-how'],
    ];
    for (const [label, button, screenId] of screens) {
      await step(`menu -> ${label}`, button);
      await expectScreen(screenId);
      await step(`${label} -> back`, '[data-back="screen-menu"]');
      await expectScreen('screen-menu');
    }

    const menuData = await evaluate(`(() => ({
      difficulty: document.getElementById('menu-difficulty-value').textContent.trim(),
      campaign: document.getElementById('menu-campaign-progress').textContent.trim(),
      achievements: document.getElementById('menu-achievements-count').textContent.trim(),
    }))()`);
    if (!/^(EASY|NORMAL|HARD)$/.test(menuData.difficulty)) {
      throw new Error(`Difficulty badge is unreadable: "${menuData.difficulty}"`);
    }

    // --- Campaign level select -------------------------------------------
    await step('menu -> campaign (level list)', '#menu-campaign');
    await expectScreen('screen-campaign');
    const campaign = await evaluate(`(() => ({
      chapters: document.querySelectorAll('#campaign-levels .chapter').length,
      levels: document.querySelectorAll('#campaign-levels .level-chip').length,
      locks: document.querySelectorAll('#campaign-levels .level-chip:disabled').length,
      names: Array.from(document.querySelectorAll('#campaign-levels .level-chip .num'))
        .slice(0, 3).map((n) => n.textContent.trim()),
    }))()`);
    if (campaign.chapters !== 6) throw new Error(`Expected 6 chapters, saw ${campaign.chapters}`);
    if (campaign.levels !== 30) throw new Error(`Expected 30 levels, saw ${campaign.levels}`);
    if (campaign.locks !== 29) throw new Error(`Expected 29 locked levels, saw ${campaign.locks}`);
    await step('campaign -> back', '[data-back="screen-menu"]');
    await expectScreen('screen-menu');

    // --- Play a real run --------------------------------------------------
    await step('menu -> start endless', '#menu-endless');
    await waitFor("document.getElementById('screen-game').classList.contains('is-active')", 'game screen active');
    await waitFor("document.getElementById('countdown').classList.contains('is-active')", 'countdown visible');

    const countdownStyle = await evaluate(
      "getComputedStyle(document.getElementById('countdown')).visibility",
    );
    if (countdownStyle === 'hidden') throw new Error('Countdown overlay is visibility:hidden while active');

    // Wait out the countdown and let the surge move.
    await waitFor("window.powerSurge.engine.status === 'running'", 'engine running', 12000);
    await wait(2500);

    const run = await evaluate(`(() => {
      const app = window.powerSurge;
      const r = app.renderer;
      const d = r.ctx.getImageData(0, 0, r.canvas.width, r.canvas.height).data;
      let lit = 0; let n = 0;
      for (let i = 0; i < d.length; i += 4) { n++; if (d[i] + d[i+1] + d[i+2] > 150) lit++; }
      // Effective visibility, not just display: overlays stay display:grid so
      // they can fade, and are removed from view with visibility/opacity.
      const overlayVisible = (sel) => {
        const node = document.querySelector(sel);
        const s = getComputedStyle(node);
        return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05;
      };
      const canvasRect = document.querySelector('.canvas-wrap').getBoundingClientRect();
      const hit = document.elementFromPoint(
        canvasRect.left + canvasRect.width / 2,
        canvasRect.top + canvasRect.height / 2,
      );
      return {
        status: app.engine.status,
        steps: app.engine.steps,
        snake: app.engine.snake.length,
        energy: app.engine.energyNodes.length,
        score: app.engine.score,
        litPct: +((lit / n) * 100).toFixed(1),
        canvasW: r.canvas.width,
        canvasH: r.canvas.height,
        cell: +r.cell.toFixed(2),
        hudScore: document.getElementById('hud-score').textContent.trim(),
        hudSpeed: document.getElementById('hud-speed').textContent.trim(),
        resultsVisible: overlayVisible('#modal-results'),
        pauseVisible: overlayVisible('#modal-pause'),
        countdownVisible: overlayVisible('#countdown'),
        boardReceivesInput: hit ? (hit.id === 'board' || hit.className === 'canvas-wrap') : false,
        hitTarget: hit ? (hit.id || hit.tagName) : 'null',
      };
    })()`);

    if (run.status !== 'running') throw new Error(`Engine is not running (status: ${run.status})`);
    if (run.steps < 5) throw new Error(`Engine barely advanced (${run.steps} steps)`);
    if (run.energy < 1) throw new Error('No energy nodes were placed');
    if (run.canvasW < 100 || run.canvasH < 100) throw new Error(`Canvas is tiny: ${run.canvasW}x${run.canvasH}`);
    if (run.cell < 5) throw new Error(`Grid cell collapsed to ${run.cell}px`);
    if (run.litPct < 15) throw new Error(`Canvas looks blank (${run.litPct}% lit pixels)`);
    if (!/^[\d,]+$/.test(run.hudScore)) throw new Error(`HUD score is unreadable: "${run.hudScore}"`);
    if (!/\/s$/.test(run.hudSpeed)) throw new Error(`HUD speed is unreadable: "${run.hudSpeed}"`);
    if (run.resultsVisible) throw new Error('Results modal is visible during live play');
    if (run.pauseVisible) throw new Error('Pause modal is visible during live play');
    if (run.countdownVisible) throw new Error('Countdown overlay is still visible after the run started');
    if (!run.boardReceivesInput) {
      throw new Error(`The board is not receiving input during play (elementFromPoint: "${run.hitTarget}")`);
    }

    // --- Pause and resume -------------------------------------------------
    await evaluate("window.powerSurge._pauseGame()");
    await wait(300);
    const paused = await evaluate(`(() => ({
      status: window.powerSurge.engine.status,
      modal: getComputedStyle(document.getElementById('modal-pause')).display !== 'none',
    }))()`);
    if (paused.status !== 'paused') throw new Error(`Pause did not take effect (status: ${paused.status})`);
    if (!paused.modal) throw new Error('Pause modal is not visible when paused');

    await step('resume', '#btn-resume');
    await wait(600);
    const resumed = await evaluate("window.powerSurge.engine.status");
    if (resumed !== 'running') throw new Error(`Resume did not take effect (status: ${resumed})`);

    // --- Campaign level 1 boots ------------------------------------------
    await evaluate("window.powerSurge.startCampaign(1)");
    await waitFor("window.powerSurge.engine.mode === 'campaign'", 'campaign mode');
    await wait(4000);
    const level1 = await evaluate(`(() => ({
      level: window.powerSurge.engine.levelNumber,
      chapter: window.powerSurge.engine.level.chapterName,
      objective: window.powerSurge.engine.objective.type,
      status: window.powerSurge.engine.status,
    }))()`);
    if (level1.level !== 1) throw new Error(`Expected level 1, got ${level1.level}`);
    if (level1.objective !== 'collect') throw new Error(`Expected a collect objective, got ${level1.objective}`);
    if (level1.status !== 'running') throw new Error(`Level 1 did not start (status: ${level1.status})`);

    if (errors.length) {
      console.log('page exceptions:');
      for (const error of errors) console.log(`  - ${error}`);
      failed = true;
    }
    if (failedRequests.length) {
      console.log('failed requests:');
      for (const request of failedRequests) console.log(`  - ${request}`);
      failed = true;
    }

    console.log(failed ? 'SMOKE FAIL' : 'SMOKE PASS');
    console.log(`  steps: ${steps.length} clicks (${steps.slice(0, 4).join(' > ')} ...)`);
    console.log(`  menu: difficulty ${menuData.difficulty} | campaign ${menuData.campaign} | achievements ${menuData.achievements}`);
    console.log(`  campaign list: ${campaign.chapters} chapters / ${campaign.levels} levels`);
    console.log(`  endless: ${run.steps} steps, trail ${run.snake}, energy ${run.energy}, score "${run.hudScore}", speed "${run.hudSpeed}"`);
    console.log(`  canvas: ${run.canvasW}x${run.canvasH}, cell ${run.cell}px, ${run.litPct}% lit pixels`);
    console.log(`  level 1: ${level1.chapter} (${level1.objective})`);
    console.log(`  overlays: pause hidden at boot, visible when paused, results hidden while playing, [hidden] respected`);
  } catch (error) {
    console.log('SMOKE FAIL');
    console.log(`  ${error.message}`);
    if (errors.length) {
      console.log('  page exceptions:');
      for (const entry of errors) console.log(`    - ${entry}`);
    }
    if (failedRequests.length) {
      console.log('  failed requests:');
      for (const entry of failedRequests) console.log(`    - ${entry}`);
    }
    failed = true;
  } finally {
    try { client?.socket.close(); } catch { /* ignore */ }
    chrome.kill();
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.log('SMOKE FAIL');
  console.log(`  ${error.message}`);
  process.exitCode = 1;
});
