#!/usr/bin/env node
/**
 * sync-live2d-assets.mjs — put the Mao Cubism files where the client can serve them.
 *
 * WHY A SCRIPT: the Mao model is licensed under the Live2D Free Material License
 * (Live2D Original Character Licence). That licence grants publishing *derivative
 * works* with a credit line, but NOT redistribution of the raw material
 * (the .moc3 / textures as downloadable assets). So the model payload is
 * deliberately **not committed** — `packages/client/public/live2d/models/` is in
 * .gitignore — and each checkout fills it from a local copy of the official
 * sample data. The Cubism Core + Web Framework, which *are* redistributable
 * (Proprietary Software Licence / Open Software Licence), are committed.
 *
 * Usage:
 *   node scripts/live2d/sync-live2d-assets.mjs [sourceDir]
 *   LIVE2D_SAMPLES_DIR=C:/path/to/live2d-samples node scripts/live2d/sync-live2d-assets.mjs
 *
 * sourceDir must contain models/Mao/ (the official CubismWebSamples layout) or be
 * the Mao directory itself.
 */
import { cp, mkdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = path.join(repoRoot, 'packages/client/public/live2d/models/mao');

const candidates = [
  process.argv[2],
  process.env.LIVE2D_SAMPLES_DIR,
  'C:/Users/choranode/AppData/Local/hermes/profiles/coding/cache/scratch/live2d-samples',
  path.join(repoRoot, '../live2d-samples'),
].filter(Boolean);

const modelFile = 'Mao.model3.json';

async function resolveSource() {
  for (const candidate of candidates) {
    // Accept the CubismWebSamples root, its models/ dir, or the Mao dir itself.
    for (const dir of [path.join(candidate, 'Mao'), path.join(candidate, 'models', 'Mao'), candidate]) {
      if (existsSync(path.join(dir, modelFile))) return dir;
    }
  }
  throw new Error(
    `Mao model not found. Pass the live2d-samples dir as argv[2] or set LIVE2D_SAMPLES_DIR.\nLooked in:\n  ${candidates.join('\n  ')}`,
  );
}

const source = await resolveSource();
const info = await stat(source);
if (!info.isDirectory()) throw new Error(`${source} is not a directory`);

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true, force: true });

const notice = `Live2D Cubism sample model — Mao (Niziiro)
================================================

(c) Live2D Inc. Character illustration/model by the credited author.
https://www.live2d.com/en/learn/sample/

Licensed under the Live2D Free Material License Agreement v1.6 (2025-02-03)
and the Live2D Cubism Sample Data Terms of Use v1.7. Licence type:
Live2D Original Character Licence. Per-character terms: no restriction
beyond the Free Material License.

Required credit (shown in the Coexistir room UI):
  "This content uses sample data owned and copyrighted by Live2D Inc."

NOT COMMITTED ON PURPOSE
-------------------------
The Free Material License licenses derivative works, not redistribution of
the raw material: do not publish the .moc3 / textures as assets. This
directory is gitignored and is only populated for local/rig runs by
scripts/live2d/sync-live2d-assets.mjs. A public deployment must either keep
the model out of the downloadable bundle or get Live2D's written approval.

Core + Framework licences live in ../../core/LICENSE.md and
../../../../src/live2d/framework/LICENSE.md.
`;
await writeFile(path.join(target, 'NOTICE.txt'), notice, 'utf8');

console.log(`[live2d] Mao synced from ${source} -> ${target}`);
console.log('[live2d] remember: model payload is local-only (Free Material License, no raw redistribution).');
