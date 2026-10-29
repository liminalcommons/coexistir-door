/**
 * claimDisplayName — slice-2 transcript attribution from voice name claims.
 *
 * Verified claims win over unverified ones; otherwise the latest claim is
 * returned with an `unverified` marker; a voice with no claims returns null
 * so callers keep the participant name.
 */

const findMock = jest.fn();
jest.mock('../../../database/weaverDb', () => ({
  getWeaverDb: jest.fn(async () => ({
    collection: () => ({ find: findMock }),
  })),
}));

import { resolveClaimDisplayName } from '../claimDisplayName';

function rows(rowsForQuery: unknown[]) {
  return {
    sort: () => ({
      limit: () => ({
        toArray: async () => rowsForQuery,
      }),
    }),
  };
}

describe('resolveClaimDisplayName', () => {
  beforeEach(() => {
    findMock.mockReset();
  });

  it('prefers a verified claim over the latest unverified one', async () => {
    findMock.mockImplementation((query: { status?: string }) =>
      query.status === 'verified'
        ? rows([{ voiceKey: 'owl:spk_07', claimedName: 'Rafa', status: 'verified' }])
        : rows([{ voiceKey: 'owl:spk_07', claimedName: 'Rafinha', status: 'unverified' }]),
    );

    await expect(resolveClaimDisplayName('owl:spk_07')).resolves.toEqual({
      name: 'Rafa',
      status: 'verified',
    });
    expect(findMock).toHaveBeenNthCalledWith(1, { voiceKey: 'owl:spk_07', status: 'verified' });
  });

  it('falls back to the latest unverified claim', async () => {
    findMock.mockImplementation((query: { status?: string }) =>
      query.status === 'verified' ? rows([]) : rows([{ claimedName: 'Rafinha' }]),
    );

    await expect(resolveClaimDisplayName('livekit:u:123')).resolves.toEqual({
      name: 'Rafinha',
      status: 'unverified',
    });
  });

  it('returns null for a voice with no claims', async () => {
    findMock.mockImplementation(() => rows([]));
    await expect(resolveClaimDisplayName('owl:spk_99')).resolves.toBeNull();
  });

  it('returns null for a blank voiceKey without touching the db', async () => {
    await expect(resolveClaimDisplayName('   ')).resolves.toBeNull();
    expect(findMock).not.toHaveBeenCalled();
  });

  it('ignores rows whose claimedName is not a string', async () => {
    findMock.mockImplementation((query: { status?: string }) =>
      query.status === 'verified' ? rows([{ claimedName: 42 }]) : rows([]),
    );
    await expect(resolveClaimDisplayName('owl:spk_01')).resolves.toBeNull();
  });
});
