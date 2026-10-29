/**
 * Tests for Coexistir room chat over the LiveKit data channel.
 */
import type { UnifiedMessage } from '../../types/messages';
// jsdom does not expose TextEncoder/TextDecoder globals; browsers do.
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';
(globalThis as any).TextEncoder ??= NodeTextEncoder;
(globalThis as any).TextDecoder ??= NodeTextDecoder;
import {
  ROOM_CHAT_TOPIC,
  toRoomChatRows,
  buildRoomChatMessage,
  publishRoomChat,
} from '../roomChat';

const chat = (over: Partial<UnifiedMessage> = {}): UnifiedMessage => ({
  id: 'm1',
  type: 'chat',
  senderName: 'Rafa',
  message: 'bom dia',
  timestamp: new Date('2026-10-26T12:00:00Z'),
  isLocal: false,
  ...over,
});

describe('toRoomChatRows', () => {
  it('keeps chat rows, drops transcripts and blanks', () => {
    const rows = toRoomChatRows([
      chat({ id: 'a', message: 'first' }),
      chat({ id: 'b', type: 'transcript', message: 'spoken words' }),
      chat({ id: 'c', message: '   ' }),
      chat({ id: 'd', message: 'second' }),
    ]);
    expect(rows.map((r) => r.content)).toEqual(['first', 'second']);
    expect(rows.every((r) => r.from === 'Rafa')).toBe(true);
  });

  it('sorts oldest first and normalises timestamps', () => {
    const rows = toRoomChatRows([
      chat({ id: 'late', message: 'late', timestamp: new Date('2026-10-26T12:05:00Z') }),
      chat({ id: 'early', message: 'early', timestamp: new Date('2026-10-26T12:01:00Z') }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['early', 'late']);
    expect(rows[0].timestamp).toBeLessThan(rows[1].timestamp);
  });

  it('tolerates missing input', () => {
    expect(toRoomChatRows(undefined)).toEqual([]);
    expect(toRoomChatRows(null)).toEqual([]);
  });
});

describe('buildRoomChatMessage', () => {
  it('builds a chat payload from the local participant', () => {
    const msg = buildRoomChatMessage({ identity: 'id-1', name: 'Rafa', text: '  oi  ', now: 1000, id: 'x1' });
    expect(msg).toMatchObject({
      id: 'x1',
      type: 'chat',
      senderName: 'Rafa',
      message: 'oi',
      isLocal: true,
      participantIdentity: 'id-1',
    });
    expect(msg.timestamp.getTime()).toBe(1000);
  });

  it('falls back to identity when no display name is set', () => {
    expect(buildRoomChatMessage({ identity: 'id-2', name: null, text: 'hey' }).senderName).toBe('id-2');
  });
});

describe('publishRoomChat', () => {
  it('publishes JSON on the room chat topic, reliably', async () => {
    const publishData = jest.fn();
    const room = { localParticipant: { publishData } };
    const msg = buildRoomChatMessage({ identity: 'id-1', name: 'Rafa', text: 'oi', id: 'x1', now: 1 });

    await expect(publishRoomChat(room, msg)).resolves.toBe(true);

    expect(publishData).toHaveBeenCalledTimes(1);
    const [payload, options] = publishData.mock.calls[0];
    expect(options).toEqual({ reliable: true, topic: ROOM_CHAT_TOPIC });
    expect(JSON.parse(new TextDecoder().decode(payload))).toMatchObject({ id: 'x1', message: 'oi' });
  });

  it('returns false instead of throwing when the room is gone', async () => {
    await expect(publishRoomChat(null, chat())).resolves.toBe(false);
    await expect(publishRoomChat({ localParticipant: null }, chat())).resolves.toBe(false);
  });
});
