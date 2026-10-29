/**
 * voiceIdentity — the claim snapshot the turn rows record.
 *
 * The point of these specs: the bridge must never claim more than it knows.
 *   - a verified claim is reported as verified, with the name;
 *   - an unverified claim keeps the name but says unverified;
 *   - no rows → claim 'none' and name null (NOT a fabricated name);
 *   - a store failure → state 'error' with the reason, never 'none';
 *   - a cold cache → state 'pending' ("I have not looked yet"), which the panel
 *     renders differently from "there is no claim";
 *   - `biometric` is always false and `confidence` always null.
 */

import { __resetIdentityCache, ensureIdentity, peekIdentity, readIdentity, refreshIdentity } from '../voiceIdentity';

const findMock = jest.fn();
const collectionMock = jest.fn(() => ({ find: findMock }));
const getWeaverDbMock = jest.fn(async () => ({ collection: collectionMock }));

jest.mock('../../../database/weaverDb', () => ({
  getWeaverDb: () => getWeaverDbMock(),
}));

function rowsQuery(rows: Array<Record<string, unknown>>) {
  return {
    sort: () => ({
      toArray: async () => rows,
    }),
  };
}

beforeEach(() => {
  __resetIdentityCache();
  findMock.mockReset();
  getWeaverDbMock.mockClear();
  collectionMock.mockClear();
});

describe('readIdentity', () => {
  it('reports a verified claim with its name, counts and the honest gaps', async () => {
    findMock.mockReturnValue(
      rowsQuery([
        { voiceKey: 'owl:spk_07', claimedName: 'Ana', status: 'verified', claimAt: '2026-10-27T10:00:00Z' },
        { voiceKey: 'owl:spk_07', claimedName: 'Ana', status: 'unverified', claimAt: '2026-10-26T10:00:00Z' },
      ]),
    );
    const identity = await readIdentity('owl:spk_07');
    expect(identity).toMatchObject({
      voiceKey: 'owl:spk_07',
      name: 'Ana',
      claim: 'verified',
      claims: 2,
      verified: 1,
      biometric: false,
      confidence: null,
      source: 'voiceKey+name-claims',
      state: 'resolved',
    });
    expect(typeof identity.resolvedAt).toBe('string');
  });

  it('keeps an unverified name but labels the claim state', async () => {
    findMock.mockReturnValue(
      rowsQuery([{ claimedName: 'Rui', status: 'unverified', claimAt: '2026-10-27T10:00:00Z' }]),
    );
    const identity = await readIdentity('livekit:abc');
    expect(identity.name).toBe('Rui');
    expect(identity.claim).toBe('unverified');
    expect(identity.claims).toBe(1);
    expect(identity.verified).toBe(0);
  });

  it('says "none" (not a name) when no claim exists', async () => {
    findMock.mockReturnValue(rowsQuery([]));
    const identity = await readIdentity('owl:front-door');
    expect(identity.name).toBeNull();
    expect(identity.claim).toBe('none');
    expect(identity.state).toBe('resolved');
  });

  it('surfaces a store failure as an error, not as "no claim"', async () => {
    getWeaverDbMock.mockRejectedValueOnce(new Error('mongo down'));
    const identity = await readIdentity('owl:front-door');
    expect(identity.state).toBe('error');
    expect(identity.error).toContain('mongo down');
    expect(identity.name).toBeNull();
  });

  it('rejects an empty voiceKey without touching the store', async () => {
    const identity = await readIdentity('   ');
    expect(identity.state).toBe('error');
    expect(identity.voiceKey).toBe('');
    expect(getWeaverDbMock).not.toHaveBeenCalled();
  });
});

describe('the cache', () => {
  it('is pending until something reads it, then serves the snapshot', async () => {
    expect(peekIdentity('owl:spk_07').state).toBe('pending');
    findMock.mockReturnValue(
      rowsQuery([{ claimedName: 'Ana', status: 'verified', claimAt: '2026-10-27T10:00:00Z' }]),
    );
    await refreshIdentity('owl:spk_07');
    expect(peekIdentity('owl:spk_07')).toMatchObject({ name: 'Ana', state: 'resolved' });
  });

  it('single-flights concurrent refreshes for one key', async () => {
    let resolveRows: (rows: Array<Record<string, unknown>>) => void = () => undefined;
    findMock.mockReturnValue({
      sort: () => ({
        toArray: () =>
          new Promise<Array<Record<string, unknown>>>((resolve) => {
            resolveRows = resolve;
          }),
      }),
    });
    const a = refreshIdentity('owl:spk_09');
    const b = refreshIdentity('owl:spk_09');
    // Let the (single) read reach `toArray` before resolving it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    resolveRows([]);
    await Promise.all([a, b]);
    expect(findMock).toHaveBeenCalledTimes(1);
  });

  it('ensureIdentity waits for a real read (the panel/health path)', async () => {
    findMock.mockReturnValue(rowsQuery([]));
    const identity = await ensureIdentity('owl:front-door');
    expect(identity.state).toBe('resolved');
    expect(identity.claim).toBe('none');
  });
});
