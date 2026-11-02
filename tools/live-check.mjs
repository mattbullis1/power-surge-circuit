/**
 * Smoke-tests the delivered game over the live XAMPP deployment.
 *
 * Verifies the app boots cleanly, plays a real run and renders pixels — the
 * same assertions as tools/qa.mjs, but pointed at Apache:8080 instead of the
 * bundled server.
 *
 * Run with:  node tools/live-check.mjs [url]
 */
import { BrowserHarness } from './cdp.mjs';

const URL_UNDER_TEST = process.argv[2] || 'http://localhost:8080/power-surge-circuit/';

const harness = await new BrowserHarness().launch();
const { id, session } = await harness.newPage(URL_UNDER_TEST);

const errors = [];
const failed = [];
session.on('Runtime.exceptionThrown', (p) =>
  errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
session.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') errors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' '));
});
session.on('Network.loadingFailed', (p) => failed.push(`${p.type} ${p.errorText}`));
await session.send('Network.enable');
await session.send('Emulation.setDeviceMetricsOverride', {
  width: 412, height: 915, deviceScaleFactor: 2, mobile: true,
});
await new Promise((r) => setTimeout(r, 3000));

const boot = await session.evaluate(`({
  ready: document.body.dataset.ready === 'true',
  title: document.title,
  canvases: document.querySelectorAll('canvas').length,
  menuButtons: document.querySelectorAll('.menu-actions .btn').length,
  achievements: document.querySelectorAll('#achievement-list .achievement').length,
})`);

await session.evaluate(`document.getElementById('menu-endless').click()`);
await new Promise((r) => setTimeout(r, 5400));

const live = await session.evaluate(`(() => {
  const r = window.powerSurge.renderer;
  const d = r.ctx.getImageData(0, 0, r.canvas.width, r.canvas.height).data;
  let lit = 0; let n = 0;
  for (let i = 0; i < d.length; i += 4) { n++; if (d[i] + d[i+1] + d[i+2] > 150) lit++; }
  return {
    status: window.powerSurge.engine.status,
    steps: window.powerSurge.engine.steps,
    litPct: +((lit / n) * 100).toFixed(1),
    hud: document.getElementById('hud-speed').textContent,
  };
})()`);

// Campaign level with the richest geometry.
await session.evaluate(`window.powerSurge._quitToMenu(); window.powerSurge.startCampaign(30)`);
await new Promise((r) => setTimeout(r, 5200));
const campaign = await session.evaluate(`(() => {
  const e = window.powerSurge.engine;
  return {
    level: e.levelNumber, name: e.level.name, chapter: e.level.chapterName,
    objective: e.objective.type, target: e.objective.target,
    hazards: e.hazards.length, barriers: e.barriers.length,
    energy: e.energyNodes.length, status: e.status,
  };
})()`);

console.log(`URL: ${URL_UNDER_TEST}\n`);
console.log('Boot      :', JSON.stringify(boot));
console.log('Endless   :', JSON.stringify(live));
console.log('Campaign  :', JSON.stringify(campaign));
console.log('Errors    :', errors.length ? errors.slice(0, 3) : 'none');
console.log('Net fails :', failed.length ? failed.slice(0, 3) : 'none');

const ok =
  boot.ready &&
  boot.canvases === 1 &&
  boot.menuButtons === 6 &&
  live.status === 'running' &&
  live.steps > 5 &&
  live.litPct > 20 &&
  campaign.level === 30 &&
  errors.length === 0 &&
  failed.length === 0;

console.log(`\n${ok ? 'PASS' : 'FAIL'} — live deployment smoke test`);

await harness.closePage(id);
await harness.close();
process.exit(ok ? 0 : 1);
