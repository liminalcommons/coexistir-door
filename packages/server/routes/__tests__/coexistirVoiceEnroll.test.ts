/**
 * coexistirVoiceEnroll.test.ts — speak-to-enroll over real HTTP.
 *
 * The owner's flow, end to end, with no database and no network:
 *   1. `POST /id/enroll/start` opens a supervised session for a name;
 *   2. three clips of one synthetic voice bind a print under `person:<name>`;
 *   3. a fresh clip of the same voice arrives at `/stt` → `identified`, and
 *      the following `/turn` carries the name — the voice earned it;
 *   4. a stranger's clip matches nothing → `unenrolled`, and their turn
 *      carries NO name even though a name exists elsewhere;
 *   5. re-speaking at `/id/enroll/verify` proves the binding; a stranger's
 *      clip fails it.
 *
 * Enrollment clips never touch the turn path: a turn with no ear behind it
 * stays `no_audio`, never a borrowed voice.
 */

import express from 'express';
import { mkdtempSync, rmSync } from 'fs';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCoexistirVoiceRouter } from '../coexistirVoiceRoutes';
import type { TranscribeRequest, TranscribeResult } from '../../modules/voice/deepgramStt';
import type { TaskRepositoryLike } from '../../modules/coexistir/CoexistirTaskRepository';
import { VoiceIdBus } from '../../modules/voice/voiceIdBus';
import { EnrollmentStore } from '../../modules/voice/enrollment';
import { VOICE_A, VOICE_A_AGAIN, VOICE_B, voiceWav } from '../../modules/voice/__tests__/wavFixture';

let dir: string;
let server: ReturnType<express.application.listen> | null = null;
let baseUrl = '';

const filedClaims = new Map<string, { name: string; status: 'verified' | 'unverified' }>();

function fakeTranscriber() {
  // A real provider spends ~100 ms on the wire; the fingerprint rides that
  // wait (see the three latency rules on the router). Resolving instantly
  // would test a world the door never runs in.
  const impl = (async (request: TranscribeRequest): Promise<TranscribeResult> => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return {
      ok: true,
      provider: 'deepgram',
      model: 'nova-3',
      text: 'a casa está em ordem',
      language: 'pt',
      detectedLanguage: 'pt',
      languageConfidence: 0.99,
      confidence: 0.97,
      durationSec: 2.4,
      bytes: request.audio.byteLength,
      mimetype: request.mimetype || 'audio/wav',
      sttMs: 120,
      providerMs: 120,
      status: 200,
    };
  }) as never;
  return impl;
}

async function boot(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'enroll-route-'));
  filedClaims.clear();
  const app = express();
  app.use(express.json());
  app.use(
    '/api/coexistir/voice',
    createCoexistirVoiceRouter({
      taskRepo: {
        list: async () => [],
      } as unknown as TaskRepositoryLike,
      resolveMemberName: async () => ({}),
      houseDir: dir,
      voiceBus: new VoiceIdBus(),
      transcribeImpl: fakeTranscriber(),
      resolveClaimImpl: async (voiceKey: string) => filedClaims.get(voiceKey) ?? null,
      fileEnrollClaimImpl: async (claim) => {
        filedClaims.set(claim.voiceKey, { name: claim.claimedName, status: 'verified' });
      },
      enrollStore: new EnrollmentStore(),
      sttWarmup: false,
      voiceDebug: true,
      askTalkerImpl: (async () => ({
        text: 'ok',
        model: 'test',
        talkerMs: 1,
        fallback: false,
      })) as never,
      streamTtsImpl: (async () => ({
        language: 'pt',
        modelId: 'test',
        voiceId: 'test',
        bytes: 0,
        chunks: 0,
        aborted: false,
        upstreamMs: 0,
        firstChunkMs: 0,
        headersFlushedMs: 0,
        abortMs: 0,
      })) as never,
      identity: {
        peek: (voiceKey: string) => ({
          voiceKey,
          name: null,
          claim: 'none',
          claims: 0,
          verified: 0,
          biometric: false,
          confidence: null,
          source: 'voiceKey+name-claims',
          state: 'pending',
          resolvedAt: null,
        }),
        refresh: async () => null,
        ensure: async (voiceKey: string) => ({
          voiceKey,
          name: null,
          claim: 'none',
          claims: 0,
          verified: 0,
          biometric: false,
          confidence: null,
          source: 'voiceKey+name-claims',
          state: 'pending',
          resolvedAt: null,
        }),
      },
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/coexistir/voice`;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function postJson(path: string, body: unknown, expected: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(expected);
  return (await res.json()) as Record<string, unknown>;
}

async function postWav(path: string, wav: Buffer, expected: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: wav,
  });
  expect(res.status).toBe(expected);
  return (await res.json()) as Record<string, unknown>;
}

async function enrollOwner(name = 'Test Owner'): Promise<Record<string, unknown>> {
  const started = await postJson('/id/enroll/start', { name, supervisedBy: 'owner-supervisor' }, 201);
  const enrollmentId = started.enrollmentId as string;
  expect(started.voiceKey).toBe('person:test owner');
  for (const spec of [VOICE_A, VOICE_A_AGAIN, VOICE_A]) {
    await postWav(`/id/enroll/clip?enrollmentId=${enrollmentId}`, voiceWav(spec), 201);
  }
  const bound = await postJson('/id/enroll/finish', { enrollmentId }, 201);
  return bound;
}

describe('speak-to-enroll binds a name to a voice', () => {
  it('enrolls by voice, identifies the owner, and leaves strangers nameless', async () => {
    await boot();
    const bound = await enrollOwner();
    expect(bound.status).toBe('verified');
    expect(bound.verifyReason).toBe('enrollment');
    expect(bound.voiceKey).toBe('person:test owner');
    expect(String(bound.printId)).toMatch(/^vp_/);
    expect(bound.threshold).toBe(0.82);
    expect(filedClaims.get('person:test owner')).toEqual({ name: 'Test Owner', status: 'verified' });

    // The owner's fresh clip: identified, claim resolved.
    const heard = await postWav('/stt?language=auto&room=coexistir', voiceWav({ ...VOICE_A, seed: 4242 }), 200);
    const voice = heard.voice as Record<string, unknown>;
    expect(voice.status).toBe('identified');
    expect(voice.voiceKey).toBe('person:test owner');
    expect(voice.printId).toBe(bound.printId);
    expect(Number(voice.similarity)).toBeGreaterThanOrEqual(0.82);

    const plan = await postJson('/turn', { text: String(heard.text), language: 'pt', room: 'coexistir' }, 200);
    expect(plan.speaker).toBe('Test Owner');
    expect(plan.speakerSource).toBe('claim');
    expect(plan.claim).toMatchObject({ name: 'Test Owner', status: 'verified', voiceKey: 'person:test owner' });

    // A stranger: no match, no key — and the turn carries NO name even
    // though names exist in the claims map.
    const strangerHeard = await postWav('/stt?language=auto&room=coexistir', voiceWav(VOICE_B), 200);
    const strangerVoice = strangerHeard.voice as Record<string, unknown>;
    expect(strangerVoice.status).toBe('unenrolled');
    expect(strangerVoice.voiceKey).toBeNull();
    const strangerTurn = await postJson(
      '/turn',
      { text: String(strangerHeard.text), language: 'pt', room: 'coexistir' },
      200,
    );
    expect(strangerTurn.speaker).toBeNull();
    expect(strangerTurn.claim).toBeNull();
    expect(strangerTurn.voice).toMatchObject({ status: 'unenrolled', voiceKey: null, claimStatus: 'none' });
  });

  it('verifies by re-speaking: owner passes, stranger fails', async () => {
    await boot();
    const bound = await enrollOwner();
    const voiceKey = bound.voiceKey as string;

    const owner = await postWav(
      `/id/enroll/verify?voiceKey=${encodeURIComponent(voiceKey)}`,
      voiceWav({ ...VOICE_A_AGAIN, seed: 777 }),
      200,
    );
    expect(owner.match).toBe(true);
    expect(Number(owner.similarity)).toBeGreaterThanOrEqual(0.82);

    const stranger = await postWav(
      `/id/enroll/verify?voiceKey=${encodeURIComponent(voiceKey)}`,
      voiceWav(VOICE_B),
      200,
    );
    expect(stranger.match).toBe(false);
    expect(Number(stranger.similarity)).toBeLessThan(0.82);
  });

  it('refuses a mixed-voice session and demands supervision', async () => {
    await boot();
    await postJson('/id/enroll/start', { name: '', supervisedBy: 's' }, 400);
    await postJson('/id/enroll/start', { name: 'X', supervisedBy: '' }, 400);

    const started = await postJson('/id/enroll/start', { name: 'Mixed', supervisedBy: 's' }, 201);
    const enrollmentId = started.enrollmentId as string;
    for (const spec of [VOICE_A, VOICE_B, VOICE_A]) {
      await postWav(`/id/enroll/clip?enrollmentId=${enrollmentId}`, voiceWav(spec), 201);
    }
    const refused = await postJson('/id/enroll/finish', { enrollmentId }, 422);
    expect(refused.error).toBe('inconsistent_voice');
    expect(filedClaims.has('person:mixed')).toBe(false);
  });

  it('never lends an enrollment clip to a turn', async () => {
    await boot();
    await enrollOwner();
    // No /stt since: a typed turn stands alone, voice-less.
    const plan = await postJson('/turn', { text: 'bom dia', language: 'pt', room: 'coexistir' }, 200);
    expect(plan.speaker).toBeNull();
    expect(plan.voice).toMatchObject({ status: 'no_audio' });
  });
});
