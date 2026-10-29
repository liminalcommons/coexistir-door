/**
 * door-stage.mjs — the stage costs nothing while nobody is looking.
 *
 * A door monitor can sit in a background tab or behind a locker screen for hours.
 * The stage must then stop drawing: no updates, no frames, no WebGL work fighting
 * the audio thread. The page's own RAF loop checks `document.hidden` and returns
 * before touching the model, and reports `paused` through `__portalRig`.
 *
 * This probe flips `document.hidden` (the same property the browser sets), counts
 * rendered frames on both sides of the flip, and asserts the counter is FLAT
 * while hidden and advancing again when visible.
 *
 * Usage:
 *   NODE_PATH=<repo>/node_modules node door-stage.mjs --url=http://localhost:4030/portal
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? '1'];
  }),
);
const BASE = args.url || 'http://localhost:4030/portal';
const OUT = args.out || path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(
  () => document.querySelector('[data-testid=portal-stage]')?.getAttribute('data-status') === 'ready',
  null,
  { timeout: 40000 },
);
await sleep(1200);

const frames = () => page.evaluate(() => window.__portalRig?.frames() ?? -1);
const paused = () => page.evaluate(() => window.__portalRig?.paused() ?? null);

const visible = [];
for (let i = 0; i < 3; i += 1) {
  visible.push(await frames());
  await sleep(500);
}
const visibleDelta = visible[visible.length - 1] - visible[0];

// Hide the tab the way the browser does: the property, plus the event.
await page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
});
await sleep(300);
const hiddenStart = await frames();
const pausedWhileHidden = await paused();
await sleep(2000);
const hiddenEnd = await frames();

await page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
});
await sleep(1200);
const resumed = await frames();

const checks = [];
const ck = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
ck('the stage renders while visible', visibleDelta > 5, { visible, visibleDelta });
ck('rendering pauses while hidden', hiddenEnd === hiddenStart, { hiddenStart, hiddenEnd });
ck('the rig reports paused', pausedWhileHidden === true, pausedWhileHidden);
ck('rendering resumes when visible again', resumed - hiddenEnd > 3, { hiddenEnd, resumed });
ck('no console errors', consoleErrors.length === 0, consoleErrors);
ck('no page errors', pageErrors.length === 0, pageErrors);

const result = {
  url: BASE,
  visible,
  visibleDelta,
  hidden: { start: hiddenStart, end: hiddenEnd, paused: pausedWhileHidden },
  resumed,
  checks,
  passed: checks.every((c) => c.ok),
  consoleErrors,
  pageErrors,
};
fs.writeFileSync(path.join(OUT, 'door-stage.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ passed: result.passed, failed: checks.filter((c) => !c.ok), visibleDelta, hidden: result.hidden, resumed }, null, 2));
await browser.close();
process.exit(result.passed ? 0 : 1);
