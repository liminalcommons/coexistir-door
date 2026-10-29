/**
 * Coexistir room chat over the LiveKit data channel.
 *
 * Direct-join rooms have no Colyseus session, so UnifiedChatStore's zone path
 * (which routes through the game server) is a dead end there: the owner saw
 * "Join a zone to chat" and no messages. The meeting view already carries chat
 * on the LiveKit `chat-and-transcript` topic (SharedLiveKitStore handles it
 * into `unifiedMessages`), so Coexistir chat reuses that exact transport —
 * broadcast to everyone in the room, no zone manifest, no game server.
 */
import type { UnifiedMessage } from '../types/messages';

/** Same topic MapChat/SharedLiveKitStore already use for room chat. */
export const ROOM_CHAT_TOPIC = 'chat-and-transcript';

export interface RoomChatRow {
  id: string;
  from: string;
  content: string;
  isLocal: boolean;
  timestamp: number;
}

/** Chat rows for display, oldest first. Transcript entries are dropped. */
export function toRoomChatRows(messages: UnifiedMessage[] | undefined | null): RoomChatRow[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m): m is UnifiedMessage => !!m && m.type === 'chat' && typeof m.message === 'string' && m.message.trim() !== '')
    .map((m) => {
      const ts = m.timestamp instanceof Date ? m.timestamp.getTime() : new Date(m.timestamp as unknown as string).getTime();
      return {
        id: String(m.id),
        from: m.senderName || 'Unknown',
        content: m.message,
        isLocal: !!m.isLocal,
        timestamp: Number.isFinite(ts) ? ts : 0,
      };
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

/** Build the payload published on the room chat topic. */
export function buildRoomChatMessage(args: {
  identity: string;
  name?: string | null;
  text: string;
  id?: string;
  now?: number;
}): UnifiedMessage {
  const now = args.now ?? Date.now();
  return {
    id: args.id ?? `${args.identity}_${now}_${Math.random().toString(36).slice(2, 7)}`,
    type: 'chat',
    senderName: args.name || args.identity,
    message: args.text.trim(),
    timestamp: new Date(now),
    isLocal: true,
    participantIdentity: args.identity,
  };
}

interface PublishableRoom {
  localParticipant?: {
    publishData?: (data: Uint8Array, options?: { reliable?: boolean; topic?: string }) => Promise<unknown> | unknown;
  } | null;
}

/** Publish a chat message to everyone in the LiveKit room. */
export async function publishRoomChat(room: PublishableRoom | null | undefined, message: UnifiedMessage): Promise<boolean> {
  const participant = room?.localParticipant;
  const publish = participant?.publishData;
  if (!participant || typeof publish !== 'function') return false;
  const data = new TextEncoder().encode(JSON.stringify(message));
  await publish.call(participant, data, { reliable: true, topic: ROOM_CHAT_TOPIC });
  return true;
}
