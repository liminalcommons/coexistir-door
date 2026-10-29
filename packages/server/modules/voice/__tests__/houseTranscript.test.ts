/**
 * houseTranscript.test.ts — the file seam the Hermes profile reads.
 *
 * Proves: every turn appends a row with timings + audio ref; the consult queue
 * only lists unanswered questions; a Hermes answer clears the pending row; a
 * torn last line (server killed mid-write) does not destroy history.
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  answerConsult,
  audioRefFor,
  readTurns,
  recordAudio,
  recordTurn,
  pendingConsults,
  queueConsult,
  resolveHouseDir,
} from '../houseTranscript';

let dir: string;
let store: ReturnType<typeof resolveHouseDir>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'house-'));
  store = resolveHouseDir(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('houseTranscript', () => {
  it('writes a turn row Hermes can parse, with timings and an audio ref', () => {
    recordTurn(
      {
        turnId: 't_abc',
        voiceKey: 'livekit:u123',
        speaker: 'Ana',
        language: 'pt',
        input: 'o que tem na lista hoje?',
        kind: 'hard',
        filler: 'Deixa eu conferir a lista da casa…',
        reply: 'Ana, na lista da casa: comprar café.',
        needsConsult: false,
        model: null,
        timings: { talkerMs: 0, totalMs: 12, composeMs: 4 },
        audioRef: audioRefFor('t_abc'),
      },
      store,
    );

    const lines = readFileSync(store.turnsFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]);
    expect(row).toMatchObject({
      event: 'turn',
      turnId: 't_abc',
      room: 'coexistir',
      kind: 'hard',
      needsConsult: false,
      audio: { ref: 'audio/t_abc.answer.mp3', mime: 'audio/mpeg' },
    });
    expect(row.timings.totalMs).toBe(12);
    expect(typeof row.ts).toBe('string');
  });

  it('appends audio events separately so a turn keeps its own accounting', () => {
    recordAudio(
      {
        turnId: 't_abc',
        kind: 'answer',
        language: 'pt-BR',
        modelId: 'flux-mariana-pt',
        voiceId: 'mariana',
        bytes: 4096,
        chunks: 12,
        aborted: false,
        ref: 'audio/t_abc.answer.mp3',
        timings: { firstChunkMs: 310, headersFlushedMs: 180, audioTotalMs: 900 },
      },
      store,
    );
    const rows = readTurns(store, 10);
    expect(rows).toHaveLength(0); // audio rows are not turns
    const raw = readFileSync(store.turnsFile, 'utf8').trim().split('\n');
    expect(JSON.parse(raw[0]).event).toBe('audio');
  });

  it('queues a hard question and clears it once Hermes answers', () => {
    queueConsult(
      {
        turnId: 't_hard',
        room: 'coexistir',
        question: 'a porta da frente está trancada?',
        language: 'pt',
        status: 'pending',
        reason: 'sensitive',
        flags: ['sensitive'],
        immediateReply: 'Deixa eu ver o que está aberto…',
      },
      store,
    );
    expect(pendingConsults(store)).toHaveLength(1);

    answerConsult({ turnId: 't_hard', answer: 'Está trancada; fechei às 22h.', answeredBy: 'hermes' }, store);

    const pending = pendingConsults(store);
    expect(pending).toHaveLength(0);
    const answers = readFileSync(store.answersFile, 'utf8').trim();
    expect(JSON.parse(answers)).toMatchObject({ event: 'answer', turnId: 't_hard', answeredBy: 'hermes' });
  });

  it('survives a torn last line instead of losing the log', () => {
    recordTurn(
      {
        turnId: 't_1',
        language: 'en',
        input: 'hi',
        kind: 'smalltalk',
        reply: 'Hello.',
        needsConsult: false,
      },
      store,
    );
    appendFileSync(store.turnsFile, '{"event":"turn","turnId":"t_2"', 'utf8'); // killed mid-write
    const rows = readTurns(store, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].turnId).toBe('t_1');
  });
});
