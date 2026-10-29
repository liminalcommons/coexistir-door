/**
 * door-audio-capture.mjs — does the door's ear lose audio when the page stalls?
 *
 * The AudioWorklet change (review #5) exists because capture used to run on a
 * ScriptProcessorNode, whose callback only runs when the main thread is free. On
 * the old build, a 400 ms / 1.5 s / 3 s main-thread stall produced 0.36 s / 1.47 s
 * / 2.98 s in which the VAD saw NO frames at all: a barge-in started inside that
 * window was heard that much later, and an end of speech inside it was stamped
 * that much late.
 *
 * The probe measures that directly, on whatever build the rig is serving:
 *
 *   1. headless Chromium, fake capture device fed from a 30 s ramp WAV that this
 *      script generates itself (a 1 kHz tone rising linearly 0.05 → 0.85, so
 *      AMPLITUDE ENCODES POSITION IN THE CLIP);
 *   2. MIC on, then a fixed main-thread load (--load=1) and/or one long stall
 *      (--stall=400), which is what a bigger Live2D stage does to the same thread;
 *   3. the app's own capture path is instrumented: every `onaudioprocess`
 *      callback on a ScriptProcessor build, `__portalVad.snapshot()` counters on
 *      an AudioWorklet build;
 *   4. drift = (seconds of clip consumed) − (seconds elapsed). Audio that was
 *      skipped shows up as drift; a blind window shows up as (elapsed − delivered)
 *      = deficit; queue lag shows up as lateMs.
 *
 * Usage:
 *   NODE_PATH=<repo>/node_modules node door-audio-capture.mjs --label=worklet --load=1 --stall=400
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
const LOAD = args.load === '1';
const STALL_MS = Number(args.stall || 0);
const WARM_S = Number(args.warm || 5);
const TAIL_S = Number(args.tail || 5);
const LABEL = args.label || `capture-${LOAD ? 'load' : 'quiet'}${STALL_MS ? `-stall${STALL_MS}` : ''}`;
const A0 = 0.05;
const A1 = 0.85;
const RAMP_S = 30;
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the ramp clip, generated here so the probe has no binary dependency -----
const RAMP = path.join(OUT, 'ramp.wav');
if (!fs.existsSync(RAMP) || args.regen === '1') {
  const rate = 48000;
  const n = rate * RAMP_S;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    const amp = A0 + (A1 - A0) * (t / RAMP_S);
    const v = Math.max(-1, Math.min(1, amp * Math.sin(2 * Math.PI * 1000 * t)));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(RAMP, Buffer.concat([header, data]));
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${RAMP}`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
  ],
});
const context = await browser.newContext({
  viewport: { width: Number(args.w || 2560), height: Number(args.h || 1440) },
  permissions: ['microphone', 'camera'],
});

// Instrumentation, installed before the app runs.
await context.addInitScript(() => {
  window.__sp = { nodes: 0, cbs: [] };
  // The ramp encodes position in AMPLITUDE, so turn the DSP stages off for this
  // stream: AGC would flatten the ramp and NS/EC would reshape a pure tone. The
  // app's capture node and callbacks are untouched — scheduling is what is under
  // test here, not the DSP.
  const md = navigator.mediaDevices;
  if (md && typeof md.getUserMedia === 'function') {
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = (constraints) =>
      orig(
        constraints && constraints.audio
          ? {
              ...constraints,
              audio: {
                ...(typeof constraints.audio === 'object' ? constraints.audio : {}),
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
              },
            }
          : constraints,
      );
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const createSp = Ctx.prototype.createScriptProcessor;
  if (typeof createSp !== 'function') return;
  Ctx.prototype.createScriptProcessor = function patched(...a) {
    const node = createSp.apply(this, a);
    window.__sp.nodes += 1;
    queueMicrotask(() => {
      const fn = node.onaudioprocess;
      if (typeof fn !== 'function') return;
      node.onaudioprocess = (ev) => {
        const data = ev.inputBuffer.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < data.length; i += 1) {
          const v = Math.abs(data[i]);
          if (v > peak) peak = v;
        }
        window.__sp.cbs.push({ t: performance.now(), peak, size: data.length });
        return fn.call(node, ev);
      };
    });
    return node;
  };
});

const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 240));
});
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 240)));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid=portal-mic]', { timeout: 30000 });
await sleep(2500);
await page.locator('[data-testid=portal-mic]').click({ force: true });
await page.waitForFunction(
  () => document.querySelector('[data-testid=portal-page]')?.getAttribute('data-mic') === 'on',
  null,
  { timeout: 15000 },
);
await sleep(1000);

const buildId = (await page.evaluate(async () => (await fetch('/build-id.txt')).text())).trim();
const mode = await page.evaluate(() => window.__portalVad?.snapshot?.().mode ?? 'script');

await page.evaluate(() => {
  window.__cap = [];
  window.__capTimer = setInterval(() => {
    const s = window.__portalVad?.snapshot?.();
    if (!s) return;
    window.__cap.push({ t: performance.now(), peak: s.peak ?? null });
  }, 25);
});

if (LOAD) {
  await page.evaluate(() => {
    window.__jank = { ticks: 0, blockedMs: 0 };
    const burn = (ms) => {
      const t0 = performance.now();
      let x = 1;
      while (performance.now() - t0 < ms) x += Math.sqrt(x);
      return performance.now() - t0;
    };
    window.__jankTimer = setInterval(() => {
      window.__jank.blockedMs += burn(20);
      window.__jank.ticks += 1;
    }, 120);
    const loop = () => {
      window.__jank.blockedMs += burn(6);
      window.__jank.raf = (window.__jank.raf || 0) + 1;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}

await sleep(WARM_S * 1000);
let stall = null;
if (STALL_MS > 0) {
  stall = await page.evaluate((ms) => {
    const t0 = performance.now();
    let x = 1;
    while (performance.now() - t0 < ms) x += Math.sqrt(x);
    return { at: Math.round(t0), blockedMs: Math.round(performance.now() - t0) };
  }, STALL_MS);
}
await sleep(TAIL_S * 1000);

const raw = await page.evaluate(() => ({
  sp: window.__sp ? { nodes: window.__sp.nodes, cbs: window.__sp.cbs } : null,
  cap: window.__cap,
  jank: window.__jank ?? null,
  snap: window.__portalVad?.snapshot?.() ?? null,
}));

const posOf = (peak) => ((peak - A0) / (A1 - A0)) * RAMP_S;
function drift(series) {
  const out = [];
  let base = null;
  let lastPos = null;
  let wrap = 0;
  for (const s of series) {
    if (!Number.isFinite(s.peak) || s.peak <= 0) continue;
    let p = posOf(Math.min(s.peak, A1)) - wrap;
    if (lastPos !== null && p < lastPos - 1) {
      wrap += RAMP_S; // the fake device looped the clip
      p += RAMP_S;
    }
    lastPos = p;
    if (base === null) base = p - s.t / 1000;
    out.push({ t: s.t, driftMs: (p - s.t / 1000 - base) * 1000 });
  }
  return out;
}

const blockMs = raw.snap?.frameSize
  ? (raw.snap.frameSize / (raw.snap.sampleRate || 48000)) * 1000
  : raw.sp?.cbs?.[0]
    ? (raw.sp.cbs[0].size / 44100) * 1000
    : 0;

const series =
  mode === 'worklet'
    ? raw.cap.filter((c) => c.peak !== null).map((c) => ({ t: c.t, peak: c.peak }))
    : (raw.sp?.cbs ?? []).map((c) => ({ t: c.t, peak: c.peak }));
const d = drift(series);
const maxDrift = d.reduce((m, p) => Math.max(m, Math.abs(p.driftMs)), 0);
const endDrift = d.length ? d[d.length - 1].driftMs : 0;

let gaps = 0;
let gapMs = 0;
let maxGapMs = 0;
let maxDeficit = 0;
for (let i = 1; i < series.length; i += 1) {
  const dt = series[i].t - series[i - 1].t;
  if (blockMs > 0 && dt > blockMs * 1.5) {
    gaps += 1;
    gapMs += dt - blockMs;
    maxGapMs = Math.max(maxGapMs, dt);
  }
}
for (let i = 0; i < series.length; i += 1) {
  maxDeficit = Math.max(maxDeficit, series[i].t - series[0].t - (i + 1) * blockMs);
}

const result = {
  label: LABEL,
  url: BASE,
  buildId,
  mode,
  load: LOAD,
  stallMs: STALL_MS,
  stall,
  viewport: `${args.w || 2560}x${args.h || 1440}`,
  blockMs: Math.round(blockMs * 100) / 100,
  capture: {
    source: mode === 'worklet' ? 'snapshot(peak)@25ms' : 'onaudioprocess(peak)',
    samples: series.length,
    seconds: series.length ? Math.round((series[series.length - 1].t - series[0].t) / 10) / 100 : 0,
    gaps,
    gapMs: Math.round(gapMs),
    maxGapMs: Math.round(maxGapMs),
    maxDeficitMs: Math.round(Math.max(0, maxDeficit)),
    maxDriftMs: Math.round(maxDrift),
    endDriftMs: Math.round(endDrift),
  },
  app: {
    blocks: raw.snap?.blocks ?? raw.sp?.cbs?.length ?? null,
    expectedBlocks: raw.snap?.expectedBlocks ?? null,
    droppedMs: raw.snap?.droppedMs ?? null,
    gaps: raw.snap?.gaps ?? null,
    maxGapMs: raw.snap?.maxGapMs ?? null,
    lateMs: raw.snap?.lateMs ?? null,
    onsets: raw.snap?.onsets ?? null,
    sent: raw.snap?.sent ?? null,
    discarded: raw.snap?.discarded ?? null,
  },
  jank: raw.jank,
  checks: [
    { name: 'no console errors', ok: consoleErrors.length === 0, detail: consoleErrors },
    { name: 'no page errors', ok: pageErrors.length === 0, detail: pageErrors },
    {
      name: 'no audio content skipped (drift < 120 ms)',
      ok: Math.abs(endDrift) < 120,
      detail: { endDriftMs: Math.round(endDrift), maxDriftMs: Math.round(maxDrift) },
    },
  ],
  consoleErrors,
  pageErrors,
};
result.passed = result.checks.every((c) => c.ok);
fs.writeFileSync(path.join(OUT, `door-audio-${LABEL}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
process.exit(result.passed ? 0 : 1);
