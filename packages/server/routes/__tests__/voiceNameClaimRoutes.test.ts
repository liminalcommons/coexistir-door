/**
 * voiceNameClaimRoutes.test.ts — name-that-voice claim API.
 *
 * Pattern: mock getWeaverDb with an in-memory collection (no mongo needed),
 * mock auth middleware + steward check, mock the knowledge mirror.
 * Proves: validation, unverified-by-default filing, 2-match quorum flip,
 * villager confirm recording, steward-confirm verification.
 */

const store: any[] = [];

function makeCursor(docs: any[]) {
  return {
    sort: jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue(docs),
      limit: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue(docs) }),
    }),
    limit: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue(docs) }),
    toArray: jest.fn().mockResolvedValue(docs),
  };
}

const mockCollection = {
  find: jest.fn((query: any) => {
    const docs = store.filter((d) => {
      if (query.voiceKey && d.voiceKey !== query.voiceKey) return false;
      if (query.normalizedName && d.normalizedName !== query.normalizedName) return false;
      return true;
    });
    return makeCursor(docs);
  }),
  insertOne: jest.fn(async (doc: any) => {
    const saved = { ...doc, _id: `id-${store.length + 1}` };
    store.push(saved);
    return { insertedId: saved._id };
  }),
  updateMany: jest.fn(async (filter: any, update: any) => {
    let n = 0;
    for (const d of store) {
      if (filter.voiceKey && d.voiceKey !== filter.voiceKey) continue;
      if (filter.normalizedName && d.normalizedName !== filter.normalizedName) continue;
      if (filter.status && d.status !== filter.status) continue;
      if (filter._id?.$ne && d._id === filter._id.$ne) continue;
      Object.assign(d, update.$set);
      n++;
    }
    return { modifiedCount: n };
  }),
};

jest.mock('../../database/weaverDb', () => ({
  getWeaverDb: jest.fn().mockResolvedValue({
    collection: jest.fn().mockReturnValue(mockCollection),
  }),
}));

jest.mock('../../middleware/auth', () => ({
  isAuthenticated: (req: any, _res: any, next: any) => {
    req.userId = req.headers?.['x-test-user'] || 'villager-1';
    req.user = { _id: req.userId, displayName: req.headers?.['x-test-name'] || 'Villager One' };
    next();
  },
}));

jest.mock('../../modules/auth', () => ({
  requireStewardAuth: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../../modules/auth/steward', () => ({
  isStewardForUser: jest.fn().mockReturnValue(false),
}));

jest.mock('../../models/User', () => ({
  __esModule: true,
  default: {
    findById: jest.fn(() => ({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
    })),
  },
}));

const mockAddMemory = jest.fn().mockResolvedValue('episode-1');
jest.mock('../../modules/knowledge/defaultKnowledgePort', () => ({
  defaultKnowledgePort: jest.fn().mockReturnValue({ addMemory: mockAddMemory }),
}));

jest.mock('../../modules/auth/castaliaSession', () => ({
  readSession: jest.fn().mockResolvedValue(null),
}));

import { voiceNameClaimRouter } from '../voiceNameClaimRoutes';
import { isStewardForUser } from '../../modules/auth/steward';

function getRouteHandlers(method: string, path: string): ((...args: any[]) => any)[] {
  const stack = (voiceNameClaimRouter as any).stack;
  const layer = stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`route not found: ${method} ${path}`);
  return layer.route.stack.map((h: any) => h.handle);
}

function mockReq(overrides: Record<string, any> = {}): any {
  return { params: {}, query: {}, body: {}, headers: {}, ...overrides };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

async function runHandlers(handlers: ((...a: any[]) => any)[], req: any, res: any) {
  for (const h of handlers) {
    let nextCalled = false;
    await h(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
}

beforeEach(() => {
  store.length = 0;
  jest.clearAllMocks();
  (isStewardForUser as jest.Mock).mockReturnValue(false);
  const { readSession } = require('../../modules/auth/castaliaSession');
  (readSession as jest.Mock).mockResolvedValue(null);
  // Re-arm collection mocks cleared by clearAllMocks.
  const { getWeaverDb } = require('../../database/weaverDb');
  (getWeaverDb as jest.Mock).mockResolvedValue({ collection: () => mockCollection });
  mockCollection.find.mockImplementation((query: any) => {
    const docs = store.filter((d) => {
      if (query.voiceKey && d.voiceKey !== query.voiceKey) return false;
      if (query.normalizedName && d.normalizedName !== query.normalizedName) return false;
      return true;
    });
    return makeCursor(docs);
  });
  mockAddMemory.mockResolvedValue('episode-1');
});

describe('voiceNameClaimRoutes — registration', () => {
  it('registers POST /, GET /, POST /confirm, POST /steward-confirm', () => {
    expect(getRouteHandlers('post', '/').length).toBeGreaterThan(0);
    expect(getRouteHandlers('get', '/').length).toBeGreaterThan(0);
    expect(getRouteHandlers('post', '/confirm').length).toBeGreaterThan(0);
    expect(getRouteHandlers('post', '/steward-confirm').length).toBeGreaterThan(0);
  });
});

describe('POST / — file a claim', () => {
  it('400s without a voiceKey', async () => {
    const req = mockReq({ body: { claimedName: 'Zoe' } });
    const res = mockRes();
    await runHandlers(getRouteHandlers('post', '/'), req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('400s on a blank claimedName', async () => {
    const req = mockReq({ body: { voiceKey: 'livekit:abc', claimedName: '  ' } });
    const res = mockRes();
    await runHandlers(getRouteHandlers('post', '/'), req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('files a first claim as unverified and mirrors to the voice thread', async () => {
    const req = mockReq({
      body: { voiceKey: 'owl:spk_07', claimedName: 'Zoe', claimBy: 'luiz', livekitIdentity: 'abc' },
    });
    const res = mockRes();
    await runHandlers(getRouteHandlers('post', '/'), req, res);
    expect(res.status).toHaveBeenCalledWith(201);
    const saved = res.json.mock.calls[0][0].claim;
    expect(saved.status).toBe('unverified');
    expect(saved.normalizedName).toBe('zoe');
    expect(saved.claimBy).toBe('luiz');
    // Graphiti/Cortex mirror: person's thread group.
    expect(mockAddMemory).toHaveBeenCalledTimes(1);
    expect(mockAddMemory.mock.calls[0][0]).toBe('coexistir-owl-spk_07');
  });

  it('a second DISTINCT matching claim flips both rows to verified', async () => {
    for (const by of ['luiz', 'priya']) {
      const req = mockReq({
        body: { voiceKey: 'owl:spk_07', claimedName: 'Zoe', claimBy: by },
      });
      const res = mockRes();
      await runHandlers(getRouteHandlers('post', '/'), req, res);
    }
    const verified = store.filter((d) => d.status === 'verified');
    expect(verified.length).toBe(2);
    expect(verified[0].verifyReason).toBe('matching-claims');
  });

  it('same claimant twice stays unverified (guest-kind: no self-promotion)', async () => {
    for (let i = 0; i < 2; i++) {
      const req = mockReq({
        body: { voiceKey: 'owl:spk_07', claimedName: 'Zoe', claimBy: 'luiz' },
      });
      const res = mockRes();
      await runHandlers(getRouteHandlers('post', '/'), req, res);
    }
    expect(store.every((d) => d.status === 'unverified')).toBe(true);
  });

  it('a steward filing verifies on sight', async () => {
    (isStewardForUser as jest.Mock).mockReturnValue(true);
    const { readSession } = require('../../modules/auth/castaliaSession');
    (readSession as jest.Mock).mockResolvedValue({ sub: 'steward-user-id' });
    const User = require('../../models/User').default;
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: 'steward-user-id', displayName: 'Steward' }),
      }),
    });

    const req = mockReq({
      body: { voiceKey: 'owl:spk_07', claimedName: 'Zoe', claimBy: 'Steward' },
    });
    const res = mockRes();
    await runHandlers(getRouteHandlers('post', '/'), req, res);
    const saved = res.json.mock.calls[0][0].claim;
    expect(saved.status).toBe('verified');
    expect(saved.verifyReason).toBe('steward-confirm');
  });
});

describe('GET / — list claims', () => {
  it('400s without voiceKey and returns claims for a known voice', async () => {
    const bad = mockRes();
    await runHandlers(getRouteHandlers('get', '/'), mockReq({ query: {} }), bad);
    expect(bad.status).toHaveBeenCalledWith(400);

    store.push({
      _id: 'id-1', voiceKey: 'livekit:abc', claimedName: 'Zoe',
      normalizedName: 'zoe', claimBy: 'luiz', claimAt: new Date().toISOString(), status: 'unverified',
    });
    const res = mockRes();
    await runHandlers(getRouteHandlers('get', '/'), mockReq({ query: { voiceKey: 'livekit:abc' } }), res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ voiceKey: 'livekit:abc', claims: expect.any(Array) }),
    );
    expect(res.json.mock.calls[0][0].claims.length).toBe(1);
  });
});

describe('POST /confirm + /steward-confirm', () => {
  it('a villager confirm is recorded and can complete the quorum', async () => {
    store.push({
      _id: 'id-1', voiceKey: 'livekit:abc', claimedName: 'Zoe',
      normalizedName: 'zoe', claimBy: 'luiz', claimAt: new Date().toISOString(), status: 'unverified',
    });
    const req = mockReq({
      body: { voiceKey: 'livekit:abc', claimedName: 'Zoe' },
      headers: { 'x-test-user': 'priya', 'x-test-name': 'Priya' },
    });
    const res = mockRes();
    await runHandlers(getRouteHandlers('post', '/confirm'), req, res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ verified: true, reason: 'matching-claims' }),
    );
    expect(store.every((d) => d.status === 'verified')).toBe(true);
  });

  it('steward-confirm verifies all matching claims', async () => {
    store.push({
      _id: 'id-1', voiceKey: 'livekit:abc', claimedName: 'Zoe',
      normalizedName: 'zoe', claimBy: 'luiz', claimAt: new Date().toISOString(), status: 'unverified',
    });
    const req = mockReq({ body: { voiceKey: 'livekit:abc', claimedName: 'Zoe' } });
    const res = mockRes();
    await runHandlers(getRouteHandlers('post', '/steward-confirm'), req, res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ verified: true, reason: 'steward-confirm' }),
    );
    expect(store[0].status).toBe('verified');
  });
});
