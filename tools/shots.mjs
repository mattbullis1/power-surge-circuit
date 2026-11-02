/**
 * Visual capture helper. Renders key screens to PNG so the artwork can be
 * reviewed without a manual browser session.
 *
 * Run with:  node tools/shots.mjs [outputDir]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserHarness } from './cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'screenshots'));
const PORT = Number(process.env.SHOT_PORT || 8611);
const BASE = `http://127.0.0.1:${PORT}/index.html`;

fs.mkdirSync(outDir, { recursive: true });

const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(PORT), '127.0.0.1'], {
  stdio: 'ignore',
  windowsHide: true,
});
await new Promise((resolve) => setTimeout(resolve, 1300));

const harness = new BrowserHarness();
await harness.launch();
const { id, session } = await harness.newPage(BASE);
await new Promise((resolve) => setTimeout(resolve, 2500));

async function shoot(name) {
  const result = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  console.log(`  saved ${path.relative(root, file)}`);
}

async function setViewport(width, height, mobile) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
  await new Promise((resolve) => setTimeout(resolve, 420));
}

await setViewport(412, 915, true);
await shoot('01-menu-phone');

await session.evaluate(`document.getElementById('menu-campaign').click()`);
await new Promise((resolve) => setTimeout(resolve, 420));
await shoot('02-campaign-phone');

await session.evaluate(`document.querySelector('[data-back="screen-menu"]').click()`);
await session.evaluate(`document.getElementById('menu-settings').click()`);
await new Promise((resolve) => setTimeout(resolve, 420));
await shoot('03-settings-phone');

await session.evaluate(`document.querySelector('[data-back="screen-menu"]').click()`);
await session.evaluate(`document.getElementById('menu-achievements').click()`);
await new Promise((resolve) => setTimeout(resolve, 420));
await shoot('04-achievements-phone');

// Endless gameplay on a phone.
await session.evaluate(`document.querySelector('[data-back="screen-menu"]').click()`);
await new Promise((resolve) => setTimeout(resolve, 260));
await session.evaluate(`document.getElementById('menu-endless').click()`);
await new Promise((resolve) => setTimeout(resolve, 500));
await shoot('05-countdown-phone');
await new Promise((resolve) => setTimeout(resolve, 4200));
await shoot('06-endless-phone');

// Stage a rich play state: longer trail, power-ups active, sparks flying.
await session.evaluate(`(() => {
  const app = window.powerSurge;
  const engine = app.engine;
  const head = engine.snake[0];
  const cells = [];
  let x = head.x;
  let y = head.y;
  for (let i = 0; i < 26; i += 1) {
    cells.push({ x, y, prevX: x, prevY: y });
    if (i % 5 === 4) y = (y + 1) % engine.rows;
    else x = (x + 1) % engine.cols;
  }
  engine.snake = cells;
  engine._rebuildOccupancy();
  engine.score = 18450;
  engine.collected = 41;
  engine.streak = 7;
  engine.speedTier = 5;
  engine.themeKey = 'gpu';
  app.renderer.setTheme('gpu');
  engine.effects = { slow: 5.2, double: 8.4, magnet: 6.1, shield: 1 };
  engine.elapsed = 96;
  const target = engine.snake[3];
  app.renderer.spawnBurst(
    (target.x + 0.5) * app.renderer.cell,
    (target.y + 0.5) * app.renderer.cell,
    { count: 34, color: '#ff5ce1', maxSpeed: 240, life: 0.9 },
  );
  app._updateHud(true);
})()`);
await new Promise((resolve) => setTimeout(resolve, 220));
await shoot('07-endless-rich-phone');

// Campaign environment sample: reactor core with barriers + terminals.
await session.evaluate(`window.powerSurge.startCampaign(29)`);
await new Promise((resolve) => setTimeout(resolve, 4400));
await shoot('08-campaign-reactor-phone');

await session.evaluate(`(() => {
  const engine = window.powerSurge.engine;
  engine.terminals.slice(0, 4).forEach((t) => { t.active = true; });
  engine.nextTerminalIndex = 4;
  window.powerSurge._updateHud(true);
})()`);
await new Promise((resolve) => setTimeout(resolve, 220));
await shoot('09-campaign-terminals-phone');

// Results card.
await session.evaluate(`(() => {
  const engine = window.powerSurge.engine;
  engine.score = 9675;
  engine.elapsed = 71.4;
  engine.collected = 12;
  engine.maxCombo = 11;
  engine.stats.powerupsUsed = 3;
  engine._completeObjective('terminals');
})()`);
await new Promise((resolve) => setTimeout(resolve, 900));
await shoot('10-campaign-results-phone');

// Tablet and desktop views.
await setViewport(1024, 768, false);
await session.evaluate(`window.powerSurge._quitToMenu()`);
await new Promise((resolve) => setTimeout(resolve, 400));
await session.evaluate(`document.getElementById('menu-endless').click()`);
await new Promise((resolve) => setTimeout(resolve, 4600));
await shoot('11-endless-tablet');

await setViewport(1440, 900, false);
await new Promise((resolve) => setTimeout(resolve, 700));
await shoot('12-endless-desktop');

await setViewport(844, 390, true);
await new Promise((resolve) => setTimeout(resolve, 700));
await shoot('13-endless-landscape');

await setViewport(412, 915, true);
await session.evaluate(`window.powerSurge._quitToMenu()`);
await session.evaluate(`(() => {
  const app = window.powerSurge;
  app.storage.updateSettings({ highContrast: true, colorblind: true });
  app.save = app.storage.get();
  app._applySettingsToDocument();
})()`);
await new Promise((resolve) => setTimeout(resolve, 320));
await session.evaluate(`document.getElementById('menu-endless').click()`);
await new Promise((resolve) => setTimeout(resolve, 4600));
await shoot('14-endless-high-contrast-phone');

await harness.closePage(id);
await harness.close();
server.kill();
console.log(`\nScreenshots written to ${outDir}`);
