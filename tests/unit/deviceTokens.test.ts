import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const h = vi.hoisted(() => {
  const calls = {
    insertValues: vi.fn(),
    selectWhere: vi.fn(),
    updateSet: vi.fn(),
    updateWhere: vi.fn(),
  };
  // Rows the next select resolves to.
  const state = { selectRows: [] as unknown[] };
  const db = {
    insert: () => ({
      values: (vals: unknown) => {
        calls.insertValues(vals);
        return Promise.resolve();
      },
    }),
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          calls.selectWhere(cond);
          return { limit: () => Promise.resolve(state.selectRows) };
        },
      }),
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
  return { calls, state, db };
});

vi.mock('$lib/server/db', () => ({ db: h.db }));

import { mintDeviceToken, resolveDeviceToken, hashToken } from '$lib/server/deviceTokens';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

beforeEach(() => {
  vi.clearAllMocks();
  h.state.selectRows = [];
});

describe('mintDeviceToken', () => {
  it('returns an opaque token and stores only its hash', async () => {
    const token = await mintDeviceToken('user-1', 'iPhone');
    expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    expect(h.calls.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', label: 'iPhone', tokenHash: sha256(token) }),
    );
    // Plaintext never lands in the insert payload.
    const inserted = h.calls.insertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.values(inserted)).not.toContain(token);
  });

  it('mints unique tokens', async () => {
    const a = await mintDeviceToken('user-1');
    const b = await mintDeviceToken('user-1');
    expect(a).not.toBe(b);
  });
});

describe('resolveDeviceToken', () => {
  it('returns the userId for a known token and touches lastUsedAt', async () => {
    const token = await mintDeviceToken('user-1');
    h.state.selectRows = [{ id: 'dt-1', userId: 'user-1' }];
    const userId = await resolveDeviceToken(token);
    expect(userId).toBe('user-1');
    expect(h.calls.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ lastUsedAt: expect.any(Date) }),
    );
  });

  it('returns null for an unknown token', async () => {
    h.state.selectRows = [];
    expect(await resolveDeviceToken('nope-'.repeat(10))).toBeNull();
  });

  it('rejects obviously malformed tokens without a db roundtrip', async () => {
    expect(await resolveDeviceToken('')).toBeNull();
    expect(await resolveDeviceToken('short')).toBeNull();
    expect(h.calls.selectWhere).not.toHaveBeenCalled();
  });
});

describe('hashToken', () => {
  it('is sha256 hex', () => {
    expect(hashToken('abc')).toBe(sha256('abc'));
  });
});
