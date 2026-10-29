/**
 * proofSttStream.helpers.ts — the two pieces the proof needs that already exist
 * in the app, re-exported so the probe measures the SHIPPING code:
 *
 *   transcribeAudio  — the batch ear the streaming path replaces.
 *   encodeWavForProof — the door's own WAV encoder (`portalVad.encodeWav`), so
 *                       the clip the batch path sees is byte-for-byte the clip
 *                       the door would have posted.
 */

import { encodeWav } from '../../client/src/portal/portalVad';

export { transcribeAudio } from '../modules/voice/deepgramStt';

/** 16-bit PCM parts -> the WAV bytes the door's batch ear would upload. */
export async function encodeWavForProof(
  pcm: Int16Array[],
  inputRate: number,
  outRate: number,
): Promise<Buffer> {
  const parts = pcm.map((part) => {
    const floats = new Float32Array(part.length);
    for (let i = 0; i < part.length; i += 1) floats[i] = part[i] / 32768;
    return floats;
  });
  const blob = encodeWav(parts, inputRate, outRate);
  return Buffer.from(await blob.arrayBuffer());
}
