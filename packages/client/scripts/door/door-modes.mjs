/**
 * door-modes.mjs — the door's behavioural regression suite (the P1 gate).
 *
 * One script, one mode per clause of the locked spec, each with HARD
 * assertions (review #13): a mode either passes or fails, and the exit code says
 * which. They run against a live rig with Chrome's fake capture device fed from
 * a WAV, so the real path is exercised end to end — getUserMedia → AudioWorklet →
 * VAD → WAV → Deepgram → /voice/turn → streamed TTS — and only the microphone is
 * deterministic.
 *
 *   handsfree    one MIC tap, TWO complete exchanges, no further touches: the ear
 *                stays open, the question sends itself, the state returns to
 *                LISTENING by itself after each answer.
 *   bargein      the second question arrives while she is answering: her audio is
 *                ABORTED (server row aborted=true), the mouth shuts, and the
 *                words that cut her become the next answered turn.
 *   deaf         mic OFF: the same WAV keeps talking into a closed device. No STT,
 *                no turn, state stays MIC DESLIGADO.
 *   silence      ~40 s of quiet with the ear open: no STT, no turn, no nag; the
 *                state never leaves LISTENING.
 *   cutoff       mic OFF DURING a capture: the half-spoken clip dies with the
 *                stream instead of being shipped after the visitor asked for quiet.
 *   pause-short  a short pause inside a sentence: ONE question, ONE answer.
 *   pause-long   a pause longer than the VAD timer: still ONE question (turn 1 is
 *                cancelled and re-sent merged — review #11).
 *   gated        the public door carries no debug surfaces; `?debug=1` does.
 *
 * Usage:
 *   NODE_PATH=<repo>/node_modules node door-modes.mjs --mode=handsfree \
 *     --url=http://localhost:4030/portal --clips=<dir> --out=<dir>
 *
 * `--clips` must contain door-handsfree.wav, door-bargein.wav, door-deaf.wav,
 * door-silence.wav, door-pause-short.wav, door-pause-long.wav (see clips.json /
 * make-clips.mjs). It defaults to `./clips` next to this file.
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
const MODE = args.mode || 'handsfree';
const BASE = args.url || 'http://localhost:4030/portal';
const CLIPS = args.clips || path.join(HERE, 'clips');
const OUT = args.out || path.join(HERE, 'out');
const DEBUG = args.debug === '1';
fs.mkdirSync(OUT, { recursive: true });

const CLIP = {
  handsfree: path.join(CLIPS, 'door-handsfree.wav'),
  bargein: path.join(CLIPS, 'door-bargein.wav'),
  deaf: path.join(CLIPS, 'door-deaf.wav'),
  silence: path.join(CLIPS, 'door-silence.wav'),
  cutoff: path.join(CLIPS, 'door-handsfree.wav'),
  'pause-short': path.join(CLIPS, 'door-pause-short.wav'),
  'pause-long': path.join(CLIPS, 'door-pause-long.wav'),
  gated: path.join(CLIPS, 'door-silence.wav'),
}[MODE];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (MODE !== 'gated' && CLIP && !fs.existsSync(CLIP)) {
  console.error(`missing clip for ${MODE}: ${CLIP}`);
  process.exit(2);
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    ...(CLIP ? [`--use-file-for-fake-audio-capture=${CLIP}`] : []),
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
  ],
});
const context = await browser.newContext({
  viewport: { width: 480, height: 960 },
  permissions: ['microphone', 'camera'],
});
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
const dialogs = [];
const requests = [];
const sttBodies = [];
const turnBodies = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 240));
});
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 240)));
page.on('dialog', async (d) => {
  dialogs.push(`${d.type()}: ${d.message().slice(0, 100)}`);
  await d.dismiss().catch(() => undefined);
});
page.on('request', (req) => {
  const url = req.url();
  if (url.includes('/api/coexistir/voice/')) {
    requests.push({ at: Date.now(), path: url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] });
  }
});
page.on('response', async (res) => {
  const url = res.url();
  try {
    if (url.includes('/api/coexistir/voice/stt')) {
      sttBodies.push({ status: res.status(), body: await res.json() });
    } else if (url.endsWith('/api/coexistir/voice/turn')) {
      turnBodies.push({ status: res.status(), body: await res.json() });
    }
  } catch {
    /* body already consumed */
  }
});

const startedAt = Date.now();
const result = {
  mode: MODE,
  url: BASE,
  clip: CLIP ?? null,
  startedAt: new Date(startedAt).toISOString(),
  checks: [],
};
const check = (name, ok, detail) => {
  result.checks.push({ name, ok: Boolean(ok), detail });
};

await page.goto(`${BASE}${DEBUG ? (BASE.includes('?') ? '&' : '?') + 'debug=1' : ''}`, {
  waitUntil: 'domcontentloaded',
});
await page.waitForSelector('[data-testid=portal-mic]', { timeout: 30000 });
await sleep(2600); // rigging + the silent greeting

const sttCount = () => requests.filter((r) => r.path === '/api/coexistir/voice/stt').length;
const turnCount = () => requests.filter((r) => r.path === '/api/coexistir/voice/turn').length;
const stateNow = () =>
  page.evaluate(() => document.querySelector('[data-testid=portal-page]')?.getAttribute('data-state'));
const micNow = () =>
  page.evaluate(() => document.querySelector('[data-testid=portal-page]')?.getAttribute('data-mic'));
const vadSnap = () => page.evaluate(() => window.__portalVad?.snapshot() ?? null);

async function openEar() {
  await page.locator('[data-testid=portal-mic]').click({ force: true });
  await page.waitForFunction(
    () => document.querySelector('[data-testid=portal-page]')?.getAttribute('data-mic') === 'on',
    null,
    { timeout: 15000 },
  );
}
async function waitState(wanted, timeoutMs) {
  return page
    .waitForFunction(
      (s) => document.querySelector('[data-testid=portal-page]')?.getAttribute('data-state') === s,
      wanted,
      { timeout: timeoutMs },
    )
    .then(() => true)
    .catch(() => false);
}
async function waitFor(fn, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(120);
  }
  return false;
}

result.initial = await page.evaluate(() => ({
  state: document.querySelector('[data-testid=portal-page]')?.getAttribute('data-state'),
  mic: document.querySelector('[data-testid=portal-page]')?.getAttribute('data-mic'),
  label: document.querySelector('[data-testid=portal-state-label]')?.textContent,
  dialogs: document.querySelectorAll('dialog,[role=dialog]').length,
  dock: [...document.querySelectorAll('.portal__dockbtn')].map((b) => b.getAttribute('data-testid')),
}));
check('dock is exactly MIC + CAM', JSON.stringify(result.initial.dock) === '["portal-mic","portal-cam"]', result.initial.dock);
check('starts deaf with one state word', result.initial.state === 'deaf' && !!result.initial.label, result.initial);

if (MODE === 'gated') {
  // No tap: this mode only reads the chrome.
  const chrome = await page.evaluate(() => ({
    debug: document.querySelector('[data-testid=portal-page]')?.getAttribute('data-debug'),
    rail: document.querySelectorAll('[data-testid=portal-rail]').length,
    debugBox: document.querySelectorAll('[data-testid=portal-debug]').length,
    drawer: document.querySelectorAll('[data-testid=portal-drawer]').length,
    railText: document.querySelector('[data-testid=portal-rail]')?.textContent ?? '',
    body: document.body.innerText,
  }));
  if (DEBUG) {
    check('debug=1 exposes the rail', chrome.debug === 'on' && chrome.rail === 1, {
      rail: chrome.rail,
    });
    check('rail carries voice-ID, transcript and log', /VOICE ID/.test(chrome.railText) && /TRANSCRIPT/.test(chrome.railText) && /EVENTOS/.test(chrome.railText));
  } else {
    check('public door has NO rail', chrome.rail === 0 && chrome.debugBox === 0, chrome.rail);
    check('public door has NO voiceKey / claim / transcript text', !/voiceKey|claim|TRANSCRIPT|EVENTOS/i.test(chrome.body), chrome.body.slice(0, 120));
  }
  check('no dialogs on load', result.initial.dialogs === 0, result.initial.dialogs);
}

if (MODE === 'handsfree') {
  await openEar();
  check('one tap opens the ear', (await micNow()) === 'on');

  for (const n of [1, 2]) {
    const gotStt = await waitFor(() => sttBodies.length >= n && Boolean(sttBodies[n - 1]?.body?.text), 45000);
    const gotTurn = await waitFor(() => turnBodies.length >= n && Boolean(turnBodies[n - 1]?.body?.answer), 45000);
    const spoke = await waitState('speaking', 25000);
    const back = await waitState('listening', 60000);
    const body = sttBodies[n - 1]?.body;
    const turn = turnBodies[n - 1]?.body;
    check(`turn ${n}: the ear transcribed`, gotStt && !!body?.text, body?.text);
    check(`turn ${n}: the bridge answered`, gotTurn && !!turn?.answer, String(turn?.answer ?? '').slice(0, 80));
    check(`turn ${n}: she spoke`, spoke);
    check(`turn ${n}: back to LISTENING by itself`, back);
  }
  const final = await vadSnap();
  result.vad = final;
  check('mic never closed (ear still open, no taps)', (await micNow()) === 'on');
  check('capture ran on the AudioWorklet', final?.mode === 'worklet', final?.mode);
  check('worklet lost no audio blocks', (final?.droppedMs ?? 1) === 0 && (final?.gaps ?? 1) === 0, {
    gaps: final?.gaps,
    droppedMs: final?.droppedMs,
    blocks: final?.blocks,
    expectedBlocks: final?.expectedBlocks,
  });
}

if (MODE === 'bargein') {
  await openEar();
  const gotStt = await waitFor(() => sttCount() >= 1, 40000);
  check('turn 1 transcribed', gotStt);
  check('turn 1 is speaking', await waitState('speaking', 25000));
  const barged = await page
    .waitForFunction(() => (window.__portalVad?.snapshot()?.bargeIns ?? 0) >= 1, null, { timeout: 40000 })
    .then(() => true)
    .catch(() => false);
  check('barge-in detected', barged);
  const mouthAtCut = await page.evaluate(() => ({
    mouth: Number(document.querySelector('.portal-stage__canvas')?.dataset.mouth ?? '1'),
    rigMouth: window.__portalRig?.mouth?.() ?? 1,
  }));
  check('mouth shut on the cut (ParamA -> 0)', mouthAtCut.rigMouth < 0.05, mouthAtCut);
  const gotSecondStt = await waitFor(
    () => sttBodies.length >= 2 && Boolean(sttBodies[1]?.body?.text),
    60000,
  );
  const gotSecondTurn = await waitFor(
    () => turnBodies.length >= 2 && Boolean(turnBodies[1]?.body?.answer),
    60000,
  );
  result.turn2 = turnBodies[1]?.body
    ? { kind: turnBodies[1].body.kind, answer: String(turnBodies[1].body.answer).slice(0, 120) }
    : null;
  check(
    'the interrupting words became turn 2',
    gotSecondStt && gotSecondTurn && !!result.turn2?.answer,
    { gotSecondStt, gotSecondTurn, turn2: result.turn2 },
  );
  result.vad = await vadSnap();
}

if (MODE === 'deaf') {
  // Answer one turn first, so the deaf window contains real speech.
  await openEar();
  await waitFor(() => sttCount() >= 1, 40000);
  await waitState('speaking', 25000);
  await waitState('listening', 60000);
  await page.locator('[data-testid=portal-mic]').click({ force: true });
  await page.waitForFunction(
    () => document.querySelector('[data-testid=portal-page]')?.getAttribute('data-mic') === 'off',
    null,
    { timeout: 10000 },
  );
  const before = { stt: sttCount(), turn: turnCount() };
  await sleep(16000); // a full speech burst plays into the closed device
  const after = { stt: sttCount(), turn: turnCount(), state: await stateNow(), mic: await micNow() };
  result.deaf = { before, after };
  check('mic OFF means zero STT', after.stt === before.stt, after);
  check('mic OFF means zero turns', after.turn === before.turn, after);
  check('state stays deaf', after.state === 'deaf' && after.mic === 'off', after);
}

if (MODE === 'silence') {
  await openEar();
  const samples = [];
  for (let i = 0; i < 20; i += 1) {
    await sleep(2000);
    samples.push({
      state: await stateNow(),
      mic: await micNow(),
      caption: await page.evaluate(
        () => (document.querySelector('[data-testid=portal-caption]')?.textContent || '').trim().slice(0, 80),
      ),
    });
  }
  const states = [...new Set(samples.map((s) => s.state))];
  result.silence = {
    states,
    stt: sttCount(),
    turns: turnCount(),
    captions: [...new Set(samples.map((s) => s.caption))],
    durationMs: 40000,
  };
  check('40 s of quiet: no STT', sttCount() === 0, sttCount());
  check('40 s of quiet: no turn', turnCount() === 0, turnCount());
  check('the ear stayed open and LISTENING', states.length === 1 && states[0] === 'listening', states);
  check('no nag, no prompt: the caption did not change', new Set(samples.map((s) => s.caption)).size === 1);
}

if (MODE === 'cutoff') {
  await openEar();
  await page
    .waitForFunction(
      () => {
        const v = window.__portalVad?.snapshot();
        return !!v && v.onsets >= 1 && v.sent === 0;
      },
      null,
      { timeout: 30000 },
    )
    .catch(() => undefined);
  const capturing = await vadSnap();
  await page.locator('[data-testid=portal-mic]').click({ force: true });
  await page.waitForFunction(
    () => document.querySelector('[data-testid=portal-page]')?.getAttribute('data-mic') === 'off',
    null,
    { timeout: 10000 },
  );
  await sleep(9000);
  result.cutoff = { capturing: { onsets: capturing?.onsets, sent: capturing?.sent }, stt: sttCount(), turns: turnCount(), vad: await page.evaluate(() => typeof window.__portalVad) };
  check('a clip cut mid-sentence is never uploaded', sttCount() === 0 && turnCount() === 0, result.cutoff);
  check('the ear handle is gone after MIC OFF', result.cutoff.vad === 'undefined', result.cutoff.vad);
}

if (MODE === 'pause-short' || MODE === 'pause-long') {
  await openEar();
  await sleep(26000);
  const vad = await vadSnap();
  const pageFacts = await page.evaluate(() => {
    const visitorLines = [...document.querySelectorAll('[data-testid=portal-rail-transcript] li.is-visitor')].map(
      (li) => (li.querySelector('.portal__linetext')?.textContent ?? '').trim(),
    );
    const maraLines = document.querySelectorAll('[data-testid=portal-rail-transcript] li.is-mara').length;
    return {
      merges: Number(document.querySelector('[data-testid=portal-page]')?.getAttribute('data-merges') ?? '0'),
      session: Number(document.querySelector('[data-testid=portal-page]')?.getAttribute('data-session') ?? '0'),
      visitorLines,
      maraLines,
    };
  });
  result.pause = { stt: sttCount(), turns: turnCount(), vad, page: pageFacts, sttTexts: sttBodies.map((b) => b.body?.text) };
  if (MODE === 'pause-short') {
    check('one question, one turn (no split)', turnCount() === 1 && pageFacts.visitorLines.length === 1, {
      stt: sttCount(),
      turns: turnCount(),
      texts: result.pause.sttTexts,
      transcript: pageFacts.visitorLines,
    });
  } else {
    check('the continuation was merged, not answered twice', pageFacts.merges >= 1, pageFacts);
    check('one question stands in the transcript', pageFacts.visitorLines.length === 1, pageFacts.visitorLines);
    check('one answer stands in the transcript', pageFacts.maraLines === 1, pageFacts.maraLines);
    check(
      'the merged question contains both halves',
      pageFacts.visitorLines.length === 1 &&
        /feito/i.test(pageFacts.visitorLines[0]) &&
        /hoje na casa/i.test(pageFacts.visitorLines[0]),
      pageFacts.visitorLines,
    );
  }
  check('the ear is still open afterwards', (await micNow()) === 'on');
}

result.consoleErrors = consoleErrors;
result.pageErrors = pageErrors;
result.dialogs = dialogs;
result.stt = sttBodies.map((b) => ({
  status: b.status,
  text: b.body?.text,
  language: b.body?.language,
  detected: b.body?.detectedLanguage,
  confidence: b.body?.confidence,
  sttMs: b.body?.sttMs,
}));
result.turns = turnBodies.map((b) => ({
  status: b.status,
  kind: b.body?.kind,
  language: b.body?.language,
  answer: String(b.body?.answer ?? '').slice(0, 160),
}));
result.requestPaths = requests.map((r) => r.path);
result.timings = await page.evaluate(() => ({
  ttfa: document.querySelector('[data-testid=portal-ttfa]')?.textContent ?? null,
  sttMs: document.querySelector('[data-testid=portal-stt-ms]')?.textContent ?? null,
}));
result.vad = result.vad ?? (await vadSnap());
check('zero console errors', consoleErrors.length === 0, consoleErrors);
check('zero page errors', pageErrors.length === 0, pageErrors);
check('zero dialogs', dialogs.length === 0, dialogs);

await page.screenshot({ path: path.join(OUT, `door-mode-${MODE}${DEBUG ? '-debug' : ''}.png`) });
result.passed = result.checks.every((c) => c.ok);
fs.writeFileSync(path.join(OUT, `door-mode-${MODE}${DEBUG ? '-debug' : ''}.json`), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify(
    {
      mode: MODE,
      passed: result.passed,
      failed: result.checks.filter((c) => !c.ok),
      checks: result.checks.length,
      timings: result.timings,
      vad: result.vad,
    },
    null,
    2,
  ),
);
await context.close();
await browser.close();
process.exit(result.passed ? 0 : 1);
