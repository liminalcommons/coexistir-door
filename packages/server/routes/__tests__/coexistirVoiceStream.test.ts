/**
 * coexistirVoiceStream.test.ts — the relay's wire contract.
 *
 * Everything here runs over a REAL WebSocket on an ephemeral port, with the
 * Deepgram side faked at `openStreamImpl`. That is deliberate: the two things
 * that can break in production are the handshake path (does our upgrade steal
 * Colyseus's sockets?) and the frame protocol (does `speech_final` become
 * exactly one `turn`?) — and neither is exercised by unit-testing the session
 * class alone.
 */

import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Duplex } from 'stream';
import { WebSocket } from 'ws';
import {
  STT_STREAM_PATH,
  attachCoexistirSttStream,
  createSttStreamRelay,
  sttStreamInfo,
} from '../coexistirVoiceStream';
import type { StreamEvent, StreamTransport, StreamTransportOptions } from '../../modules/voice/deepgramStream';
import { resolveHouseDir } from '../../modules/voice/houseTranscript';

/** A throwaway house dir: tests must never write into the repo. */
const tmpDirs: string[] = [];
function tempStore(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stt-stream-${name}-`));
  tmpDirs.push(dir);
  return resolveHouseDir(dir);
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/**
 * A fake Deepgram socket: it records what we sent and lets the test fire
 * provider frames at whatever the relay registered.
 */
function fakeUpstream() {
  const audio: Uint8Array[] = [];
  const controls: string[] = [];
  let options: StreamTransportOptions | null = null;
  let closed = 0;

  const open = (next: StreamTransportOptions): StreamTransport => {
    options = next;
    setImmediate(() => next.onOpen?.());
    const transport: StreamTransport = {
      send: (bytes) => {
        audio.push(bytes);
        return bytes.byteLength;
      },
      finalize: () => controls.push('finalize'),
      keepAlive: () => controls.push('keepalive'),
      close: () => {
        closed += 1;
      },
      bytesIn: 0,
      opened: true,
      closed: false,
      audioMs: 0,
    };
    return transport;
  };

  return {
    open,
    audio,
    controls,
    get closedCount() {
      return closed;
    },
    emit(event: StreamEvent) {
      options?.onEvent(event);
    },
    error(message: string) {
      options?.onError?.(message);
    },
  };
}

const finalEvent = (text: string, speechFinal: boolean, wordsEndSec: number | null = 2): StreamEvent => ({
  type: 'final',
  text,
  audioSec: 2.2,
  speechFinal,
  wordsEndSec,
  detectedLanguage: 'pt',
  languageConfidence: 0.99,
  confidence: 0.96,
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

interface Client {
  socket: WebSocket;
  messages: Array<Record<string, unknown>>;
  waitFor: (t: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  closed: Promise<void>;
}

async function connect(port: number, path = STT_STREAM_PATH): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  socket.binaryType = 'arraybuffer';
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<{ t: string; resolve: (value: Record<string, unknown>) => void }> = [];

  socket.on('message', (raw: Buffer) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    } catch {
      return;
    }
    messages.push(parsed);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].t === parsed.t) {
        waiters[i].resolve(parsed);
        waiters.splice(i, 1);
      }
    }
  });

  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
  // A server that destroys an unknown upgrade path makes the client emit
  // 'error' first; that is the behaviour under test, not a failure.
  socket.on('error', () => undefined);

  return {
    socket,
    messages,
    closed,
    waitFor(t, timeoutMs = 3000) {
      const found = messages.find((m) => m.t === t);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${t}`)), timeoutMs);
        waiters.push({
          t,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
        });
      });
    },
  };
}

describe('sttStreamInfo', () => {
  it('reports the streaming path, endpointing numbers and availability', () => {
    const bodies: Array<Record<string, unknown>> = [];
    sttStreamInfo((body) => bodies.push(body), { apiKey: 'k' });
    expect(bodies[0]).toMatchObject({
      ok: true,
      available: true,
      mode: 'stream',
      path: STT_STREAM_PATH,
      encoding: 'linear16',
      endpointing: 500,
      utteranceEndMs: 1000,
      endOfTurn: 'provider-endpointing',
    });
  });

  it('says it is unavailable when there is no key, so the door keeps the batch ear', () => {
    const bodies: Array<Record<string, unknown>> = [];
    sttStreamInfo((body) => bodies.push(body), { apiKey: '' });
    expect(bodies[0].available).toBe(false);
  });
});

describe('createSttStreamRelay', () => {
  it('turns provider endpointing into exactly one turn, over a real socket', async () => {
    const upstream = fakeUpstream();
    const store = tempStore('relay');
    const relay = createSttStreamRelay({
      openStreamImpl: upstream.open,
      apiKey: 'test-key',
      store,
      logger: () => undefined,
    });
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => relay.upgrade(req, socket as Duplex, head));
    const port = await listen(server);
    const client = await connect(port);

    const ready = await client.waitFor('ready');
    expect(ready).toMatchObject({ mode: 'stream', endpointing: 500, sampleRate: 16000 });

    // 100 ms of 16 kHz mono PCM.
    client.socket.send(Buffer.alloc(3200, 1));
    await new Promise((r) => setTimeout(r, 50));
    expect(upstream.audio).toHaveLength(1);

    upstream.emit(finalEvent('quais são as tarefas', false, 1.2));
    upstream.emit(finalEvent('abertas', true, 2));
    const turn = await client.waitFor('turn');
    expect(turn.text).toBe('quais são as tarefas abertas');
    expect(turn.by).toBe('speech_final');
    expect(turn.mode).toBe('stream');
    expect(turn.audio).toMatchObject({ lastWordEndMs: 2000 });
    expect(typeof turn.sttMs).toBe('number');

    // The late UtteranceEnd must NOT produce a second turn.
    upstream.emit({ type: 'utterance_end', audioSec: 2, lastWordEndSec: 2 });
    await new Promise((r) => setTimeout(r, 50));
    expect(client.messages.filter((m) => m.t === 'turn')).toHaveLength(1);

    client.socket.close();
    await client.closed;
    await relay.close();
    await new Promise((r) => server.close(r));
  });

  it('drops a half-spoken clip on reset, so mic-off cannot become a question', async () => {
    const upstream = fakeUpstream();
    const relay = createSttStreamRelay({
      openStreamImpl: upstream.open,
      apiKey: 'test-key',
      store: tempStore('reset'),
      logger: () => undefined,
    });
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => relay.upgrade(req, socket as Duplex, head));
    const port = await listen(server);
    const client = await connect(port);
    await client.waitFor('ready');

    client.socket.send(Buffer.alloc(1600, 1));
    upstream.emit(finalEvent('não quero', false, 0.5));
    client.socket.send(JSON.stringify({ t: 'reset' }));
    await new Promise((r) => setTimeout(r, 50));

    upstream.emit(finalEvent('', true, 0.5));
    upstream.emit({ type: 'utterance_end', audioSec: 0.5, lastWordEndSec: 0.5 });
    await new Promise((r) => setTimeout(r, 80));
    expect(client.messages.filter((m) => m.t === 'turn')).toHaveLength(0);

    client.socket.close();
    await client.closed;
    await relay.close();
    await new Promise((r) => server.close(r));
  });

  it('relays interims before the turn so the door can show it is hearing', async () => {
    const upstream = fakeUpstream();
    const relay = createSttStreamRelay({
      openStreamImpl: upstream.open,
      apiKey: 'test-key',
      store: tempStore('interim'),
      logger: () => undefined,
    });
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => relay.upgrade(req, socket as Duplex, head));
    const port = await listen(server);
    const client = await connect(port);
    await client.waitFor('ready');

    upstream.emit({ type: 'interim', text: 'quais', audioSec: 0.4 });
    const interim = await client.waitFor('interim');
    expect(interim).toMatchObject({ text: 'quais', audioMs: 400 });

    client.socket.close();
    await client.closed;
    await relay.close();
    await new Promise((r) => server.close(r));
  });

  it('closes the socket (and tells the page) when there is no provider key', async () => {
    const relay = createSttStreamRelay({
      apiKey: '',
      store: tempStore('nokey'),
      logger: () => undefined,
    });
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => relay.upgrade(req, socket as Duplex, head));
    const port = await listen(server);
    const client = await connect(port);

    const error = await client.waitFor('error');
    expect(error).toMatchObject({ code: 'no_key' });
    await client.closed;

    await relay.close();
    await new Promise((r) => server.close(r));
  });
});

describe('attachCoexistirSttStream', () => {
  it('leaves the existing upgrade listeners working (Colyseus keeps its rooms)', async () => {
    const seen: string[] = [];
    const server = http.createServer();
    // Stand-in for the Colyseus transport's own upgrade listener.
    server.on('upgrade', (req, socket) => {
      seen.push(req.url || '');
      socket.destroy();
    });

    const { detach, relay } = attachCoexistirSttStream(server, {
      apiKey: 'test-key',
      openStreamImpl: fakeUpstream().open,
      logger: () => undefined,
    });
    const port = await listen(server);

    // A Castalia room handshake still reaches the listener that was there first.
    const other = await connect(port, '/castalia/PUBLIC/room-123');
    await other.closed;
    expect(seen).toEqual(['/castalia/PUBLIC/room-123']);

    // Our own path goes to the relay instead.
    const ours = await connect(port);
    expect(await ours.waitFor('ready')).toMatchObject({ mode: 'stream' });
    expect(seen).toHaveLength(1);
    ours.socket.close();
    await ours.closed;

    detach();
    await relay.close();
    await new Promise((r) => server.close(r));
  });
});
