/**
 * door-session.mjs — the session boundary, and what a public screen must forget.
 *
 * Review #8/#9: a front-door screen is public. Visitor B must not read visitor
 * A's words, and the transcript must show the CURRENT session only. The rule the
 * door implements: after a stretch of quiet — nothing said, nothing in flight —
 * the session closes silently. The mic is NOT touched (the owner locked "the ear
 * never closes by itself"); everything a screen could leak is cleared, and the
 * greeting is composed again as text.
 *
 * This probe drives it end to end on the RIG:
 *   - `?debug=1&idle=<ms>` shortens the boundary (a rig-only knob; three minutes
 *     of silence is not something a gate should wait for),
 *   - one real spoken turn fills the rail and the transcript,
 *   - the idle boundary then fires, and the probe asserts that the transcript and
 *     event log are EMPTY again, the session counter advanced, the boundary is
 *     reported as `idle`, and the MIC IS STILL ON.
 *
 * Usage:
 *   NODE_PATH=<repo>/node_modules node door-session.mjs --clips=<dir> --url=http://localhost:4030/portal
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
const CLIPS = args.clips || path.join(HERE, 'clips');
const OUT = args.out || path.join(HERE, 'out');
const IDLE = Number(args.idle || 4000);
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = path.join(CLIPS, 'door-handsfree.wav');
if (!fs.existsSync(clip)) {
  console.error(`missing clip: ${clip}`);
  process.exit(2);
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${clip}`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
  ],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));

const read = () =>
  page.evaluate(() => {
    const root = document.querySelector('[data-testid=portal-page]');
    return {
      session: root?.getAttribute('data-session'),
      boundary: root?.getAttribute('data-boundary'),
      mic: root?.getAttribute('data-mic'),
      state: root?.getAttribute('data-state'),
      transcriptRows: document.querySelectorAll('[data-testid=portal-rail-transcript] li').length,
      logRows: document.querySelectorAll('[data-testid=portal-rail-log] li').length,
      caption: (document.querySelector('[data-testid=portal-caption]')?.textContent ?? '').trim().slice(0, 60),
      heard: (document.querySelector('[data-testid=portal-rail-heard]')?.textContent ?? '').trim().slice(0, 60),
    };
  });

await page.goto(`${BASE}?debug=1&idle=${IDLE}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid=portal-mic]', { timeout: 30000 });
await sleep(2500);
const initial = await read();

await page.locator('[data-testid=portal-mic]').click({ force: true });
await page.waitForFunction(
  () => document.querySelector('[data-testid=portal-page]')?.getAttribute('data-mic') === 'on',
  null,
  { timeout: 15000 },
);

// One real spoken turn, so there is something to leak.
await page
  .waitForFunction(
    () => Number(document.querySelector('[data-testid=portal-page]')?.getAttribute('data-merges') ?? 0) >= 0
      && document.querySelector('[data-testid=portal-rail-transcript]')?.textContent?.length > 60,
    null,
    { timeout: 60000 },
  )
  .catch(() => undefined);
await sleep(3000);
const filled = await read();
const filledShot = path.join(OUT, 'door-session-1-filled.png');
await page.screenshot({ path: filledShot });

// Now the boundary. The idle check runs every 15 s, so allow for it.
let cleared = null;
const start = Date.now();
while (Date.now() - start < 40000) {
  const now = await read();
  if (now.session !== filled.session) {
    cleared = now;
    break;
  }
  await sleep(1000);
}
await sleep(1500);
const after = cleared ?? (await read());
const clearedShot = path.join(OUT, 'door-session-2-cleared.png');
await page.screenshot({ path: clearedShot });

const checks = [];
const ck = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
ck('one spoken turn filled the transcript', filled.transcriptRows >= 2, filled);
ck('the rail logged the turn', filled.logRows >= 1, { logRows: filled.logRows });
ck('the session boundary fired', after.session !== filled.session, { before: filled.session, after: after.session });
ck('boundary reported as idle', after.boundary === 'idle', after.boundary);
ck('transcript cleared at the boundary', after.transcriptRows === 0, after.transcriptRows);
ck('event log cleared at the boundary', after.logRows === 0, after.logRows);
ck('nothing heard is still on screen', !/“/.test(after.heard), after.heard);
ck('MIC WAS NOT TOUCHED (still on)', after.mic === 'on', after.mic);
ck('the new visitor gets a greeting again', after.caption.length > 20 && after.caption !== filled.caption, {
  before: filled.caption,
  after: after.caption,
});
ck('no console errors', consoleErrors.length === 0, consoleErrors);
ck('no page errors', pageErrors.length === 0, pageErrors);

const result = {
  idleMs: IDLE,
  initial,
  filled,
  after,
  checks,
  passed: checks.every((c) => c.ok),
  shots: [filledShot, clearedShot],
  consoleErrors,
  pageErrors,
};
fs.writeFileSync(path.join(OUT, 'door-session.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ passed: result.passed, failed: checks.filter((c) => !c.ok), checks: checks.length, filled, after }, null, 2));
await browser.close();
process.exit(result.passed ? 0 : 1);
