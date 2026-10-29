/**
 * Unit tests for the Coexistir single-room config (slice-1 feature 2).
 */
import {
  COEXISTIR_ROOM,
  COEXISTIR_ZONE_NAME,
  isCoexistirMode,
  isCoexistirPath,
  isCoexistirRoom,
  resolveChatZoneId,
} from '../coexistirConfig';

describe('coexistirConfig', () => {
  it('pins the single room to `coexistir`', () => {
    expect(COEXISTIR_ROOM).toBe('coexistir');
    expect(COEXISTIR_ZONE_NAME).toBe('Coexistir');
  });

  it('isCoexistirRoom matches only the single room (trimmed)', () => {
    expect(isCoexistirRoom('coexistir')).toBe(true);
    expect(isCoexistirRoom('  coexistir  ')).toBe(true);
    expect(isCoexistirRoom('Agora')).toBe(false);
    expect(isCoexistirRoom('')).toBe(false);
    expect(isCoexistirRoom(undefined)).toBe(false);
    expect(isCoexistirRoom(null)).toBe(false);
    expect(isCoexistirRoom(42)).toBe(false);
  });

  it('isCoexistirPath matches /coexistir and children only', () => {
    expect(isCoexistirPath('/coexistir')).toBe(true);
    expect(isCoexistirPath('/coexistir/')).toBe(true);
    expect(isCoexistirPath('/m/agora')).toBe(false);
    expect(isCoexistirPath('/')).toBe(false);
    expect(isCoexistirPath('/coexistirx')).toBe(false);
  });

  it('isCoexistirMode is true on /coexistir paths', () => {
    expect(isCoexistirMode('/coexistir')).toBe(true);
    expect(isCoexistirMode('/m/some-map')).toBe(false);
  });
});

describe('resolveChatZoneId', () => {
  it('binds room chat to COEXISTIR_ROOM when there is no talkZoneId', () => {
    // Direct join: LiveKit room is joined, talkZoneId never resolves.
    expect(
      resolveChatZoneId({ coexistirMode: true, currentZoneId: COEXISTIR_ROOM, talkZoneId: null }),
    ).toBe(COEXISTIR_ROOM);
    expect(
      resolveChatZoneId({ currentZoneId: COEXISTIR_ROOM, talkZoneId: null, pathname: '/coexistir' }),
    ).toBe(COEXISTIR_ROOM);
    expect(resolveChatZoneId({ pathname: '/coexistir' })).toBe(COEXISTIR_ROOM);
  });

  it('keeps the talkZoneId for normal zone rooms', () => {
    expect(
      resolveChatZoneId({ coexistirMode: false, currentZoneId: 'agora', talkZoneId: 'agora', pathname: '/m/x' }),
    ).toBe('agora');
    expect(resolveChatZoneId({ currentZoneId: null, talkZoneId: 'agora', pathname: '/m/x' })).toBe('agora');
  });

  it('returns null when no room is resolvable', () => {
    expect(resolveChatZoneId({ pathname: '/m/x' })).toBeNull();
    expect(resolveChatZoneId({ talkZoneId: '   ', pathname: '/m/x' })).toBeNull();
    expect(resolveChatZoneId({ talkZoneId: null, currentZoneId: null, pathname: '/m/x' })).toBeNull();
  });
});
