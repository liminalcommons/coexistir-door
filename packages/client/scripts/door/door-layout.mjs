/**
 * door-layout.mjs — the door at every shape the owner sees it in.
 *
 * For each viewport it loads the door twice:
 *   public   /portal            — what a visitor sees: stage, caption, MIC/CAM.
 *   debug    /portal?debug=1    — the owner's view: desktop rail (voice-ID →
 *                                 transcript → event log) or the portrait drawer.
 *
 * It asserts layout FACTS (dock on screen and never over the stage, rail present
 * only when allowed, backing store matches the CSS box, framing applied, nothing
 * scrolls off the viewport) and writes one PNG per shape for the report.
 *
 * Usage:
 *   NODE_PATH=<repo>/node_modules node door-layout.mjs --url=http://localhost:4030/portal --out=<dir>
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

const SHAPES = [
  { name: 'desktop-1440p', width: 2560, height: 1440 },
  { name: 'laptop-1366x768', width: 1366, height: 768 },
  { name: 'portrait-390x844', width: 390, height: 844 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const results = [];

for (const shape of SHAPES) {
  for (const mode of ['public', 'debug']) {
    const context = await browser.newContext({
      viewport: { width: shape.width, height: shape.height },
    });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const dialogs = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 240));
    });
    page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 240)));
    page.on('dialog', async (d) => {
      dialogs.push(`${d.type()}: ${d.message().slice(0, 100)}`);
      await d.dismiss().catch(() => undefined);
    });

    await page.goto(`${BASE}${mode === 'debug' ? '?debug=1' : ''}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=portal-mic]', { timeout: 30000 });
    await page
      .waitForFunction(
        () => document.querySelector('[data-testid=portal-stage]')?.getAttribute('data-status') === 'ready',
        null,
        { timeout: 40000 },
      )
      .catch(() => undefined);
    await sleep(1500);

    const facts = await page.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
          bottom: Math.round(r.bottom),
          right: Math.round(r.right),
          display: cs.display,
        };
      };
      const overlap = (a, b) =>
        Boolean(a && b && a.w > 0 && b.w > 0 && a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y);
      const stage = box('[data-testid=portal-stage]');
      const dock = box('.portal__dock');
      const rail = box('[data-testid=portal-rail]');
      const caption = box('[data-testid=portal-caption]');
      const canvas = document.querySelector('.portal-stage__canvas');
      const rect = canvas?.getBoundingClientRect();
      return {
        page: {
          state: document.querySelector('[data-testid=portal-page]')?.getAttribute('data-state'),
          debug: document.querySelector('[data-testid=portal-page]')?.getAttribute('data-debug'),
          scrollW: document.documentElement.scrollWidth,
          scrollH: document.documentElement.scrollHeight,
          innerW: window.innerWidth,
          innerH: window.innerHeight,
          dpr: window.devicePixelRatio,
        },
        boxes: { stage, dock, rail, caption },
        overlap: { dockStage: overlap(dock, stage) },
        railVisible: Boolean(rail && rail.display !== 'none' && rail.w > 0),
        railSections: {
          voiceId: /VOICE ID/.test(document.querySelector('[data-testid=portal-rail]')?.textContent ?? ''),
          transcript: Boolean(document.querySelector('[data-testid=portal-rail-transcript]')),
          log: Boolean(document.querySelector('[data-testid=portal-rail-log]')),
        },
        canvas: canvas
          ? {
              width: canvas.width,
              height: canvas.height,
              cssW: Math.round(rect.width),
              cssH: Math.round(rect.height),
              backing: +(canvas.width / Math.max(1, rect.width)).toFixed(3),
            }
          : null,
        rig: window.__portalRig
          ? { frames: window.__portalRig.frames(), framing: window.__portalRig.framing(), paused: window.__portalRig.paused() }
          : null,
        framingAttr: document.querySelector('[data-testid=portal-stage]')?.getAttribute('data-framing'),
        publicText: document.body.innerText,
      };
    });

    const shot = path.join(OUT, `door-layout-${shape.name}-${mode}.png`);
    await page.screenshot({ path: shot });

    const checks = [];
    const ck = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
    ck('no console errors', consoleErrors.length === 0, consoleErrors);
    ck('no page errors', pageErrors.length === 0, pageErrors);
    ck('no dialogs', dialogs.length === 0, dialogs);
    ck('fastened to the viewport (no scroll)', facts.page.scrollW <= facts.page.innerW && facts.page.scrollH <= facts.page.innerH, [facts.page.scrollW, facts.page.scrollH]);
    ck('dock is on screen', Boolean(facts.boxes.dock && facts.boxes.dock.bottom <= facts.page.innerH + 1 && facts.boxes.dock.w > 0), facts.boxes.dock);
    ck('dock never covers the stage', !facts.overlap.dockStage, facts.overlap);
    ck('canvas backing store follows its box', Boolean(facts.canvas && Math.abs(facts.canvas.backing - Math.min(facts.page.dpr, 2)) < 0.06), facts.canvas);
    ck('framing is applied', Boolean(facts.framingAttr && facts.rig), { attr: facts.framingAttr, rig: facts.rig?.framing });
    if (mode === 'public') {
      ck('public door has no rail', !facts.railVisible && facts.railSections.transcript === false && facts.railSections.log === false);
      ck('public door shows no voice-ID / transcript words', !/voiceKey|TRANSCRIPT|EVENTOS|claim/i.test(facts.publicText));
    } else {
      const wide = shape.width >= 1000;
      ck('rail is docked on the right (desktop)', wide ? facts.railVisible : true, { visible: facts.railVisible });
      ck('rail carries Voice-ID → transcript → log', facts.railSections.voiceId && facts.railSections.transcript && facts.railSections.log, facts.railSections);
    }

    results.push({
      shape: shape.name,
      mode,
      viewport: `${shape.width}x${shape.height}`,
      shot,
      facts,
      checks,
      passed: checks.every((c) => c.ok),
    });
    await context.close();
  }
}
await browser.close();

fs.writeFileSync(path.join(OUT, 'door-layout.json'), JSON.stringify({ base: BASE, results }, null, 2));
const failed = results.flatMap((r) => r.checks.filter((c) => !c.ok).map((c) => ({ shape: r.shape, mode: r.mode, ...c })));
console.log(
  JSON.stringify(
    {
      passed: failed.length === 0,
      failed,
      shapes: results.map((r) => ({
        shape: r.shape,
        mode: r.mode,
        ok: r.passed,
        stage: r.facts.boxes.stage && `${r.facts.boxes.stage.w}x${r.facts.boxes.stage.h}`,
        canvas: r.facts.canvas,
        framing: r.facts.framingAttr,
        rail: r.facts.railVisible,
      })),
    },
    null,
    2,
  ),
);
process.exit(failed.length === 0 ? 0 : 1);
