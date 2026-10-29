/**
 * Tests for name-that-voice client logic: stranger detection + voiceKey
 * derivation (voiceIdentityUtils), the owl-speaker topic hook, the claims
 * cache hook, and the NameThisVoiceDialog filing flow.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
// jsdom test env does not provide TextEncoder/TextDecoder as globals here;
// real browsers always have both — polyfill from Node's util.
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';
(globalThis as any).TextEncoder ??= NodeTextEncoder;
(globalThis as any).TextDecoder ??= NodeTextDecoder;
const enc = (o: any) => new NodeTextEncoder().encode(JSON.stringify(o));
import {
  isStrangerTile,
  voiceKeyForTile,
  pickDisplayClaim,
  isGuestSpeakerLabel,
  voiceFingerprintShortHash,
} from '../voiceIdentityUtils';

jest.mock('livekit-client', () => ({
  RoomEvent: { DataReceived: 'dataReceived' },
}));

import { useOwlSpeakerLabels, OWL_SPEAKER_TOPIC, OWL_SPEAKING_TTL_MS } from '../useOwlSpeakerLabels';
import {
  useVoiceNameClaims,
  invalidateVoiceClaims,
  __clearVoiceClaimsCacheForTests,
} from '../useVoiceNameClaims';

describe('voiceIdentityUtils', () => {
  it('flags unnamed tiles as stranger even without an Owl label', () => {
    expect(isStrangerTile({ name: '' }, null)).toBe(true);
    expect(isStrangerTile({ name: undefined }, null)).toBe(true);
    expect(isStrangerTile({ name: '   ' }, null)).toBe(true);
  });

  it('flags named tiles with a stranger label as stranger', () => {
    expect(isStrangerTile({ name: 'Guest-4821' }, { stranger: true })).toBe(true);
  });

  it('named tiles without a stranger label are not stranger', () => {
    expect(isStrangerTile({ name: 'Zoe' }, null)).toBe(false);
    expect(isStrangerTile({ name: 'Zoe' }, { stranger: false })).toBe(false);
  });

  it('never builds a voiceKey from a guest voiceprint', () => {
    expect(isGuestSpeakerLabel('guest')).toBe(true);
    expect(voiceKeyForTile({ owlSpeaker: 'guest', livekitIdentity: 'id-1' })).toBe('livekit:id-1');
    expect(voiceKeyForTile({ owlSpeaker: 'spk_07', livekitIdentity: 'id-1' })).toBe('owl:spk_07');
    expect(voiceKeyForTile({ livekitIdentity: 'id-1' })).toBe('livekit:id-1');
  });

  it('pickDisplayClaim prefers verified, else latest unverified', () => {
    expect(pickDisplayClaim([])).toBeNull();
    const rows = [
      { voiceKey: 'k', claimedName: 'Max', claimBy: 'a', status: 'unverified' as const },
      { voiceKey: 'k', claimedName: 'Zoe', claimBy: 'b', status: 'unverified' as const },
    ];
    expect(pickDisplayClaim(rows)?.claimedName).toBe('Zoe');
    const withVerified = [
      ...rows,
      { voiceKey: 'k', claimedName: 'Max', claimBy: 'c', status: 'verified' as const },
    ];
    expect(pickDisplayClaim(withVerified)?.status).toBe('verified');
  });
});

// ── Fake LiveKit room ────────────────────────────────────────────────────────

class FakeRoom {
  handlers = new Map<string, Set<(...a: any[]) => void>>();
  on(evt: string, fn: (...a: any[]) => void) {
    if (!this.handlers.has(evt)) this.handlers.set(evt, new Set());
    this.handlers.get(evt)!.add(fn);
  }
  off(evt: string, fn: (...a: any[]) => void) { this.handlers.get(evt)?.delete(fn); }
  emit(evt: string, ...args: any[]) { this.handlers.get(evt)?.forEach((fn) => fn(...args)); }
}

function LabelProbe({ room }: { room: any }) {
  const { getLabel, labelsVersion } = useOwlSpeakerLabels(room);
  const label = getLabel('zoe-livekit-id');
  return (
    <div>
      <span data-testid="version">{labelsVersion}</span>
      <span data-testid="speaker">{label?.speaker ?? 'none'}</span>
      <span data-testid="stranger">{String(!!label?.stranger)}</span>
    </div>
  );
}

describe('useOwlSpeakerLabels', () => {
  it('ignores other topics and surfaces owl-speaker labels by participant', () => {
    const room = new FakeRoom();
    render(<LabelProbe room={room as any} />);
    expect(screen.getByTestId('speaker')).toHaveTextContent('none');

    act(() => {
      room.emit('dataReceived', enc({ speaker: 'x', stranger: false }), { identity: 'someone' }, 0, 'chat-and-transcript');
    });
    expect(screen.getByTestId('speaker')).toHaveTextContent('none');

    act(() => {
      room.emit(
        'dataReceived',
        enc({ speaker: 'spk_07', score: 0.9, stranger: true, margin: 0.2, participantIdentity: 'zoe-livekit-id' }),
        { identity: 'owl-worker' },
        0,
        OWL_SPEAKER_TOPIC,
      );
    });
    expect(screen.getByTestId('speaker')).toHaveTextContent('spk_07');
    expect(screen.getByTestId('stranger')).toHaveTextContent('true');
    expect(Number(screen.getByTestId('version').textContent)).toBeGreaterThan(0);
  });

  it('drops malformed payloads without crashing', () => {
    const room = new FakeRoom();
    render(<LabelProbe room={room as any} />);
    act(() => {
      room.emit('dataReceived', new NodeTextEncoder().encode('not-json{{{'), { identity: 'owl' }, 0, OWL_SPEAKER_TOPIC);
    });
    expect(screen.getByTestId('speaker')).toHaveTextContent('none');
  });
});

describe('useVoiceNameClaims cache', () => {
  const realFetch = global.fetch;

  function ClaimsProbe({ voiceKey }: { voiceKey: string | null }) {
    const { claims, loading } = useVoiceNameClaims(voiceKey);
    return (
      <div>
        <span data-testid="loading">{String(loading)}</span>
        <span data-testid="count">{claims.length}</span>
        <span data-testid="first">{claims[0]?.claimedName ?? 'none'}</span>
      </div>
    );
  }

  beforeEach(() => {
    __clearVoiceClaimsCacheForTests();
  });

  afterEach(() => {
    (global as any).fetch = realFetch;
  });

  it('fetches once per voiceKey and serves the second mount from cache', async () => {
    let calls = 0;
    (global as any).fetch = jest.fn(async () => {
      calls++;
      return { ok: true, text: async () => JSON.stringify({ claims: [{ claimedName: 'Zoe', claimBy: 'luiz', status: 'unverified' }] }) };
    });
    const { unmount } = render(<ClaimsProbe voiceKey="owl:spk_07" />);
    await waitFor(() => expect(screen.getByTestId('first')).toHaveTextContent('Zoe'));
    expect(calls).toBe(1);
    unmount();
    render(<ClaimsProbe voiceKey="owl:spk_07" />);
    await waitFor(() => expect(screen.getByTestId('first')).toHaveTextContent('Zoe'));
    expect(calls).toBe(1); // cache hit — no second fetch
  });

  it('refetches a mounted hook when a claim is filed elsewhere for the same voice', async () => {
    let rows: any[] = [];
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ claims: rows }),
    }));

    render(<ClaimsProbe voiceKey="owl:spk_11" />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));

    // Another component (the tile overlay's dialog) files the claim.
    rows = [{ claimedName: 'Nina', claimBy: 'CoexistirTester', status: 'unverified' }];
    act(() => {
      invalidateVoiceClaims('owl:spk_11');
    });

    await waitFor(() => expect(screen.getByTestId('first')).toHaveTextContent('Nina'));
  });

  it('ignores invalidation aimed at a different voiceKey', async () => {
    let calls = 0;
    (global as any).fetch = jest.fn(async () => {
      calls++;
      return { ok: true, text: async () => JSON.stringify({ claims: [] }) };
    });
    render(<ClaimsProbe voiceKey="owl:spk_07" />);
    await waitFor(() => expect(calls).toBe(1));
    act(() => {
      invalidateVoiceClaims('owl:spk_11');
    });
    expect(calls).toBe(1);
  });
});

describe('NameThisVoiceDialog', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    (global as any).fetch = realFetch;
    __clearVoiceClaimsCacheForTests();
  });

  it('files a claim and shows the unverified marker', async () => {
    const calls: any[] = [];
    (global as any).fetch = jest.fn(async (url: string, init?: any) => {
      calls.push({ url, init });
      if (init?.method === 'POST') {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({ claim: { _id: 'c1', voiceKey: 'livekit:abc', claimedName: 'Zoe', claimBy: 'luiz', status: 'unverified' } }),
        };
      }
      return { ok: true, text: async () => JSON.stringify({ claims: [] }) };
    });

    const { NameThisVoiceDialog } = await import('../NameThisVoiceDialog');
    const onFiled = jest.fn();
    const onClose = jest.fn();
    render(
      <NameThisVoiceDialog voiceKey="livekit:abc" livekitIdentity="abc" claimByDefault="luiz" onClose={onClose} onFiled={onFiled} />,
    );

    await waitFor(() => expect(screen.getByTestId('name-voice-dialog')).toBeInTheDocument());
    expect(screen.getByText(/name claim/i)).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('name-voice-input'), { target: { value: 'Zoe' } });
    fireEvent.click(screen.getByTestId('name-voice-submit'));

    await waitFor(() => expect(onFiled).toHaveBeenCalledTimes(1));
    expect(onFiled.mock.calls[0][0]).toMatchObject({ claimedName: 'Zoe', status: 'unverified' });
    const post = calls.find((c) => c.init?.method === 'POST');
    expect(JSON.parse(post.init.body)).toMatchObject({
      voiceKey: 'livekit:abc',
      claimedName: 'Zoe',
      claimBy: 'luiz',
    });
    await waitFor(() =>
      expect(screen.getByTestId('name-voice-filed')).toHaveTextContent('(unverified)'),
    );
  });
});

describe('voiceFingerprintShortHash', () => {
  it('hashes an enrolled speaker cluster to a stable 6-hex fingerprint', () => {
    expect(voiceFingerprintShortHash('spk_07')).toBe('7e12e3');
    expect(voiceFingerprintShortHash('spk_07')).toBe(voiceFingerprintShortHash('spk_07'));
    expect(voiceFingerprintShortHash('  spk_07  ')).toBe('7e12e3');
  });

  it('distinguishes different voiceprints', () => {
    expect(voiceFingerprintShortHash('spk_08')).toBe('6f12cb');
    expect(voiceFingerprintShortHash('spk_08')).not.toBe(voiceFingerprintShortHash('spk_07'));
  });

  it('returns null for guests, blanks, and non-strings (guest-kind rule)', () => {
    expect(voiceFingerprintShortHash('guest')).toBeNull();
    expect(voiceFingerprintShortHash('Guest')).toBeNull();
    expect(voiceFingerprintShortHash('  GUEST  ')).toBeNull();
    expect(voiceFingerprintShortHash('')).toBeNull();
    expect(voiceFingerprintShortHash('   ')).toBeNull();
    expect(voiceFingerprintShortHash(null)).toBeNull();
    expect(voiceFingerprintShortHash(undefined)).toBeNull();
    expect(voiceFingerprintShortHash(42)).toBeNull();
  });
});

// ── Live-speaker flag (speaking indicator) ───────────────────────────────────

function ActiveProbe({ room }: { room: any }) {
  const { activeSpeakerIdentity } = useOwlSpeakerLabels(room);
  return <span data-testid="active">{activeSpeakerIdentity ?? 'none'}</span>;
}

describe('useOwlSpeakerLabels active speaker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function emitLabel(room: FakeRoom, label: any, publisherIdentity = 'owl-worker') {
    act(() => {
      room.emit('dataReceived', enc(label), { identity: publisherIdentity }, 0, OWL_SPEAKER_TOPIC);
    });
  }

  it('marks the labeled participant as the live speaker (newest wins)', () => {
    const room = new FakeRoom();
    render(<ActiveProbe room={room as any} />);
    expect(screen.getByTestId('active')).toHaveTextContent('none');

    emitLabel(room, { speaker: 'spk_07', stranger: true, participantIdentity: 'zoe-livekit-id' });
    expect(screen.getByTestId('active')).toHaveTextContent('zoe-livekit-id');

    emitLabel(room, { speaker: 'guest', participantIdentity: 'guest-9' });
    expect(screen.getByTestId('active')).toHaveTextContent('guest-9');
  });

  it('falls back to the publisher identity when the payload has none', () => {
    const room = new FakeRoom();
    render(<ActiveProbe room={room as any} />);
    emitLabel(room, { speaker: 'spk_07' }, 'zoe-livekit-id');
    expect(screen.getByTestId('active')).toHaveTextContent('zoe-livekit-id');
  });

  it('ignores other topics and malformed payloads', () => {
    const room = new FakeRoom();
    render(<ActiveProbe room={room as any} />);
    act(() => {
      room.emit('dataReceived', enc({ speaker: 'x' }), { identity: 'x' }, 0, 'chat-and-transcript');
      room.emit('dataReceived', new NodeTextEncoder().encode('not-json{{{'), { identity: 'x' }, 0, OWL_SPEAKER_TOPIC);
    });
    expect(screen.getByTestId('active')).toHaveTextContent('none');
  });

  it('clears the live speaker after the TTL so the indicator turns off', () => {
    const room = new FakeRoom();
    render(<ActiveProbe room={room as any} />);
    emitLabel(room, { speaker: 'spk_07', participantIdentity: 'zoe-livekit-id' });
    expect(screen.getByTestId('active')).toHaveTextContent('zoe-livekit-id');

    act(() => {
      jest.advanceTimersByTime(OWL_SPEAKING_TTL_MS - 1);
    });
    expect(screen.getByTestId('active')).toHaveTextContent('zoe-livekit-id');

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('active')).toHaveTextContent('none');
  });

  it('re-arms the TTL on each new label', () => {
    const room = new FakeRoom();
    render(<ActiveProbe room={room as any} />);
    emitLabel(room, { speaker: 'spk_07', participantIdentity: 'zoe-livekit-id' });
    act(() => {
      jest.advanceTimersByTime(OWL_SPEAKING_TTL_MS - 1);
    });
    emitLabel(room, { speaker: 'spk_07', participantIdentity: 'zoe-livekit-id' });
    act(() => {
      jest.advanceTimersByTime(OWL_SPEAKING_TTL_MS - 1);
    });
    expect(screen.getByTestId('active')).toHaveTextContent('zoe-livekit-id');
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('active')).toHaveTextContent('none');
  });
});
