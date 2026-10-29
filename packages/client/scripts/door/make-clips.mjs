/**
 * make-clips.mjs — stage the audio the behavioural probes replay.
 *
 * The probes need WAVs, and two of them can be synthesized exactly:
 *
 *   silence.wav  40 s of room tone (a very quiet 60 Hz rumble), for the "she
 *                waits, indefinitely, and says nothing" mode;
 *   ramp.wav     30 s, 1 kHz tone rising 0.05 → 0.85 amplitude, for the capture
 *                probe (amplitude encodes position in the clip, so skipped audio
 *                shows as drift).
 *
 * The four SPEECH clips cannot be synthesized here without a TTS key: they are
 * the visitor's actual Portuguese questions, and the probe's whole point is that
 * Deepgram transcribes them. `--copy-from=<dir>` stages an existing set (the rig
 * that produced the P1 evidence keeps them next to its probe JSONs); otherwise
 * this script prints the exact texts from clips.json so they can be recorded or
 * re-synthesized.
 *
 * Usage:
 *   node make-clips.mjs --clips=./clips
 *   node make-clips.mjs --clips=./clips --copy-from=<rig-folder>
 */
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
const CLIPS = args.clips || path.join(HERE, 'clips');
fs.mkdirSync(CLIPS, { recursive: true });

function writeWav(file, seconds, rate, sampleAt) {
  const n = Math.round(rate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    const v = Math.max(-1, Math.min(1, sampleAt(i / rate, i)));
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
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

// 1 kHz tone, amplitude ramping 0.05 → 0.85 across 30 s.
writeWav(path.join(CLIPS, 'ramp.wav'), 30, 48000, (t) => {
  const amp = 0.05 + 0.8 * (t / 30);
  return amp * Math.sin(2 * Math.PI * 1000 * t);
});

// 40 s of "room": a very quiet low rumble, never above the VAD floor.
writeWav(path.join(CLIPS, 'silence.wav'), 40, 48000, (t) => 0.0015 * Math.sin(2 * Math.PI * 60 * t));

const speech = [
  'door-handsfree.wav',
  'door-bargein.wav',
  'door-deaf.wav',
  'door-silence.wav',
  'door-pause-short.wav',
  'door-pause-long.wav',
];

if (args['copy-from']) {
  for (const file of speech) {
    const from = path.join(args['copy-from'], file);
    if (!fs.existsSync(from)) {
      console.warn(`missing in source: ${from}`);
      continue;
    }
    fs.copyFileSync(from, path.join(CLIPS, file));
    console.log(`staged ${file}`);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'clips.json'), 'utf8'));
const missing = manifest.clips.map((c) => c.file).filter((f) => !fs.existsSync(path.join(CLIPS, f)));
console.log(
  JSON.stringify(
    {
      clips: CLIPS,
      synthesized: ['ramp.wav', 'silence.wav'],
      missingSpeech: missing,
      need: missing.length
        ? 'Stage a clip set with --copy-from=<rig folder>, or record the texts in clips.json (one Portuguese question per file, padded with ~1.5 s of silence).'
        : 'all clips present',
    },
    null,
    2,
  ),
);
