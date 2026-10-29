/**
 * Coexistir single-room config (slice-1 feature 2: client direct join).
 *
 * Owner-approved slice-1 hardcode: the Coexistir avatar task-chatbot runs in
 * ONE LiveKit room named `coexistir`. Client code that needs the room uses
 * this constant instead of resolving a talkZoneId or consulting the zone
 * manifest. Transcript / translation / agent-tab work is parked for later
 * features — client join only.
 */

/** The single LiveKit room for Coexistir. Mirrors server COEXISTIR_ROOM. */
export const COEXISTIR_ROOM = 'coexistir' as const;

/** Display name for the single room. */
export const COEXISTIR_ZONE_NAME = 'Coexistir' as const;

/** True when a LiveKit room name is the Coexistir single room. */
export function isCoexistirRoom(roomName: unknown): boolean {
  return typeof roomName === 'string' && roomName.trim() === COEXISTIR_ROOM;
}

/** True when a pathname is the direct Coexistir entry (bypasses ZonePicker). */
export function isCoexistirPath(pathname: string): boolean {
  return pathname === '/coexistir' || pathname.startsWith('/coexistir/');
}

function readViteFlag(): string | undefined {
  try {
    // Guarded: import.meta is unavailable under jest without transform support.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = (Function('return import.meta?.env') as any)();
    return env?.VITE_COEXISTIR_MODE;
  } catch {
    return undefined;
  }
}

/**
 * True when the client runs in Coexistir direct-join mode: skip talkZoneId
 * resolution and zone filtering, join {@link COEXISTIR_ROOM} directly.
 * Active on `/coexistir*` routes or when VITE_COEXISTIR_MODE=1.
 */
export function isCoexistirMode(pathname?: string): boolean {
  if (readViteFlag() === '1') return true;
  const path =
    pathname ??
    (typeof window !== 'undefined' ? window.location.pathname : '');
  return isCoexistirPath(path);
}

export interface ChatZoneInputs {
  /** SharedLiveKitStore.coexistirMode — set once the direct join lands. */
  coexistirMode?: boolean;
  /** SharedLiveKitStore.currentZoneId — the LiveKit room name actually joined. */
  currentZoneId?: string | null;
  /** NetworkStore.talkZoneId — null in direct-join mode (no zone manifest). */
  talkZoneId?: string | null;
  /** Override for tests; defaults to window.location.pathname. */
  pathname?: string;
}

/**
 * Which id the sidebar chat should bind its zone conversation to.
 *
 * In Coexistir direct-join mode there is no talkZoneId — the LiveKit room IS
 * the zone — so chat must bind to {@link COEXISTIR_ROOM} instead of going
 * dead with a "Join a zone to chat" placeholder. Every other route keeps the
 * talkZoneId it always had.
 */
export function resolveChatZoneId(input: ChatZoneInputs = {}): string | null {
  if (
    input.coexistirMode ||
    isCoexistirRoom(input.currentZoneId) ||
    isCoexistirMode(input.pathname)
  ) {
    return COEXISTIR_ROOM;
  }
  const talkZoneId = typeof input.talkZoneId === 'string' ? input.talkZoneId.trim() : '';
  return talkZoneId !== '' ? talkZoneId : null;
}
