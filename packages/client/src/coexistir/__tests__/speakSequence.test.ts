/**
 * speakSequence.test.ts — filler-before-answer ordering on the client.
 *
 * The room must never start the real answer until the filler has finished
 * speaking. This pins that contract at the controller level, with a fake
 * progressive player so no audio or network is involved.
 */

import { AgentVoiceController } from '../agentVoice';
import type { RealtimeVoicePlayer, RealtimeStartResult, StopResult } from '../realtimeVoice';

interface Call {
  text: string;
  endedAwaited: number;
}

function fakePlayer(log: Call[]) {
  let current: Call | null = null;
  const player = {
    isActive: true,
    async speak(text: string): Promise<RealtimeStartResult> {
      current = { text, endedAwaited: 0 };
      log.push(current);
      return { ok: true, mode: 'progressive', language: 'pt-BR', modelId: 'flux-mariana-pt' };
    },
    async whenEnded(): Promise<void> {
      if (current) current.endedAwaited += 1;
    },
    stop(): StopResult {
      return { aborted: true, reason: 'test', playedMs: 0, teardownMs: 0 };
    },
  };
  return player as unknown as RealtimeVoicePlayer;
}

describe('AgentVoiceController.speakSequence', () => {
  it('speaks the filler to completion before the answer starts', async () => {
    const log: Call[] = [];
    const controller = new AgentVoiceController({
      storage: null,
      transport: 'stream',
      realtime: fakePlayer(log),
      fetchImpl: (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch,
    });

    const results = await controller.speakSequence(
      [
        { text: 'Deixa eu conferir a lista da casa…', kind: 'filler' },
        { text: 'Na lista da casa: comprar café.', kind: 'answer' },
      ],
      { language: 'pt-BR' },
    );

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.spoken)).toBe(true);
    expect(log.map((c) => c.text)).toEqual([
      'Deixa eu conferir a lista da casa…',
      'Na lista da casa: comprar café.',
    ]);
    // The first step was awaited to its end before the second was requested.
    expect(log[0].endedAwaited).toBe(1);
  });

  it('stops the plan when a step cannot be spoken', async () => {
    const log: Call[] = [];
    const controller = new AgentVoiceController({
      storage: null,
      transport: 'stream',
      realtime: fakePlayer(log),
      fetchImpl: (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch,
    });
    // Turn the toggle off mid-plan: the second speak() must not fire.
    const original = controller.speak.bind(controller);
    let calls = 0;
    controller.speak = async (text, options) => {
      calls += 1;
      if (calls === 2) return { spoken: false, phase: 'disabled', reason: 'disabled' };
      return original(text, options);
    };

    const results = await controller.speakSequence([
      { text: 'Deixa eu conferir…' },
      { text: 'Resposta' },
      { text: 'Nunca falado' },
    ]);

    expect(results).toHaveLength(2);
    expect(log.map((c) => c.text)).toEqual(['Deixa eu conferir…']);
  });
});
