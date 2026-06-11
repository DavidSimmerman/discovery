import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const calls = {
    insertValues: vi.fn(),
    updateSet: vi.fn(),
    updateWhere: vi.fn(),
  };
  const db = {
    insert: () => ({
      values: (vals: unknown) => {
        calls.insertValues(vals);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (vals: unknown) => {
        calls.updateSet(vals);
        return {
          where: (cond: unknown) => {
            calls.updateWhere(cond);
            return Promise.resolve();
          },
        };
      },
    }),
  };
  return { calls, db };
});

vi.mock('$lib/server/db', () => ({ db: h.db }));
vi.mock('$lib/server/db/schema', () => ({
  liveActivities: { userId: 'user_id', endedAt: 'ended_at' },
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  isNull: vi.fn((a: unknown) => ({ isNull: a })),
}));

import { POST, DELETE } from '../../src/routes/api/ios/activity/+server';

function event(opts: { user?: { id: string }; body?: unknown }) {
  return {
    locals: { user: opts.user ?? null },
    request: { json: async () => opts.body ?? {} },
  } as never;
}

beforeEach(() => vi.clearAllMocks());

describe('POST /api/ios/activity', () => {
  it('401s when unauthenticated', async () => {
    await expect(POST(event({ body: { apnsPushToken: 'tok' } }))).rejects.toMatchObject({
      status: 401,
    });
  });

  it('400s without an apnsPushToken', async () => {
    await expect(POST(event({ user: { id: 'user-1' }, body: {} }))).rejects.toMatchObject({
      status: 400,
    });
  });

  it('ends any prior active activity, then inserts the new one', async () => {
    const res = await POST(
      event({ user: { id: 'user-1' }, body: { apnsPushToken: 'apns-tok-1' } }),
    );
    expect(res.status).toBe(200);
    // Prior active rows closed out first (unique partial index allows one active).
    expect(h.calls.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ endedAt: expect.any(Date) }),
    );
    expect(h.calls.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', apnsPushToken: 'apns-tok-1' }),
    );
  });
});

describe('DELETE /api/ios/activity', () => {
  it('401s when unauthenticated', async () => {
    await expect(DELETE(event({}))).rejects.toMatchObject({ status: 401 });
  });

  it('marks the active activity ended', async () => {
    const res = await DELETE(event({ user: { id: 'user-1' } }));
    expect(res.status).toBe(200);
    expect(h.calls.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ endedAt: expect.any(Date) }),
    );
    expect(h.calls.insertValues).not.toHaveBeenCalled();
  });
});
