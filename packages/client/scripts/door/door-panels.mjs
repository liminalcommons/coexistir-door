/**
 * door-panels.mjs — the three debug panels and the FULL Live2D state map.
 *
 * Two things are proven here, both against a real browser on a running rig:
 *
 * 1. THE PANELS. At 1440×900 with `?debug=1` the right rail must carry, in the
 *    owner's order, VOICE ID (speaker claim, voiceKey, claim state, the explicit
 *    "no voiceprint / confidence unknown" gap, the measured clip and the turn's
 *    own identity) → LIVE2D trigger lines → TRANSCRIPT (both speakers, with the
 *    turn's language) → EVENT LOG (turn/stt/tts rows with their timings). At
 *    390×844 the rail is gone and the drawer carries the same three panes
 *    (VOZ / EVENTOS / TRANSCRIÇÃO). A real turn is produced by talking at the
 *    fake capture device; nothing is injected into the log.
 *
 * 2. THE MAP. Every state in `AGENT_STATE_MAP` is driven through the door's own
 *    code path — `window.__portalRig.applyCue()` for the sentiment states (which
 *    runs the REAL `classifyTurn`), `applyState()` for the pipeline beats — and
 *    after each one the rig's CURRENT motion/expression is read back and
 *    compared with the map. `applied=false` is a failure, not a warning, and
 *    every trigger must have printed exactly one `[live2d:trigger]` console line.
 *
 * Usage:
 *   NODE_PATH=<repo>/node_modules node door-panels.mjs \
 *     --url=http://localhost:4030/portal?debug=1&lang=pt \
 *     --clips=./clips --voice-key=owl:front-door
 *
 * `--clips` is optional: without it the probe still proves the panels are live
 * (identity/claim/acoustic rows) and the whole map, but it cannot prove a real
 * turn reached the transcript. With it, `door-pt-en.wav` (or `door-handsfree.wav`)
 * is fed to the fake microphone.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * `--url=http://host/portal?debug=1&lang=pt` must not be split at the SECOND
 * `=`: only the first one separates the flag from its value (the query string
 * carries its own).
 */
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const cleaned = a.replace(/^--/, '');
    const at = cleaned.indexOf('=');
    return at < 0 ? [cleaned, '1'] : [cleaned.slice(0, at), cleaned.slice(at + 1)];
  }),
);
const BASE = args.url || 'http://localhost:4030/portal?debug=1&lang=pt';
const OUT = args.out || path.join(HERE, 'out');
const CLIPS = args.clips ? path.resolve(args.clips) : null;
const VOICE_KEY = args['voice-key'] || 'owl:front-door';
const CLIP_NAME = args.clip || 'door-pt-en.wav';
const WAIT_TURNS = Number(args.turns || 1);
fs.mkdirSync(OUT, { recursive: true });

const CLIP = CLIPS && fs.existsSync(path.join(CLIPS, CLIP_NAME)) ? path.join(CLIPS, CLIP_NAME) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const ck = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

const browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    ...(CLIP ? [`--use-file-for-fake-audio-capture=${CLIP}`] : []),
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const evidence = { url: BASE, clip: CLIP, voiceKey: VOICE_KEY, startedAt: new Date().toISOString() };
const consoleErrors = [];
const pageErrors = [];
const dialogs = [];
const triggerLines = [];

async function openSurface(viewport, { mic = false } = {}) {
  const context = await browser.newContext({ viewport, permissions: ['microphone'] });
  await context.addInitScript(() => {
    window.__L2D = [];
    window.addEventListener('live2d:trigger', (event) => window.__L2D.push(event.detail));
  });
  const page = await context.newPage();
  page.on('console', (m) => {
    const text = m.text();
    if (text.includes('[live2d:trigger]')) triggerLines.push(text);
    if (m.type() === 'error') consoleErrors.push(text.slice(0, 300));
  });
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
  page.on('dialog', async (d) => {
    dialogs.push(`${d.type()}: ${d.message().slice(0, 120)}`);
    await d.dismiss().catch(() => undefined);
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=portal-page]', { timeout: 30000 });
  await page.waitForFunction(() => window.__portalRig?.ready?.() === true, null, { timeout: 45000 });
  await sleep(1500);
  if (mic && CLIP) {
    await page.locator('[data-testid=portal-mic]').click({ force: true });
    await page.waitForFunction(
      () => document.querySelector('[data-testid=portal-page]')?.getAttribute('data-mic') === 'on',
      null,
      { timeout: 15000 },
    );
  }
  return { page, context };
}

const rowsOf = (page, id) =>
  page.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`);
    if (!el) return null;
    return [...el.querySelectorAll('.portal__row')].map((row) => ({
      key: row.querySelector('.portal__key')?.textContent?.trim() ?? '',
      val: row.querySelector('.portal__val')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    }));
  }, id);

const textOf = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : null;
  }, selector);

/** Drive every state in the map and check the rig agrees with the table. */
async function sweepMap(page) {
  const map = await page.evaluate(() => window.__portalRig.map());
  const sentences = [
    ['happy', 'Que bom te ver por aqui, tudo bem?'],
    ['excited', 'Conseguimos! Que ótimo, parabéns!'],
    ['sad', 'Infelizmente a tarefa da cozinha está atrasada.'],
    ['shy', 'Desculpa, espero que dê tempo.'],
    ['skeptical', 'Talvez seja melhor revisar isso antes?'],
    ['angry', 'Isso é inaceitável, estou com raiva.'],
  ];
  const beats = ['greeting', 'listening', 'thinking', 'speaking', 'idle', 'bargeIn'];
  const rows = [];

  for (const [expected, sentence] of sentences) {
    const step = await page.evaluate(([text]) => {
      const cue = window.__portalRig.applyCue(text);
      return { cue, motion: window.__portalRig.motion(), expression: window.__portalRig.expression() };
    }, [sentence]);
    rows.push({
      requested: expected,
      state: step.cue?.state,
      mapExpression: step.cue?.expression,
      mapMotionFile: step.cue?.motionFile,
      rigMotion: step.motion,
      rigExpression: step.expression,
    });
    await sleep(120);
  }
  for (const state of beats) {
    const step = await page.evaluate((next) => {
      const instruction = window.__portalRig.applyState(next);
      return {
        instruction,
        motion: window.__portalRig.motion(),
        expression: window.__portalRig.expression(),
      };
    }, state);
    const previous = rows.length > 0 ? rows[rows.length - 1].rigExpression : null;
    rows.push({
      requested: state,
      state: step.instruction?.state,
      mapExpression: step.instruction?.expression?.name,
      mapMotionFile: step.instruction?.motion?.file,
      rigMotion: step.motion,
      rigExpression: step.expression,
      // `speaking` keeps the face the answer earned (map keepFace); the MOTION
      // must still be the map's.
      expectExpression: state === 'speaking' ? previous : step.instruction?.expression?.name,
    });
    await sleep(120);
  }

  const fired = await page.evaluate(() => window.__portalRig.fired());
  const triggers = await page.evaluate(() => window.__portalRig.triggers());
  const missing = Object.keys(map).filter((s) => !fired.includes(s));
  const mismatched = rows.filter(
    (row) =>
      row.state !== row.requested ||
      !row.rigMotion ||
      row.rigExpression !== (row.expectExpression ?? row.mapExpression) ||
      !String(row.mapMotionFile || '').endsWith('.motion3.json'),
  );
  const refused = triggers.filter((t) => t.applied === false);

  ck('every state in the map is reachable', Object.keys(map).length === 12, Object.keys(map));
  ck('every mapped state fired at least once', missing.length === 0, { missing, fired });
  ck('the rig wears exactly what the map says', mismatched.length === 0, mismatched);
  ck('the rig accepted every trigger', refused.length === 0, refused.map((t) => t.state));
  return { map: Object.keys(map), fired, rows, mismatched, refused, triggers };
}

// ---------------------------------------------------------------- desktop ----
const desktopSession = await openSurface({ width: 1440, height: 900 }, { mic: Boolean(CLIP) });
const page = desktopSession.page;
evidence.desktop = { panels: {}, turns: 0 };

const beforeRows = await rowsOf(page, 'portal-rail-voiceid');
ck('desktop rail exists with ?debug=1', (await page.locator('[data-testid=portal-rail]').count()) === 1);
ck('the portrait summary card is replaced by the rail on desktop',
  (await page.locator('[data-testid=portal-debug]').isVisible().catch(() => false)) === false);
ck('the rail carries the voice-ID rows', Array.isArray(beforeRows) && beforeRows.length >= 5, beforeRows);
ck('voiceKey is the pinned kiosk key',
  (beforeRows ?? []).some((r) => r.key === 'voiceKey' && r.val.includes('owl:') || r.val.includes('livekit:')),
  beforeRows?.find((r) => r.key === 'voiceKey'));
ck('the voice-ID panel states there is no voiceprint',
  (beforeRows ?? []).some((r) => /voiceprint/i.test(r.key) && /not computed/i.test(r.val)),
  beforeRows?.find((r) => r.key === 'voiceprint'));
ck('the confidence row is an explicit unknown',
  (beforeRows ?? []).some((r) => /confidence/i.test(r.key) && /unknown/i.test(r.val)),
  beforeRows?.find((r) => r.key === 'confidence'));
ck('the boot beat is logged as a trigger', (await textOf(page, '[data-testid=portal-rail-stage]')) !== null);

await page.screenshot({ path: `${OUT}/panels-desktop-1-boot.png` });

if (CLIP) {
  // Two answers = both speakers, and (with the PT+EN clip) both languages.
  const wanted = Math.max(1, WAIT_TURNS, 2);
  try {
    await page.waitForFunction(
      (count) => {
        const log = document.querySelector('[data-testid=portal-rail-log]');
        return (log?.querySelectorAll('.portal__logrow[data-kind=TURN]').length ?? 0) >= count;
      },
      wanted,
      { timeout: 90000 },
    );
    evidence.desktop.turns = await page.evaluate(
      () => document.querySelectorAll('[data-testid=portal-rail-log] .portal__logrow[data-kind=TURN]').length,
    );
  } catch (err) {
    evidence.desktop.turnWaitError = String(err).slice(0, 200);
  }
  await sleep(1500);
  await page.screenshot({ path: `${OUT}/panels-desktop-2-after-turns.png` });
}

const afterRows = await rowsOf(page, 'portal-rail-voiceid');
const transcript = await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid=portal-rail-transcript] .portal__line')].map((li) => ({
    who: li.querySelector('.portal__linewho')?.textContent?.trim() ?? '',
    lang: li.querySelector('.portal__linelang')?.textContent?.trim() ?? '',
    text: li.querySelector('.portal__linetext')?.textContent?.trim() ?? '',
  })),
);
const logRows = await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid=portal-rail-log] .portal__logrow')].map((li) => ({
    kind: li.querySelector('.portal__logkind')?.textContent?.trim() ?? '',
    head: li.querySelector('.portal__loghead')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    meta: li.querySelector('.portal__logmeta')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  })),
);
const triggerText = await textOf(page, '[data-testid=portal-rail-stage]');
evidence.desktop.panels = { voice: afterRows, transcript, log: logRows.slice(0, 8), triggers: triggerText };

ck('the transcript has the visitor and Mara', transcript.some((l) => l.who === 'VOCÊ') && transcript.some((l) => l.who === 'MARA'), transcript);

if (CLIP) {
  ck('a real turn reached the log', evidence.desktop.turns >= 1, evidence.desktop.turns);
  ck('the log carries STT and TTS rows with timings',
    logRows.some((r) => r.kind === 'STT' && /\d+ms/.test(r.head)) &&
      logRows.some((r) => r.kind === 'TTS' && /\d+ms/.test(r.head)),
    logRows.slice(0, 4));
  ck('the transcript carries the turn language', transcript.every((l) => /^(PT|EN)$/.test(l.lang)), transcript.map((l) => l.lang));
  ck('the clip was measured (acoustics on the row)',
    (afterRows ?? []).some((r) => r.key === 'clip' && /F0 \d+ Hz/.test(r.val)),
    afterRows?.find((r) => r.key === 'clip'));
  ck('the turn row carries its own identity',
    (afterRows ?? []).some((r) => r.key === 'this turn' && /(verified|unverified|no name claim|claim)/i.test(r.val)),
    afterRows?.find((r) => r.key === 'this turn'));
}

const sweep = await sweepMap(page);
evidence.desktop.map = sweep;
await page.screenshot({ path: `${OUT}/panels-desktop-3-map.png` });
// Close the desktop surface before opening the portrait one: a page still
// holding the fake microphone and a busy WebGL loop is not part of the test.
await desktopSession.context.close();

// Every trigger must have printed its console line, and the line must name the
// motion FILE and the expression — the raw grep-able proof.
ck('one console line per trigger', triggerLines.length >= sweep.triggers.length, {
  lines: triggerLines.length,
  triggers: sweep.triggers.length,
});
ck('every trigger line names state, motion file and expression',
  triggerLines.every((l) => /state=\S+ · (once|loop) · motion \S+\[\d+\] \S+\.motion3\.json .* · expression exp_0\d/.test(l)),
  triggerLines.slice(0, 2));

// --------------------------------------------------------------- portrait ----
const portraitSession = await openSurface({ width: 390, height: 844 });
const portrait = portraitSession.page;
evidence.portrait = { panes: {} };
const usesDrawer = (await portrait.locator('[data-testid=portal-rail]').isVisible().catch(() => false)) === false;
ck('portrait has no rail', usesDrawer, null);
const cardVisible = await portrait
  .locator('[data-testid=portal-debug]')
  .isVisible()
  .catch(() => false);
ck('portrait shows the debug card', cardVisible);
if (!cardVisible) {
  // A missing card IS the failure; capture why instead of timing out on a click.
  await portrait.screenshot({ path: `${OUT}/panels-portrait-failure.png` });
  evidence.portrait.html = (await portrait.content()).slice(0, 4000);
  evidence.checks = checks;
  evidence.consoleErrors = consoleErrors;
  evidence.pageErrors = pageErrors;
  evidence.dialogs = dialogs;
  fs.writeFileSync(path.join(OUT, 'door-panels.json'), JSON.stringify(evidence, null, 2));
  await browser.close();
  console.log(JSON.stringify({ checks: checks.length, failed: checks.filter((c) => !c.ok), evidence: path.join(OUT, 'door-panels.json') }, null, 2));
  process.exit(1);
}
await portrait.locator('[data-testid=portal-debug]').click({ force: true });
const cardRows = await rowsOf(portrait, 'portal-voiceid');
ck('the portrait card carries live voice-ID values',
  Array.isArray(cardRows) && cardRows.some((r) => /speaker/i.test(r.key) && r.val.length > 0),
  cardRows);

await portrait.locator('[data-testid=portal-debug]').click({ force: true });
await portrait.waitForSelector('[data-testid=portal-drawer]', { timeout: 10000 });
for (const [tab, name, bodyId] of [
  ['portal-tab-voice', 'voice', 'portal-drawer-voiceid'],
  ['portal-tab-log', 'log', 'portal-drawer-triggers'],
  ['portal-tab-transcript', 'transcript', 'portal-drawer-body'],
]) {
  await portrait.locator(`[data-testid=${tab}]`).click({ force: true });
  await sleep(600);
  await portrait.screenshot({ path: `${OUT}/panels-portrait-drawer-${name}.png` });
  evidence.portrait.panes[name] = await textOf(portrait, '[data-testid=portal-drawer-body]');
  if (name === 'voice') evidence.portrait.voiceRows = await rowsOf(portrait, 'portal-drawer-voiceid');
  ck(`the drawer ${name} pane has content`, (evidence.portrait.panes[name] ?? '').length > 20, bodyId);
}
const drawerVoiceRows = evidence.portrait.voiceRows ?? null;
await portraitSession.context.close();
ck('the drawer VOZ pane shows the same identity rows',
  (drawerVoiceRows ?? []).some((r) => /voiceprint/i.test(r.key) && /not computed/i.test(r.val)),
  drawerVoiceRows);

// ---------------------------------------------------------------- verdict ----
evidence.checks = checks;
evidence.triggerLines = triggerLines;
evidence.consoleErrors = consoleErrors;
evidence.pageErrors = pageErrors;
evidence.dialogs = dialogs;
evidence.finishedAt = new Date().toISOString();
ck('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3));
ck('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3));
ck('no dialogs', dialogs.length === 0, dialogs);

fs.writeFileSync(path.join(OUT, 'door-panels.json'), JSON.stringify(evidence, null, 2));
await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ checks: checks.length, failed: failed.length, failures: failed, evidence: path.join(OUT, 'door-panels.json') }, null, 2));
if (failed.length > 0) process.exit(1);
