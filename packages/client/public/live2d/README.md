# Live2D assets — what is committed, and what is not

The Coexistir room renders a real Cubism model (Mao) with the official Cubism
Web runtime. Three different licences apply; they are not interchangeable.

## Committed here

| Path | What | Licence |
|---|---|---|
| `core/live2dcubismcore.min.js` | Cubism Core 6.0.0 | Live2D **Proprietary** Software License — redistribution of this exact file is explicitly allowed (`core/RedistributableFiles.txt`) |
| `shaders/` | WebGL shader sources, Cubism SDK 5-r.5 | Live2D Open Software License |
| `../../src/live2d/framework/` | Cubism Web Framework 5-r.5 source (59 TS files), unmodified | Live2D Open Software License (`LICENSE.md`, `NOTICE.md` kept alongside) |

Core 6.0.0 (not the 5.1.0 public CDN build) is vendored on purpose: the CDN
core rejects moc3 format v6, and the bundled copy keeps the room working with
no third-party runtime fetch.

## NOT committed here

`models/mao/**` (Mao's `.moc3`, textures, motions, expressions) is
**gitignored**. The Live2D Free Material License grants publishing *derivative
works* of Live2D Original Characters with a credit line; it does not grant
redistribution of the raw material as assets. A client bundle that serves the
`.moc3` to any visitor is exactly that raw material.

Fill it locally before running the rig:

```bash
node scripts/live2d/sync-live2d-assets.mjs [C:/path/to/live2d-samples]
```

The stage reports `Rig offline` with the real error when the payload is
missing — there is no placeholder mascot.

## Required credit (already in the UI)

> This content uses sample data owned and copyrighted by Live2D Inc.

Shown in the stage footer (`CoexistirLive2DStage.css` → `.coexistir-live2d__credit`).
Do not remove it from any published build.

## Before publishing this client publicly

1. Keep `models/mao/**` out of the deployed bundle (or obtain Live2D's written
   approval to ship the raw model), **and**
2. if the operating entity's latest annual revenue is ≥ 10,000,000 JPY, obtain
   the Cubism SDK Release / Publication licences that the OSL requires for
   business publishers.

Details: `src/live2d/framework/LICENSE.md`, `core/LICENSE.md`, and
<https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html>.
